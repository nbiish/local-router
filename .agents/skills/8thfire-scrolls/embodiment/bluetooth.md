# bluetooth.md — BLE Beacon Design for the Ember: Advertising, GATT, and Carrier Privacy

Module class: `.scrolls-embodiment/` — signed manifest payload (see `README.md` loader contract).
Dual mandate: **RED** (how BLE advertising and GATT are spoofed, replayed, and tracked — and how the ember beacon resists) + **BLUE** (a personal-scale, low-power beacon that carries authentic discovery pointers to the cultural ember, without becoming a tracker of the human who carries it).

## Purpose

BLE is the shortest reach and the lowest cost of the ember's bearers — a $10 nRF52 devkit, a phone, a solar sensor — and the only one that talks to the devices people already carry. This module specifies how to build the **signed scroll beacon** inside the 31-byte legacy advertising budget, how GATT serves verified content to a connected receiver, and how the beacon's own radio behavior avoids turning a cultural carrier into a location-tracking device. It is the receiver-side and framing-layer companion to the chunked hash-pointer manifest defined in `radio.md` (K4).

Defensive-only: nothing here scans, tracks, or impersonates third-party devices. Anomaly awareness exists to protect the ember beacon, never to profile others.

## Knowledge units

### K1. BLE physics and channel structure (physics → protocol)

- **Band:** 2.400–2.4835 GHz ISM. 40 channels × 2 MHz spacing; channels 37, 38, 39 are reserved as the three **advertising channels**, placed away from the Wi-Fi center frequencies to dodge the loudest interference.
- **Advertising:** connectionless, receiver-initiated-nothing broadcasts. Legacy advertising payload is **31 bytes**; BLE 5 extended advertising raises this to ~255 bytes where all receivers support it. Advertising intervals trade latency against battery: fast advertising (e.g., 20–60 ms) for discovery bursts, slow (e.g., 1–10 s) for fixed beacons.
- **GATT:** the connected-mode profile layer — services, characteristics, read/write/notify. Used when a receiver wants *more* than discovery: the full chunk manifest, a content fragment, or a signed status block.
- **BLE Mesh:** floods on advertising bearers; every relay node repeats. Useful for campus-scale ember distribution but floods cost latency and duty cycle — see legality K5.

### K2. The 31-byte budget: scroll beacon framing (protocol design)

A Manufacturer Specific Data structure costs 3 bytes of overhead (length + AD type 0xFF + 2-byte company ID), leaving **~26 bytes of app payload per legacy advertisement** — the design budget for the scroll beacon. Layout (matches `radio.md` K4):

```
| field          | bytes | notes                                            |
|----------------|-------|--------------------------------------------------|
| ver / epoch    | 1     | rolling counter; receivers reject stale epochs    |
| seq / total    | 1+1   | chunk index and chunk count                       |
| content-hash   | 8–16  | SHA-256 truncated; binds the chunk set            |
| pointer-hash   | 8–16  | hash of the durable pointer (IPFS CID / URL)      |
| sig-fragment   | rest  | truncated signature or hash-chain head            |
```

**Signature economics.** ML-DSA-65 (FIPS 204) signatures are ≈ 2420 bytes [INFERENCE from FIPS 204 parameter sizes] — far beyond one frame. Therefore the beacon carries a *truncated signature or hash-chain head*, and the **full signed manifest is fetched from the durable store and verified there**. The beacon's job is *authentic discovery*, not full verification. A receiver that cannot reach the durable store treats beacon content as a hint only — it never displays unverified scroll content on the strength of the beacon alone.

**Extended advertising path:** where the receiver fleet supports BLE 5 extended advertising (~254-byte app payload), a full hash + longer sig-fragment fits per frame; the same verify-at-store rule applies.

#### Worked example: a two-chunk scroll beacon in 26 bytes

Suppose the community publishes a language-carrier ember whose full manifest (with a complete ML-DSA-65 signature) lives at an IPFS pin server and a community mirror. Each legacy advertisement carries:

```
epoch=0x07 | seq=0/2 | content-hash[0..8] | pointer-hash[0..8] | sig-frag[0..5]
epoch=0x07 | seq=1/2 | content-hash[0..8] | pointer-hash[0..8] | sig-frag[5..10]
```

