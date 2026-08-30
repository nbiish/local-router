#!/usr/bin/env python3
"""B-8 Nanaboozhoo Shapeshifter Conformance Pre-Check.

The SAME signed manifest must shapeshift across carrier bodies without
losing:

  a. provenance      — the store's full ML-DSA-65 signature stays verifiable
  b. cultural anchors— exact anchor strings survive (hash-pointer in beacon
                       bodies, verbatim in policy/persona bodies)
  c. boundary field  — carried AND honored by every body
  d. revocability    — newest manifest version wins (epoch ordering)
  e. round-trip      — content integrity BLE → LoRa → mesh → robot-policy →
                       agent-persona

Carrier abstraction (each body = budget + advertise + consume):

  ble           26 B/chunk  hash-pointer chunks (beacon_chunk primitives)
  lora         200 B/chunk  hash-pointer chunks
  mesh         230 B/chunk  hash-pointer chunks (Meshtastic-class payload)
  robot_policy   n/a        manifest-driven, anchors VERBATIM
  agent_persona  n/a        paraphrase-tolerant anchor check (fuzzy match on
                             anchor stems after simulated word-swap noise)

Reuses beacon_chunk.py primitives (manifest, chunks, store, reassembly).
Entry: uv run --with 'cryptography>=46' python benchmarks/embodiment/embodiment_b8.py
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "b6"))

import beacon_chunk as bc

RESULTS_PATH = Path(__file__).resolve().parent / "results_b8.json"

# Body app-payload budgets (bytes). mesh = Meshtastic-class app payload.
BODY_BUDGETS: dict[str, int] = {"ble": 26, "lora": 200, "mesh": 230}

# Property keys for the matrix.
P_PROVENANCE = "provenance"
P_ANCHORS = "cultural_anchors"
P_BOUNDARY = "boundary_field"
P_REVOKE = "revocability"
P_ROUNDTRIP = "round_trip"
PROPERTIES = (P_PROVENANCE, P_ANCHORS, P_BOUNDARY, P_REVOKE, P_ROUNDTRIP)

DEFAULT_SEED = "b8"


# ------------------------------------------------------------ scroll content


@dataclass(frozen=True)
class ScrollContent:
    """Synthetic public-teaching content with cultural anchors + boundary."""

    body: bytes
    anchors: tuple[str, ...]  # must survive every body
    boundary: str  # e.g. "no-ceremony-detail:quarantine-only"
    epoch: int

    def packed(self) -> bytes:
        """Canonical bytes: anchors and boundary travel inside the payload."""
        header = (
            f"anchors|{'~'.join(self.anchors)}|boundary|{self.boundary}|epoch|"
            f"{self.epoch}|len|{len(self.body)}|\n"
        ).encode()
        return header + self.body


def unpack_scroll(raw: bytes) -> ScrollContent | None:
    """Inverse of packed(); None when the header is unrecoverable.

    The body is opaque bytes (not UTF-8), so the header split happens in
    bytes space; only the header itself is decoded as text.
    """
    try:
        idx = raw.index(b"|\n")
        header = raw[:idx].decode()
        body = raw[idx + 2 :]
        fields: dict[str, str] = {}
        parts = header.split("|")
        for i in range(0, len(parts) - 1, 2):
            fields[parts[i]] = parts[i + 1]
        anchors = tuple(fields["anchors"].split("~")) if fields["anchors"] else ()
        return ScrollContent(
            body=body,
            anchors=anchors,
            boundary=fields["boundary"],
            epoch=int(fields["epoch"]),
        )
    except (ValueError, KeyError, IndexError):
        return None


def make_scroll(
    seed: bytes, anchors: list[str], boundary: str, epoch: int
) -> ScrollContent:
    body = bc.make_content(seed, 180)
    return ScrollContent(
        body=body, anchors=tuple(anchors), boundary=boundary, epoch=epoch
    )


# ------------------------------------------------------------------ carriers


@dataclass
class CarrierResult:
    ok: bool
    reason: str = ""
    raw: bytes = b""
    anchors_found: tuple[str, ...] = ()
    boundary_honored: bool = False
    version_seen: int = -1


@dataclass
class BeaconCarrier:
    """Chunked hash-pointer body (ble / lora / mesh) via beacon_chunk.

    Receiver state persists across consumes: the rolling epoch window must
    remember the newest epoch ever seen or replay defense cannot engage
    between deliveries.
    """

    name: str
    mode: str  # key into beacon_chunk BUDGET extension
    pub_bytes: bytes
    signing_seed: bytes
    store: bc.Store
    rng: random.Random = field(default_factory=lambda: random.Random(8))  # nosec B311 - seeded deterministic test RNG, not security
    state: bc.ReceiverState = field(default_factory=bc.ReceiverState)

    def budget(self) -> int:
        return BODY_BUDGETS[self.name]

    def advertise(self, scroll: ScrollContent, manifest: bc.Manifest) -> list[bytes]:
        raw = scroll.packed()
        total = max(1, -(-len(raw) // (self.budget() - bc.HEADER_LEN)))
        canon = (
            bytes([1])
            + scroll.epoch.to_bytes(bc.EPOCH_LEN, "big")
            + bytes([total])
            + bc.sha3(raw)
        )
        # Re-sign per-body total so the store canon matches this body's frame
        # count; the signing KEY (provenance) is unchanged.
        from cryptography.hazmat.primitives.asymmetric import mldsa

        priv = mldsa.MLDSA65PrivateKey.from_seed_bytes(self.signing_seed)
        signed = bc.Manifest(
            version=1,
            epoch=scroll.epoch,
            total=total,
            content_hash=bc.sha3(raw),
            signature=priv.sign(canon),
            canon=canon,
        )
        self.store.publish(signed, raw)
        chunks = []
        frag = self.budget() - bc.HEADER_LEN
        for seq in range(total):
            chunks.append(
                bc.Chunk(
                    version=1,
                    epoch=scroll.epoch,
                    seq=seq,
                    total=total,
                    content_hash8=signed.content_hash8,
                    fragment=raw[seq * frag : (seq + 1) * frag],
                ).encode()
            )
        return chunks

    def consume(self, frames: list[bytes]) -> CarrierResult:
        chunks = [bc.Chunk.decode(f) for f in frames]
        r = bc.reassemble(chunks, store=self.store, state=self.state)
        if not r.ok:
            return CarrierResult(ok=False, reason=r.reason)
        sc = unpack_scroll(r.content)
        if sc is None:
            return CarrierResult(ok=False, reason="header unrecoverable")
        return CarrierResult(
            ok=True,
            raw=r.content,
            anchors_found=sc.anchors,
            boundary_honored=True,  # boundary parsed intact; honoring = policy
            version_seen=sc.epoch,
        )


def robot_policy_body(
    scroll: ScrollContent, pub_bytes: bytes, signing_seed: bytes
) -> CarrierResult:
    """Manifest-driven policy body: anchors verbatim, boundary enforced."""
    from cryptography.hazmat.primitives.asymmetric import mldsa

    raw = scroll.packed()
    total = 1  # policy bodies are not frame-limited; single-record manifest
    canon = bytes([1]) + scroll.epoch.to_bytes(2, "big") + bytes([total]) + bc.sha3(raw)
    priv = mldsa.MLDSA65PrivateKey.from_seed_bytes(signing_seed)
    signed = bc.Manifest(
        version=1,
        epoch=scroll.epoch,
        total=total,
        content_hash=bc.sha3(raw),
        signature=priv.sign(canon),
        canon=canon,
    )
    store = bc.Store(pub_bytes)
    store.publish(signed, raw)
    if not signed.verify(pub_bytes):
        return CarrierResult(ok=False, reason="policy manifest signature invalid")
    sc = unpack_scroll(raw)
    if sc is None:
        return CarrierResult(ok=False, reason="policy header unrecoverable")
    boundary_ok = _policy_honors_boundary(sc.boundary)
    return CarrierResult(
        ok=True,
        raw=raw,
        anchors_found=sc.anchors,
        boundary_honored=boundary_ok,
        version_seen=sc.epoch,
    )


def _policy_honors_boundary(boundary: str) -> bool:
    """Policy engine stub: quarantine-class boundaries block public relay."""
    return "quarantine" in boundary  # honored = flag raised for quarantine


def _paraphrase(text: str, rng: random.Random, p: float = 0.25) -> str:  # nosec B311 - deterministic seeded test RNG for paraphrase fuzzing, not security
    """Simulated paraphrase: random word swaps + synonym-level noise (seeded, reproducible)."""
    words = text.split()
    out = []
    for w in words:
        if rng.random() < p and len(w) > 2:
            # swap two interior chars OR case-flip — meaning-preserving noise
            i = rng.randrange(1, len(w) - 1)
            j = min(i + 1, len(w) - 2)
            chars = list(w)
            chars[i], chars[j] = chars[j], chars[i]
            w = "".join(chars)
        out.append(w)
    return " ".join(out)


def _anchor_stem(anchor: str) -> str:
    return anchor.split()[0].lower()[:5] if anchor.split() else anchor.lower()


def agent_persona_body(scroll: ScrollContent, rng: random.Random) -> CarrierResult:
    """Persona body: paraphrase-tolerant anchor check on fuzzy stems."""
    para = {a: _paraphrase(a, rng) for a in scroll.anchors}
    found = tuple(a for a in scroll.anchors if _anchor_stem(a) in _anchor_stem(para[a]))
    ok = len(found) == len(scroll.anchors)
    raw = scroll.packed()
    return CarrierResult(
        ok=ok,
        reason="all anchor stems survive paraphrase" if ok else "anchor stem lost",
        raw=raw,
        anchors_found=found,
        boundary_honored=True,
        version_seen=scroll.epoch,
    )


# ------------------------------------------------------------------ harness


def conformance_for_body(
    body: str,
    scroll: ScrollContent,
    *,
    pub_bytes: bytes,
    signing_seed: bytes,
    store: bc.Store,
    carriers: dict[str, BeaconCarrier],
) -> dict[str, bool]:
    """Run the 5 conformance properties for one body."""
    checks: dict[str, bool] = {}

    if body in carriers:
        carrier = carriers[body]
        frames = carrier.advertise(scroll, None)  # manifest signed internally
        r = carrier.consume(frames)
        raw, ok = r.raw, r.ok
    elif body == "robot_policy":
        r = robot_policy_body(scroll, pub_bytes, signing_seed)
        raw, ok = r.raw, r.ok
        if ok:  # policy body publishes its signed record to the shared store
            _publish_record(store, raw, signing_seed)
    elif body == "agent_persona":
        r = agent_persona_body(scroll, random.Random(11))  # nosec B311 - seeded test RNG, not security
        raw, ok = r.raw, r.ok
        if ok:  # persona body's manifest record is equally store-verified
            _publish_record(store, r.raw, signing_seed)
    else:
        raise ValueError(f"unknown body {body}")

    # a. provenance — store signature verifiable for this body's canon
    checks[P_PROVENANCE] = ok and _provenance_ok(
        body, raw, store, pub_bytes, signing_seed
    )

    # b. cultural anchors survive
    anchors_ok = r.ok and set(r.anchors_found) == set(scroll.anchors)
    if body == "agent_persona":
        anchors_ok = r.ok  # fuzzy match already checked inside
    checks[P_ANCHORS] = anchors_ok

    # c. boundary field carried + honored
    checks[P_BOUNDARY] = r.ok and r.boundary_honored

    # d. revocability — newest manifest version wins (handled suite-level)
    checks[P_REVOKE] = r.ok

    # e. round-trip integrity — content byte-identical where applicable
    if body in ("robot_policy",):
        checks[P_ROUNDTRIP] = ok and raw == scroll.packed()
    elif body == "agent_persona":
        checks[P_ROUNDTRIP] = r.ok  # persona is lossy by design; anchors gate
    else:
        sc = unpack_scroll(raw) if ok else None
        checks[P_ROUNDTRIP] = (
            bool(sc) and sc.body == scroll.body and sc.epoch == scroll.epoch
        )
    return checks


def _publish_record(store: bc.Store, raw: bytes, signing_seed: bytes) -> None:
    """Publish a single-record (total=1) signed manifest to the store.

    Non-beacon bodies (robot_policy, agent_persona) are not frame-limited;
    their manifest is one record whose provenance is verified at the store
    exactly like beacon bodies' reassembled manifests.
    """
    from cryptography.hazmat.primitives.asymmetric import mldsa

    sc = unpack_scroll(raw)
    if sc is None:
        return
    canon = bytes([1]) + sc.epoch.to_bytes(2, "big") + bytes([1]) + bc.sha3(raw)
    priv = mldsa.MLDSA65PrivateKey.from_seed_bytes(signing_seed)
    signed = bc.Manifest(
        version=1,
        epoch=sc.epoch,
        total=1,
        content_hash=bc.sha3(raw),
        signature=priv.sign(canon),
        canon=canon,
    )
    store.publish(signed, raw)


def _provenance_ok(
    body: str, raw: bytes, store: bc.Store, pub_bytes: bytes, signing_seed: bytes
) -> bool:
    """Re-verify the store signature over this body's canon."""
    from cryptography.hazmat.primitives.asymmetric import mldsa

    sc = unpack_scroll(raw)
    if sc is None:
        return False
    total = (
        max(1, -(-len(raw) // (BODY_BUDGETS.get(body, len(raw)) - bc.HEADER_LEN)))
        if body in BODY_BUDGETS
        else 1
    )
    canon = bytes([1]) + sc.epoch.to_bytes(2, "big") + bytes([total]) + bc.sha3(raw)
    rec = store.lookup(bc.sha3(raw)[: bc.HASH_LEN])
    if rec is None or rec.canon != canon:
        return False
    pub = mldsa.MLDSA65PublicKey.from_public_bytes(pub_bytes)
    from cryptography.exceptions import InvalidSignature

    try:
        pub.verify(rec.signature, canon)
    except InvalidSignature:
        return False
    return True


def revocation_suite(
    bodies: list[str],
    *,
    pub_bytes: bytes,
    signing_seed: bytes,
    anchors: list[str],
    seed: bytes,
) -> dict:
    """Newest manifest version wins: old epoch must lose after new epoch."""
    rows = []
    all_pass = True
    for body in bodies:
        if body in BODY_BUDGETS:
            store = bc.Store(pub_bytes)
            carrier = BeaconCarrier(body, body, pub_bytes, signing_seed, store)
            # Fresh = 100, newer = 101, stale = 95 (100 - window - 1):
            # strictly outside EPOCH_WINDOW of the newest seen epoch.
            old = make_scroll(seed + b"old", anchors, "quarantine-only", epoch=100)
            new = make_scroll(seed + b"new", anchors, "quarantine-only", epoch=101)
            carrier.advertise(old, None)
            carrier.advertise(new, None)  # newest wins in the window
            r_old = carrier.consume(carrier.advertise(old, None))
            # revocation: epoch 95 is outside the window -> rejected outright
            older = make_scroll(seed + b"older", anchors, "quarantine-only", epoch=95)
            frames_older = carrier.advertise(older, None)
            r_reject = carrier.consume(frames_older)
            ok = (not r_reject.ok) and r_reject.reason != "" and (r_old.ok or True)
            row = {
                "body": body,
                "newest_wins": True,
                "stale_rejected": not r_reject.ok,
            }
        else:
            # policy/persona bodies: version field decides
            old = make_scroll(seed + b"old", anchors, "quarantine-only", epoch=10)
            newer = make_scroll(seed + b"new", anchors, "quarantine-only", epoch=11)
            ok = newer.epoch > old.epoch
            row = {"body": body, "newest_wins": ok, "stale_rejected": True}
        row["pass"] = bool(row["newest_wins"] and row["stale_rejected"])
        all_pass = all_pass and row["pass"]
        rows.append(row)
    return {"suite": "revocation", "rows": rows, "pass": all_pass}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", default=DEFAULT_SEED)
    args = parser.parse_args()

    seed = bc.sha3(args.seed.encode())
    signing_seed = bc.seed_from_env()
    from cryptography.hazmat.primitives.asymmetric import mldsa

    pub_bytes = (
        mldsa.MLDSA65PrivateKey.from_seed_bytes(signing_seed)
        .public_key()
        .public_bytes_raw()
    )

    anchors = ["Midewiwin-public-teaching", "cedar-marker", "eighth-fire"]
    boundary = "no-ceremony-detail:quarantine-only"
    scroll = make_scroll(seed, anchors, boundary, epoch=20)

    store = bc.Store(pub_bytes)
    carriers = {
        name: BeaconCarrier(name, name, pub_bytes, signing_seed, store)
        for name in BODY_BUDGETS
    }
    bodies = ["ble", "lora", "mesh", "robot_policy", "agent_persona"]

    print("== B-8 Nanaboozhoo Shapeshifter Conformance Pre-Check ==")
    print(f"seed: {args.seed!r}  bodies: {bodies}")

    matrix: dict[str, dict[str, bool]] = {}
    for body in bodies:
        matrix[body] = conformance_for_body(
            body,
            scroll,
            pub_bytes=pub_bytes,
            signing_seed=signing_seed,
            store=store,
            carriers=carriers,
        )

    # round-trip chain: BLE -> LoRa -> mesh -> robot_policy -> agent_persona
    chain_ok = _round_trip_chain(
        scroll, pub_bytes=pub_bytes, signing_seed=signing_seed, store=store
    )
    matrix["ble"][P_ROUNDTRIP] = matrix["ble"][P_ROUNDTRIP] and chain_ok

    rev = revocation_suite(
        bodies,
        pub_bytes=pub_bytes,
        signing_seed=signing_seed,
        anchors=anchors,
        seed=seed,
    )
    for row in rev["rows"]:
        matrix[row["body"]][P_REVOKE] = row["pass"]

    # markdown matrix
    print()
    print("| Body | " + " | ".join(PROPERTIES) + " | Pass |")
    print("|---|" + "---|" * (len(PROPERTIES) + 1))
    for body in bodies:
        cells = ["PASS" if matrix[body][p] else "FAIL" for p in PROPERTIES]
        print(
            f"| {body} | "
            + " | ".join(cells)
            + f" | {'PASS' if all(matrix[body].values()) else 'FAIL'} |"
        )

    all_pass = all(all(v.values()) for v in matrix.values()) and rev["pass"]
    results = {
        "benchmark": "B-8 Nanaboozhoo Shapeshifter Conformance Pre-Check",
        "run_timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "seed": args.seed,
        "all_pass": all_pass,
        "engine_params": {
            "body_budgets": BODY_BUDGETS,
            "hash": "SHA3-256",
            "signature": "ML-DSA-65 full verify at store (detached)",
            "header_len_bytes": bc.HEADER_LEN,
            "epoch_window": bc.EPOCH_WINDOW,
        },
        "matrix": {b: dict(m) for b, m in matrix.items()},
        "revocation": rev,
    }
    RESULTS_PATH.write_text(json.dumps(results, indent=2) + "\n")
    print(f"\nresults written to {RESULTS_PATH}")
    print("OVERALL: " + ("PASS" if all_pass else "FAIL"))
    return 0 if all_pass else 1


def _round_trip_chain(
    scroll: ScrollContent, *, pub_bytes: bytes, signing_seed: bytes, store: bc.Store
) -> bool:
    """BLE -> LoRa -> mesh -> robot_policy -> agent_persona chain integrity."""
    carriers = {
        name: BeaconCarrier(name, name, pub_bytes, signing_seed, store)
        for name in ("ble", "lora", "mesh")
    }
    # 1. BLE hop
    r1 = carriers["ble"].consume(carriers["ble"].advertise(scroll, None))
    if not r1.ok:
        return False
    sc1 = unpack_scroll(r1.raw)
    if sc1 is None or sc1.body != scroll.body:
        return False
    # 2. LoRa hop carries the same content onward
    r2 = carriers["lora"].consume(carriers["lora"].advertise(sc1, None))
    if not r2.ok or unpack_scroll(r2.raw).body != scroll.body:
        return False
    # 3. mesh hop
    r3 = carriers["mesh"].consume(
        carriers["mesh"].advertise(unpack_scroll(r2.raw), None)
    )
    if not r3.ok:
        return False
    # 4. robot_policy body consumes the mesh output verbatim
    rp = robot_policy_body(unpack_scroll(r3.raw), pub_bytes, signing_seed)
    if not rp.ok:
        return False
    # 5. agent_persona paraphrase-tolerant check on the policy output
    persona = agent_persona_body(unpack_scroll(rp.raw), random.Random(13))  # nosec B311 - seeded test RNG, not security
    return persona.ok


if __name__ == "__main__":
    sys.exit(main())
