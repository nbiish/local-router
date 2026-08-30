#!/usr/bin/env python3
"""B-6 signed-beacon chunker / reassembler / detached-verification store.

Implements the digest 04 chunking design (research/04-spectrum-knowledge.md,
section "Signed-scroll beacon: payload-size math and chunking design"):

    ver(1B) | epoch(2B BE) | seq(1B) | total(1B) |
    content-hash (SHA3-256 truncated to 8B) | fragment (remaining bytes)

The beacon carries pointers, not proofs (digest 04 point 4): one full
ML-DSA-65 signature is computed over the manifest canon and verified only at
the durable store (detached-verification trust model). Chunks carry a
truncated content-hash pointer that receivers use to (a) group frames into
one stream, (b) detect tampering locally, and (c) fall back to the store for
missing fragments.

Rolling epoch window (digest 04 point 5): epochs newer than, or within
EPOCH_WINDOW of, the newest observed epoch are accepted; anything older is
rejected as a replay. Duplicate seq values within the current epoch are
benign retransmissions and fold into the same slot.

Budgets (digest 04): BLE legacy advertisement 31 B minus 5 B Manufacturer
Specific Data framing (len + AD type + 2-byte company ID) = 26 B app payload
per chunk; LoRa US915 LongFast ~200 B typical app payload per chunk.

Python 3.10+, stdlib + cryptography only.
Entry point: uv run --with 'cryptography>=46' python benchmarks/b6/beacon_sim.py
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass, field
from typing import Literal

Mode = Literal["ble", "lora"]

# Digest 04 frame budgets.
BUDGET: dict[str, int] = {"ble": 26, "lora": 200}

# On-air chunk header: ver(1) epoch(2) seq(1) total(1) content_hash8(8).
VER_LEN = 1
EPOCH_LEN = 2
SEQ_LEN = 1
TOTAL_LEN = 1
HASH_LEN = 8  # SHA3-256 truncated to 8 bytes (digest 04 range 8-16 B)

HEADER_LEN = VER_LEN + EPOCH_LEN + SEQ_LEN + TOTAL_LEN + HASH_LEN

# Rolling epoch window (digest 04 replay countermeasure).
EPOCH_WINDOW = 4

MLDSA65_SEED_ENV = "AINISHCODER_SCROLL_SIGN_SEED"
DEFAULT_SEED = bytes(range(32))  # benchmark-only default; real keys come from env


def sha3(data: bytes) -> bytes:
    return hashlib.sha3_256(data).digest()


def trunc8(digest: bytes) -> bytes:
    return digest[:HASH_LEN]


def fragment_payload_len(mode: Mode) -> int:
    return BUDGET[mode] - HEADER_LEN


def total_chunks(content_len: int, mode: Mode) -> int:
    """Chunk count needed to carry content_len bytes in mode."""
    frag = fragment_payload_len(mode)
    if frag <= 0:
        raise ValueError(f"budget {BUDGET[mode]} too small for header {HEADER_LEN}")
    return max(1, -(-content_len // frag))  # ceil division


def seed_from_env() -> bytes:
    """32-byte ML-DSA-65 seed from env (hex) or the benchmark default."""
    value = os.environ.get(MLDSA65_SEED_ENV, "")
    if value:
        seed = bytes.fromhex(value)
        if len(seed) != 32:
            raise ValueError(f"{MLDSA65_SEED_ENV} must be 32 bytes hex")
        return seed
    return DEFAULT_SEED


def make_content(seed: bytes, length: int) -> bytes:
    """Deterministic synthetic public-teaching placeholder content."""
    out = bytearray()
    counter = 0
    while len(out) < length:
        out.extend(hashlib.sha3_256(seed + counter.to_bytes(4, "big")).digest())
        counter += 1
    return bytes(out[:length])


# --------------------------------------------------------------- manifest


@dataclass(frozen=True)
class Manifest:
    """Signed pointer to durable scroll content.

    canon = ver(1) | epoch(2 BE) | total(1) | full SHA3-256(content) (32 B).
    One ML-DSA-65 signature covers exactly the canon bytes; a receiver that
    reassembles the manifest reconstructs the canon from chunk headers plus
    the full hash of the reassembled content and verifies the signature at
    the store.
    """

    version: int
    epoch: int
    total: int
    content_hash: bytes  # full 32-byte SHA3-256 over the content
    signature: bytes  # full ML-DSA-65 signature over canon
    canon: bytes

    @property
    def content_hash8(self) -> bytes:
        return self.content_hash[:HASH_LEN]

    @property
    def sig_len(self) -> int:
        return len(self.signature)

    def verify(self, pub_bytes: bytes) -> bool:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric import mldsa

        pub = mldsa.MLDSA65PublicKey.from_public_bytes(pub_bytes)
        try:
            pub.verify(self.signature, self.canon)
        except InvalidSignature:
            return False
        return True


def make_manifest(
    content: bytes, epoch: int, mode: Mode, *, seed: bytes | None = None
) -> Manifest:
    """Build and sign a manifest sized for `mode`.

    The only asymmetric-crypto operation on the transmit side: one
    ML-DSA-65 signature over the canon. `total` (chunk count) is part of the
    canon, so chunking is decided before signing.
    """
    from cryptography.hazmat.primitives.asymmetric import mldsa

    content_hash = sha3(content)
    total = total_chunks(len(content), mode)
    canon = (
        bytes([1]) + epoch.to_bytes(EPOCH_LEN, "big") + bytes([total]) + content_hash
    )
    priv = mldsa.MLDSA65PrivateKey.from_seed_bytes(
        seed if seed is not None else seed_from_env()
    )
    return Manifest(
        version=1,
        epoch=epoch,
        total=total,
        content_hash=content_hash,
        signature=priv.sign(canon),
        canon=canon,
    )


# ----------------------------------------------------------------- chunks


@dataclass(frozen=True)
class Chunk:
    """One on-air beacon chunk (ver | epoch | seq | total | hash8 | fragment)."""

    version: int
    epoch: int
    seq: int
    total: int
    content_hash8: bytes  # truncated content-hash pointer, same in every chunk
    fragment: bytes

    def encode(self) -> bytes:
        """Encode to exactly HEADER_LEN + len(fragment) bytes."""
        return (
            bytes([self.version])
            + self.epoch.to_bytes(EPOCH_LEN, "big")
            + bytes([self.seq, self.total])
            + self.content_hash8
            + self.fragment
        )

    @classmethod
    def decode(cls, raw: bytes) -> Chunk:
        if len(raw) < HEADER_LEN:
            raise ValueError(f"chunk too short: {len(raw)} < {HEADER_LEN}")
        return cls(
            version=raw[0],
            epoch=int.from_bytes(raw[1 : 1 + EPOCH_LEN], "big"),
            seq=raw[3],
            total=raw[4],
            content_hash8=raw[5 : 5 + HASH_LEN],
            fragment=raw[HEADER_LEN:],
        )


def chunkify(manifest: Manifest, content: bytes, mode: Mode) -> list[Chunk]:
    """Split content into on-air chunks for the given bearer mode.

    Every chunk carries the same truncated content-hash pointer so receivers
    group frames belonging to one beacon stream (digest 04 point 3).
    """
    if total_chunks(len(content), mode) != manifest.total:
        raise ValueError(
            f"manifest.total {manifest.total} != recomputed "
            f"{total_chunks(len(content), mode)}; re-sign for this mode"
        )
    frag = fragment_payload_len(mode)
    return [
        Chunk(
            version=manifest.version,
            epoch=manifest.epoch,
            seq=seq,
            total=manifest.total,
            content_hash8=manifest.content_hash8,
            fragment=content[seq * frag : (seq + 1) * frag],
        )
        for seq in range(manifest.total)
    ]


# --------------------------------------------------------------- receiver


@dataclass
class ReceiverState:
    """Rolling epoch window for replay defense (digest 04 point 5)."""

    newest_epoch: int = 0
    have_epoch: bool = False
    rejected: list[int] = field(default_factory=list)

    def accept_epoch(self, epoch: int) -> bool:
        """True if epoch is fresh: newer, or within EPOCH_WINDOW of newest."""
        if not self.have_epoch:
            self.newest_epoch = epoch
            self.have_epoch = True
            return True
        if epoch > self.newest_epoch:
            self.newest_epoch = epoch
            return True
        if self.newest_epoch - epoch > EPOCH_WINDOW:
            self.rejected.append(epoch)
            return False
        return True


@dataclass
class StoreRecord:
    canon: bytes
    signature: bytes
    content: bytes


class Store:
    """Durable store: full ML-DSA-65 verification happens here (digest 04).

    Records are keyed by the truncated content-hash pointer (8 B) — the only
    stream handle a receiver sees on-air.
    """

    def __init__(self, pub_bytes: bytes, *, available: bool = True) -> None:
        self.pub_bytes = pub_bytes
        self.available = available
        self.records: dict[bytes, StoreRecord] = {}

    def publish(self, manifest: Manifest, content: bytes) -> None:
        self.records[manifest.content_hash8] = StoreRecord(
            canon=manifest.canon, signature=manifest.signature, content=content
        )

    def lookup(self, ptr8: bytes) -> StoreRecord | None:
        return self.records.get(ptr8)

    def verify(self, canon: bytes, ptr8: bytes) -> bool:
        """Verify reassembled canon against the stored record's signature."""
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric import mldsa

        record = self.records.get(ptr8)
        if record is None or record.canon != canon:
            return False
        pub = mldsa.MLDSA65PublicKey.from_public_bytes(self.pub_bytes)
        try:
            pub.verify(record.signature, canon)
        except InvalidSignature:
            return False
        return True