A receiver hearing both chunks: (1) checks epoch 7 is current per its revocation state; (2) matches identical content-hash and pointer-hash across chunks (mismatch = drop); (3) concatenates sig-fragments into a 10-byte truncated head; (4) fetches the manifest at the pointer, verifies SHA3-256 of the manifest against its full content-hash, verifies the ML-DSA-65 signature, and *only then* treats the discovery as authentic. Beacon heard but store unreachable → a hint cached for later verification, never displayed content. This is the entire discovery protocol — small on purpose, because everything security-critical happens at the verified store.

**Budget arithmetic to internalize:** 26 bytes minus 1 (epoch) minus 2 (seq/total) leaves 23; a 8+8-byte hash pair leaves 7 for a sig-fragment per chunk — so a 2-chunk beacon carries a 14-byte truncated signature head, and a 4-chunk beacon (smaller hashes, e.g. 6+6 bytes) carries ~22 bytes across its chunks. Design accordingly: the truncation is a *discovery* trust signal; the full 2420-byte ML-DSA-65 verification always happens at the store.

### K3. GATT service design (protocol → verified content transfer)

A scroll beacon exposes a minimal GATT service for connected receivers:

| Characteristic | Access | Content |
|---|---|---|
| `manifest_status` | read | current epoch, chunk totals, manifest digest prefix |
| `chunk` | read (index) | one chunk of the hash-pointer manifest |
| `verify_hint` | read | truncated signature / hash-chain head |
| `store_pointer` | read | durable address (CID/URL) — pointers + hashes, **never secrets** (NFC/relay lesson applies) |

Design rules: no writable characteristics on the beacon (a writable beacon is a spoofable beacon); connection requires the receiver to present nothing secret — the trust is in the manifest signature, not in connection auth; LE Secure Connections (ECDH pairing) is for the *carrier's own* administrative link (config app), never for public readers.

### K4. RED surface: spoofing, replay, and the tracking problem (security)

| Threat | What it does | Countermeasure |
|---|---|---|
| Beacon spoofing | Forging the beacon's identity/payload to serve a false pointer | Signed manifests verified at the store; receiver-side physical-layer anomaly detection (BlueShield / "jitter trap" research detects spoofed adverts by RF features: timing jitter, modulation inconsistencies) |
| Replay | Rebroadcasting a captured old beacon to resurrect stale context | Rolling epoch/seq with a rejection window; the cultural "season" field rejects out-of-season stale scrolls (`radio.md` K4) |
| **Timing-correlation tracking** ("Battery Insertion Attack", PoPETs 2025) | Randomized MACs defeated by correlating advertisement *timing* fingerprints | **Quasi-periodic randomized advertising scheduling** ("timed-sequence indistinguishability"); carrier-privacy mode below |
| Content substitution at store | Poisoning what the beacon points to | content-hash binds the chunk set; the durable store serves the ML-DSA-65-signed manifest; mismatch = refuse |
| Downgrade to unverified display | Tricking a receiver into showing beacon-only content | Hard rule: no display without full manifest verification |

