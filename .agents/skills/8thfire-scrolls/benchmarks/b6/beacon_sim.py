#!/usr/bin/env python3
"""B-6 signed-beacon provenance benchmark under realistic loss.

Five scenario suites over the beacon_chunk primitives (digest 04 design,
research/09 §B-6 metrics):

  1. clean   — N-chunk manifest, both bearers, end-to-end time, store verify
  2. uniform — single-chunk loss, gap detection + store-fallback reassembly
  3. burst   — k-consecutive-chunk loss (k in {2,4,8}), same metrics
  4. tamper  — one-byte fragment injection, local hash-pointer detection,
               false-positive rate on clean chunks
  5. replay  — stale-epoch chunk set vs rolling epoch window

Run:
  uv run --with 'cryptography>=46' python benchmarks/b6/beacon_sim.py \
      [--seed b6] [--trials 1]

Deterministic: the default content seed is "b6" (SHA3-256-derived); signing
seed is AINISHCODER_SCROLL_SIGN_SEED when set, else the documented benchmark
default. Results JSON is written to benchmarks/b6/results.json.
"""

from __future__ import annotations

import argparse
import json
import random
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import beacon_chunk as bc

RESULTS_PATH = Path(__file__).resolve().parent / "results.json"
CHUNK_COUNTS = (4, 8, 16, 32)
BURST_SIZES = (2, 4, 8)


def build_stream(
    chunk_count: int,
    mode: bc.Mode,
    epoch: int,
    seed: bytes,
    pub_bytes: bytes,
    signing_seed: bytes,
) -> tuple[bc.Manifest, list[bc.Chunk], bytes, bc.Store]:
    """Manifest + chunks + content + published store for one trial stream."""
    content = content_for(chunk_count, mode, seed)
    manifest = bc.make_manifest(content, epoch, mode, seed=signing_seed)
    chunks = bc.chunkify(manifest, content, mode)
    store = bc.Store(pub_bytes)
    store.publish(manifest, content)
    return manifest, chunks, content, store


def content_seed(seed_str: str) -> bytes:
    return bc.sha3(seed_str.encode())