@dataclass
class ReassemblyResult:
    """Outcome of one receiver reassembly attempt."""

    ok: bool
    reason: str
    content: bytes = b""
    gaps: list[int] = field(default_factory=list)  # missing seqs detected
    tampered_seqs: list[int] = field(default_factory=list)
    store_used: bool = False  # filled gaps from the durable store
    replay_rejected: bool = False
    store_unreachable: bool = False  # degraded-mode outcome
    store_verified: bool = False  # full ML-DSA-65 verify at the store


def reassemble(
    chunks: list[Chunk],
    *,
    store: Store,
    state: ReceiverState,
    policy: Literal["reject", "quarantine"] = "reject",
) -> ReassemblyResult:
    """Epoch window -> gap detection -> store fallback -> hash + sig verify.

    1. Replay window: any chunk from an epoch older than
       newest_epoch - EPOCH_WINDOW rejects the whole attempt.
    2. Group by content_hash8 (one stream per attempt here).
    3. Gap detection: seen seqs vs range(total).
    4. Store fallback: missing fragments fetched from the durable store when
       reachable; otherwise the attempt fails (degraded mode, per policy).
    5. Local tamper check: SHA3-256 of reassembled content truncated to 8 B
       must equal the on-air pointer; mismatches localize per-seq against
       the store's authoritative copy when reachable.
    6. Detached verification: rebuild the manifest canon from headers plus
       the full content hash and run the full ML-DSA-65 verify at the store.
    """
    if not chunks:
        return ReassemblyResult(ok=False, reason="no chunks received")

    # 1. replay window (probe copy: a rejected attempt must not advance state)
    probe = ReceiverState(newest_epoch=state.newest_epoch, have_epoch=state.have_epoch)
    for ch in chunks:
        if not probe.accept_epoch(ch.epoch):
            return ReassemblyResult(
                ok=False,
                reason=f"epoch {ch.epoch} older than window "
                f"(newest {probe.newest_epoch})",
                replay_rejected=True,
            )

    # 2. stream grouping / header consistency
    ptr8 = chunks[0].content_hash8
    stream = [ch for ch in chunks if ch.content_hash8 == ptr8]
    total = stream[0].total
    epoch = stream[0].epoch
    version = stream[0].version
    if any(ch.total != total or ch.epoch != epoch for ch in stream):
        return ReassemblyResult(ok=False, reason="inconsistent stream headers")
    # Full fragments all carry the stride length; only the last chunk may be
    # shorter, so max() recovers the stride even when the tail chunk is lost.
    frag_len = max(len(ch.fragment) for ch in stream)

    # 3. gap detection
    seen: dict[int, Chunk] = {}
    for ch in stream:
        seen.setdefault(ch.seq, ch)  # duplicate seq = benign retransmission
    gaps = sorted(set(range(total)) - set(seen))

    # 4. store fallback for missing fragments
    store_used = False
    if gaps:
        if not store.available:
            return ReassemblyResult(
                ok=False,
                reason="store unreachable with gaps (degraded mode)",
                gaps=gaps,
                store_unreachable=True,
            )
        record = store.lookup(ptr8)
        if record is None:
            return ReassemblyResult(
                ok=False, reason="no store record for pointer", gaps=gaps
            )
        for seq in gaps:
            start = seq * frag_len
            seen[seq] = Chunk(
                version=version,
                epoch=epoch,
                seq=seq,
                total=total,
                content_hash8=ptr8,
                fragment=record.content[start : start + frag_len],
            )
        store_used = True

    # 5. reassemble + local tamper check
    content = b"".join(seen[seq].fragment for seq in range(total))
    full_hash = sha3(content)
    if trunc8(full_hash) != ptr8:
        tampered: list[int] = []
        record = store.lookup(ptr8) if store.available else None
        if record is not None:
            tampered = [
                seq
                for seq in range(total)
                if seen[seq].fragment
                != record.content[seq * frag_len :][: len(seen[seq].fragment)]
            ]
        return ReassemblyResult(
            ok=False,
            reason="truncated-hash mismatch (tamper detected)",
            gaps=gaps,
            tampered_seqs=tampered,
            store_used=store_used,
        )

    # 6. detached verification at the store
    canon = (
        bytes([version]) + epoch.to_bytes(EPOCH_LEN, "big") + bytes([total]) + full_hash
    )
    if not store.available:
        if policy == "quarantine":
            return ReassemblyResult(
                ok=True,
                reason="store unreachable; quarantined per policy",
                content=content,
                gaps=gaps,
                store_used=store_used,
                store_unreachable=True,
            )
        return ReassemblyResult(
            ok=False,
            reason="store unreachable; rejected per policy (degraded mode)",
            gaps=gaps,
            store_used=store_used,
            store_unreachable=True,
        )
    if not store.verify(canon, ptr8):
        return ReassemblyResult(
            ok=False,
            reason="store signature verification failed",
            gaps=gaps,
            store_used=store_used,
        )
    state.newest_epoch = probe.newest_epoch
    state.have_epoch = True
    return ReassemblyResult(
        ok=True,
        reason="ok",
        content=content,
        gaps=gaps,
        store_used=store_used,
        store_verified=True,
    )
