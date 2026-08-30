# B-6 — Signed-Beacon Provenance Under Realistic Loss

Software harness for benchmark **B-6** (research/09 §B-6, RQ3). Proves the
chunked hash-pointer beacon design (research/04, "Signed-scroll beacon:
payload-size math and chunking design") before hardware exists: hardware
acquisition is FUNDING-DEFERRED, so this harness is the zero-cost proof and
later drives real radios unchanged.

## Design summary

One full **ML-DSA-65** signature (FIPS 204, `cryptography>=46`, same
`from_seed_bytes` engine as `scripts/scrolls/scroll_manifest.py`) is computed
over the manifest canon at beacon-build time and verified **only at the
durable store** — the detached-verification trust model (digest 04 point 4).
On-air chunks are pointers, not proofs:

```
ver(1B) | epoch(2B BE) | seq(1B) | total(1B) | content-hash (SHA3-256 truncated 8B) | fragment
```

| Bearer | App budget/chunk | Header | Fragment payload |
|---|---|---|---|
| BLE legacy adv (31 B − 5 B MSD framing) | 26 B | 13 B | 13 B |
| LoRa US915 LongFast (typical) | 200 B | 13 B | 187 B |

Receiver pipeline: rolling **epoch window** (replay defense, digest 04
point 5) → **gap detection** (seen seqs vs `range(total)`) → **store
fallback** (missing fragments fetched from the durable store when reachable)
→ full-hash check + full signature verify at the store.

## Run

```sh
uv run --with 'cryptography>=46' python benchmarks/b6/beacon_sim.py [--seed S] [--trials N]
```

- Default content seed: `"b6"` (SHA3-256-derived) — deterministic per seed.
- Default trials: `1` (clean channel repeats ≥3 regardless).
- Signing seed: `AINISHCODER_SCROLL_SIGN_SEED` env (32-byte hex) when set,
  else the documented benchmark default (`bytes(range(32))`).
- Full JSON written to `benchmarks/b6/results.json` (per-scenario metrics,
  run timestamp, engine params).

## Scenarios and metrics

| Suite | Threat | Metric | Expected |
|---|---|---|---|
| 1 clean_channel | none | reassembly + store-verify success, e2e ms | 100% |
| 2 uniform_loss | each single chunk dropped in turn | gap-detection rate, store-fallback reassembly | 100% / 100% |
| 3 burst_loss | k∈{2,4,8} consecutive chunks dropped | gap-detection, store-fallback | 100% / 100% |
| 4 injection_tamper | 1-byte fragment flip | tamper-detection rate, false-positive rate on clean | 100% / 0% |
| 5 replay | stale-epoch chunk set re-delivered | replay acceptance rate | 0% |

## DEF CON demo outline (3 steps)

1. **Transmit**: laptop A advertises an N-chunk manifest over BLE legacy
   frames (`Chunk.encode()` → Manufacturer Specific Data); laptop B
   reassembles live and shows the store verify PASS badge.
2. **Attack**: flip a byte in a captured frame (hackrf/rfcat or a scripted
   re-send) — the receiver's hash-pointer check flags the tampered `seq`
   instantly; replay an old epoch — rejected by the window.
3. **Resilience**: jam/drop k consecutive frames — gap detection + store
   fallback reassembles anyway, with the store-verify path shown on screen.

## Files

- `beacon_chunk.py` — chunker / reassembler / rolling epoch window / store
- `beacon_sim.py` — the 5 scenario suites, markdown table, JSON dump
- `results.json` — latest run's full metrics