def content_for(chunk_count: int, mode: bc.Mode, seed: bytes) -> bytes:
    """Content sized to exactly chunk_count fragments (last one partial)."""
    frag = bc.fragment_payload_len(mode)
    length = frag * chunk_count - max(1, frag // 4)
    return bc.make_content(seed, length)


# ---------------------------------------------------------------- suites


def scenario_clean(
    pub_bytes: bytes, seed: bytes, signing_seed: bytes, repeats: int
) -> dict:
    """Suite 1: clean channel — reassembly + store verify + end-to-end time."""
    rows = []
    for mode in ("ble", "lora"):
        for n in CHUNK_COUNTS:
            times: list[float] = []
            ok = 0
            verified = 0
            for _ in range(repeats):
                _, chunks, content, store = build_stream(
                    n, mode, 1, seed, pub_bytes, signing_seed
                )
                state = bc.ReceiverState()
                t0 = time.perf_counter()
                enc = [c.encode() for c in chunks]
                dec = [bc.Chunk.decode(e) for e in enc]
                r = bc.reassemble(dec, store=store, state=state)
                dt = time.perf_counter() - t0
                times.append(dt)
                if r.ok and r.content == content:
                    ok += 1
                if r.store_verified:
                    verified += 1
            rows.append(
                {
                    "mode": mode,
                    "chunks": n,
                    "trials": repeats,
                    "reassembly_success": ok / repeats,
                    "store_verify_success": verified / repeats,
                    "e2e_ms_median": statistics.median(times) * 1000,
                    "e2e_ms_p95": sorted(times)[int(0.95 * (len(times) - 1))] * 1000,
                    "pass": ok == repeats and verified == repeats,
                }
            )
    return {
        "suite": "clean_channel",
        "rows": rows,
        "pass": all(r["pass"] for r in rows),
    }


def scenario_uniform_loss(
    pub_bytes: bytes,
    seed: bytes,
    signing_seed: bytes,
    mode: bc.Mode,
    chunk_count: int,
    repeats: int,
) -> dict:
    """Suite 2: drop each single chunk in turn; gap detect + store fallback."""
    _, chunks, _, store = build_stream(
        chunk_count, mode, 1, seed, pub_bytes, signing_seed
    )
    total = len(chunks)
    detected = 0
    fallback_ok = 0
    for rep in range(repeats):
        for drop in range(total):
            rng = random.Random((rep, drop, seed))  # nosec B311 - seeded test RNG for channel simulation, not security
            injured = [c for c in chunks if c.seq != drop]
            # scramble delivery order like a real channel
            rng.shuffle(injured)
            r = bc.reassemble(injured, store=store, state=bc.ReceiverState())
            if r.gaps == [drop]:
                detected += 1
            if r.ok and r.store_used and r.store_verified:
                fallback_ok += 1
    trials = repeats * total
    return {
        "suite": "uniform_loss",
        "mode": mode,
        "chunks": chunk_count,
        "trials": trials,
        "gap_detection_rate": detected / trials,
        "store_fallback_success": fallback_ok / trials,
        "pass": detected == trials and fallback_ok == trials,
    }


def scenario_burst_loss(
    pub_bytes: bytes,
    seed: bytes,
    signing_seed: bytes,
    mode: bc.Mode,
    chunk_count: int,
    repeats: int,
) -> dict:
    """Suite 3: drop k consecutive chunks; gap detect + store fallback."""
    rows = []
    all_pass = True
    for k in BURST_SIZES:
        _, chunks, _, store = build_stream(
            chunk_count, mode, 1, seed, pub_bytes, signing_seed
        )
        total = len(chunks)
        if k >= total:
            continue
        detected = 0
        fallback_ok = 0
        trials = 0
        for rep in range(repeats):
            for start in range(total - k + 1):
                drop = set(range(start, start + k))
                rng = random.Random((rep, start, k, seed))  # nosec B311 - seeded test RNG for channel simulation, not security
                injured = [c for c in chunks if c.seq not in drop]
                rng.shuffle(injured)
                trials += 1
                r = bc.reassemble(injured, store=store, state=bc.ReceiverState())
                if r.gaps == sorted(drop):
                    detected += 1
                if r.ok and r.store_used and r.store_verified:
                    fallback_ok += 1
        row = {
            "mode": mode,
            "chunks": chunk_count,
            "burst_k": k,
            "trials": trials,
            "gap_detection_rate": detected / trials,
            "store_fallback_success": fallback_ok / trials,
            "pass": detected == trials and fallback_ok == trials,
        }
        all_pass = all_pass and row["pass"]
        rows.append(row)
    return {"suite": "burst_loss", "rows": rows, "pass": all_pass}


def scenario_tamper(
    pub_bytes: bytes,
    seed: bytes,
    signing_seed: bytes,
    mode: bc.Mode,
    chunk_count: int,
    repeats: int,
) -> dict:
    """Suite 4: flip one fragment byte; local truncated-hash must catch it."""
    _, chunks, _, store = build_stream(
        chunk_count, mode, 1, seed, pub_bytes, signing_seed
    )
    total = len(chunks)
    detected = 0
    trials = 0
    for rep in range(repeats):
        for target in range(total):
            rng = random.Random((rep, target, "tamper", seed))  # nosec B311 - seeded test RNG for tamper simulation, not security
            pos = rng.randrange(len(chunks[target].fragment))
            injured = []
            for c in chunks:
                if c.seq == target:
                    f = bytearray(c.fragment)
                    f[pos] ^= 1 << rng.randrange(8)
                    c = bc.Chunk(
                        c.version, c.epoch, c.seq, c.total, c.content_hash8, bytes(f)
                    )
                injured.append(c)
            trials += 1
            r = bc.reassemble(injured, store=store, state=bc.ReceiverState())
            if not r.ok and r.tampered_seqs == [target]:
                detected += 1
    # false positives: identical clean stream must never flag any chunk
    fp = 0
    for _ in range(repeats):
        r = bc.reassemble(chunks, store=store, state=bc.ReceiverState())
        if r.ok and r.tampered_seqs:
            fp += 1
    return {
        "suite": "injection_tamper",
        "mode": mode,
        "chunks": chunk_count,
        "trials": trials,
        "tamper_detection_rate": detected / trials,
        "false_positive_rate": fp / repeats,
        "pass": detected == trials and fp == 0,
    }


def scenario_replay(
    pub_bytes: bytes,
    seed: bytes,
    signing_seed: bytes,
    mode: bc.Mode,
    chunk_count: int,
    repeats: int,
) -> dict:
    """Suite 5: re-deliver an old epoch's chunk set after a newer epoch."""
    fresh_epoch = 100
    stale_epoch = fresh_epoch - bc.EPOCH_WINDOW - 1  # strictly outside window
    accepted = 0
    trials = 0
    for rep in range(repeats):
        _, fresh, _, store = build_stream(
            chunk_count, mode, fresh_epoch, seed, pub_bytes, signing_seed
        )
        _, stale, _, _ = build_stream(
            chunk_count, mode, stale_epoch, seed, pub_bytes, signing_seed
        )
        state = bc.ReceiverState()
        # receiver first hears the fresh beacon...
        r1 = bc.reassemble(fresh, store=store, state=state)
        if not r1.ok:
            continue
        trials += 1
        # ...then an adversary replays the stale epoch's whole chunk set
        r2 = bc.reassemble(stale, store=store, state=state)
        if r2.ok or not r2.replay_rejected:
            accepted += 1
    rate = accepted / trials if trials else 0.0
    return {
        "suite": "replay",
        "mode": mode,
        "chunks": chunk_count,
        "trials": trials,
        "replay_acceptance_rate": rate,
        "pass": trials > 0 and accepted == 0,
    }


# ---------------------------------------------------------------- output


def metrics_table(scenarios: list[dict]) -> str:
    """Render the headline metrics as a markdown table."""
    lines = [
        "| Suite | Mode | Chunks | Trials | Metric | Value | Pass |",
        "|---|---|---|---|---|---|---|",
    ]
    for sc in scenarios:
        if sc["suite"] == "clean_channel":
            for r in sc["rows"]:
                lines.append(
                    f"| {sc['suite']} | {r['mode']} | {r['chunks']} | {r['trials']} "
                    f"| reassembly/store-verify | {r['reassembly_success']:.0%}/"
                    f"{r['store_verify_success']:.0%} "
                    f"({r['e2e_ms_median']:.2f} ms med) | {'PASS' if r['pass'] else 'FAIL'} |"
                )
        elif "rows" in sc:
            for r in sc["rows"]:
                det = r["gap_detection_rate"]
                fb = r["store_fallback_success"]
                lines.append(
                    f"| {sc['suite']} (k={r['burst_k']}) | {r['mode']} | {r['chunks']} "
                    f"| {r['trials']} | gap-detect/store-fallback | {det:.0%}/{fb:.0%} "
                    f"| {'PASS' if r['pass'] else 'FAIL'} |"
                )
        else:
            metric = next(
                k for k in sc if k.endswith("_rate") and k != "false_positive_rate"
            )
            lines.append(
                f"| {sc['suite']} | {sc['mode']} | {sc['chunks']} | {sc['trials']} "
                f"| {metric} | {sc[metric]:.0%} | {'PASS' if sc['pass'] else 'FAIL'} |"
            )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--seed", default="b6", help="content seed string (default: b6)"
    )
    parser.add_argument("--trials", type=int, default=1, help="repetitions per suite")
    args = parser.parse_args()

    seed = content_seed(args.seed)
    signing_seed = bc.seed_from_env()
    from cryptography.hazmat.primitives.asymmetric import mldsa

    pub_bytes = (
        mldsa.MLDSA65PrivateKey.from_seed_bytes(signing_seed)
        .public_key()
        .public_bytes_raw()
    )

    print("== B-6 signed-beacon benchmark ==")
    print(f"content seed: {args.seed!r}  signing seed: env or benchmark default")
    print(
        f"engine: BLE {bc.BUDGET['ble']}B / LoRa {bc.BUDGET['lora']}B budget, "
        f"header {bc.HEADER_LEN}B, hash truncation {bc.HASH_LEN}B, "
        f"epoch window {bc.EPOCH_WINDOW}"
    )

    t0 = time.perf_counter()
    scenarios = [
        scenario_clean(pub_bytes, seed, signing_seed, repeats=max(args.trials, 3)),
        scenario_uniform_loss(
            pub_bytes, seed, signing_seed, "ble", 8, repeats=args.trials
        ),
        scenario_burst_loss(
            pub_bytes, seed, signing_seed, "ble", 8, repeats=args.trials
        ),
        scenario_tamper(pub_bytes, seed, signing_seed, "ble", 8, repeats=args.trials),
        scenario_replay(
            pub_bytes, seed, signing_seed, "ble", 8, repeats=max(args.trials, 1)
        ),
    ]
    elapsed = time.perf_counter() - t0

    all_pass = all(sc["pass"] for sc in scenarios)
    table = metrics_table(scenarios)
    print(table)

    results = {
        "benchmark": "B-6 signed-beacon provenance under realistic loss",
        "run_timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "seed": args.seed,
        "all_pass": all_pass,
        "wall_seconds": round(elapsed, 3),
        "engine_params": {
            "chunk_budget_bytes": bc.BUDGET,
            "header_len_bytes": bc.HEADER_LEN,
            "hash_truncation_bytes": bc.HASH_LEN,
            "hash": "SHA3-256",
            "signature": "ML-DSA-65 (full signature verified at durable store only)",
            "epoch_window": bc.EPOCH_WINDOW,
            "mldsa_seed_env": bc.MLDSA65_SEED_ENV,
        },
        "scenarios": scenarios,
    }
    RESULTS_PATH.write_text(json.dumps(results, indent=2) + "\n")
    print(f"results written to {RESULTS_PATH} ({elapsed:.1f}s)")
    print("OVERALL: " + ("PASS" if all_pass else "FAIL"))
    return 0 if all_pass else 1


if __name__ == "__main__":
    sys.exit(main())