**Carrier-privacy mode (the module's RED/BLUE hinge).** A cultural beacon must not become a location tracker of its human carrier. For mobile carriers: randomized MAC addresses rotating on an unpredictable schedule, advertisement timing drawn from a quasi-periodic randomized distribution, and identical payloads across rotation (the payload is public discovery data; nothing in it identifies the carrier). Fixed installations (cedar marker, trailhead) may use stable identities — a fixed beacon being trackable at its fixed location leaks nothing about a person.

### K5. Legality

| Aspect | Rule | Citation |
|---|---|---|
| Band / power | 2400–2483.5 MHz ISM; same limits as other §15.247 emitters; certified modules only, no modifications beyond certification | 47 CFR §15.247 (law.cornell.edu/cfr/text/47/15.247) |
| Non-interference basis | Part 15 devices must accept interference and not cause harmful interference | 47 CFR §15.5 |
| BLE Mesh flooding | Duty-cycle discipline matters even where a specific duty cap is not stated — keep advertising load courteous on shared ISM spectrum; EU: ETSI EN 300 328 governs 2.4 GHz wideband equipment [INFERENCE: verify current ETSI text for EU deployment] | 47 CFR §15.247; ETSI EN 300 328 |
| ITU region check | 2.4 GHz ISM is broadly aligned across ITU Regions 1/2/3 but regional power/EIRP details differ — verify before any overseas demo | ITU Radio Regulations, Article 5 |
| Listening | Receiving BLE advertising is generally lawful; using/decrypting others' traffic can violate ECPA | 18 U.S.C. §2511 [INFERENCE — consult counsel] |

## Embodiment integration

A robot, drone, or mesh node consumes this module via the signed manifest (`README.md` flow):

1. **Verify:** manifest.sig (ML-DSA-65, FIPS 204) over the manifest digest; `bluetooth.md` loads only from verified `files[]`.
2. **Beacon duty:** a node with `carrier_policy: ble-beacon` broadcasts the K2 framing on adv channels 37/38/39 with K4 privacy timing; a node with `ble-reader` duty receives, reassembles chunks, and fetches + verifies the full manifest at the store before any content display.
3. **Handoff to the fleet:** a drone or rover that verifies a beacon's manifest may relay the pointer into the mesh (`radio.md`) as signed evidence — pointers travel, unverified content does not.
4. **Forensics:** spoof/anomaly detections append to the hash-chained forensic log (`sensors-intel.md`).

## RED surface + countermeasures

Summarized: spoofing → signed manifests + physical-layer anomaly awareness; replay → epoch/seq windows; tracking → quasi-periodic randomized scheduling and identical payloads across MAC rotation; substitution → content-hash binding and verify-at-store. The standing rule: **the beacon authenticates discovery; the store authenticates content; nothing authenticates by proximity alone.** Presence is not trust — a beacon heard over BLE is a hint, never an instruction (the ingest-time instruction firewall of digest 06 applied to radio).

## BLUE sovereignty application

- **The tap-the-marker scroll:** a passive cedar/wood touch-point (with a coin-cell BLE beacon or an NFC tag per `radio.md` K2) at a community building hands a visitor the discovery pointer to the public-teaching ember — zero infrastructure, community-owned hardware, OCAP® possession intact.
- **Festival and gathering mode:** carriers' phones become the mesh — a field of privacy-mode beacons reassembling the ember manifest among themselves, no internet, no vendor.
- **Language carriers:** the beacon can point to small audio/pronunciation fragments of Anishinaabemowin at place-names — public-teachings layer only, attributed, revocable by manifest version bump.
- **New-people note:** the beacon is a *carrier*, not an author; it never generates cultural content, only points to signed content the community has published and can recall.

## Further study (hardware path)

| Stage | Platform | Cost class | Skill |
|---|---|---|---|
| 1 | nRF52840 DK (or ESP32-C3/C6) | ~$10–40 | Advertising/GATT firmware; build the 31-byte scroll beacon; Part 15-certified module practice |
| 2 | Phone-side reader app (nRF Connect-class tools for learning) | $0 | Chunk reassembly, epoch validation, verify-at-store flow |
| 3 | nRF52840 + solar/coin-cell power budget | ~$20–40 | Advertising-interval power trade-offs; field-deployed marker beacons |
| 4 | Integration with the LoRa mesh (`radio.md`) | — | Dual-bearer ember node: BLE discovery + LoRa distribution |

## Sources

- Battery Insertion Attack (timing correlation): https://petsymposium.org/popets/2025/popets-2025-0037.php
- BlueShield spoof detection: https://pursec.cs.purdue.edu/projects/blueshield.html ; Jitter Trap: https://www.darkreading.com/cyberattacks-data-breaches/jitter-trap-tool-detect-beacons
- BLESA (BLE security): https://www.usenix.org/conference/woot20/presentation/wu ; BLE security/privacy guide: https://argenox.com/blog/bluetooth-low-energy-ble-security-privacy-a-2025-guide
- Legality: 47 CFR §15.247 (https://www.law.cornell.edu/cfr/text/47/15.247); 47 CFR §15.5; ETSI EN 300 328 [INFERENCE — verify]
- FIPS 204 (ML-DSA): https://csrc.nist.gov/pubs/fips/204/final
- Digests: research/04-spectrum-knowledge.md (primary), research/07-integration-contract.md (C2–C5)
