# emw-signals.md — Electromagnetic Waves, Spread Spectrum, and Emanations Hygiene

Module class: `.scrolls-embodiment/` — signed manifest payload (see `README.md` loader contract).
Dual mandate: **RED** (how electromagnetic emanations leak information, so the ember store can be defended) + **BLUE** (spectrum literacy — modulation, spread spectrum, SDR — as community knowledge that turns the invisible environment into something the people can read, protect, and own).

## Purpose

Radio knowledge in one discipline, two duties. First, **spectrum literacy**: what modulation, spread spectrum, and software-defined radio actually do, so a community can read its own RF environment (a waterfall plot is the modern equivalent of reading weather). Second, **emanations hygiene**: every computing device radiates unintended electromagnetic energy, and those unintentional emanations can leak processed data — the discipline codified historically as TEMPEST and now governed by NATO SDIP "Red/Black" separation. The ember store, the mesh gateway, and the drone's companion computer all radiate; this module teaches how to make them radiate nothing useful to an adversary.

Defensive-only: all side-channel content here is *awareness and hygiene* for the community's own systems. No emanation-collection technique is taught against third parties; no interception tooling is specified beyond receive-only educational platforms (RTL-SDR).

## Knowledge units

### K1. Signals fundamentals: from bits to waves (physics)

- **IQ sampling:** every real passband signal is representable as in-phase (I) and quadrature (Q) components; an SDR captures IQ pairs and everything else — FM, ADS-B, LoRa chirps — is software. This is the gateway skill: PySDR's first chapters are the community classroom.
- **Modulation families:** AM/FM (analog voice), ASK/FSK (simple telemetry, door openers), OQPSK (802.15.4), CSS (LoRa chirp spread spectrum), OFDM (Wi-Fi). Each trades data rate, robustness, and spectral footprint.
- **Spread spectrum (the key defensive concept):** DSSS, FHSS, and CSS spread energy below or across the noise floor, buying interference resilience and low power spectral density — exactly why FCC Part 15 permits higher power for spread-spectrum emitters. For the ember: spread-spectrum bearers degrade gracefully under interference; narrowband bearers fail hard.
- **Reading a waterfall:** frequency on one axis, time on the other, intensity as color. A student who can identify "Wi-Fi here, BLE there, an LoRa chirp every 30 s, a wideband burst at 3 a.m." has learned to *see* the electromagnetic territory — spectrum literacy as sovereignty skill.

**Why spread spectrum matters twice for the ember:** (1) *resilience* — an FHSS/CSS link keeps working under narrowband interference that would kill a single-channel FSK link, which is the lawful design answer to interference (channel diversity and graceful degradation — never retaliation); (2) *legality leverage* — the same physics that resists interference is what lets Part 15.247 authorize higher transmit power than narrowband devices in the same bands, so the community's compliant hardware reaches further. Teach the two together and students understand why the ember's bearers are LoRa and BLE rather than bespoke narrowband links.

**Classroom exercises (receive-only, self-owned systems only):**
1. *Waterfall sketch.* Record 30 s of the 2.4 GHz band at the community center; label every visible occupant (Wi-Fi channel, BLE adverts on 37/38/39, microwave-oven interference rise). Deliverable: an annotated waterfall.
2. *Chirp spotting.* Tune an RTL-SDR to a known community LoRa node's sub-band and identify chirp spread-spectrum signatures by eye. Deliverable: chirp count vs node's advertised duty.
3. *Self-audit sweep.* Per K3: observe the Red zone from untrusted positions, log detectability, propose a distance/shielding fix, re-sweep. Deliverable: before/after detectability note for the spectrum log.
4. *Fading lesson.* Carry a node along the same path on a dry day and in heavy rain/foliage; compare received signal strength and mesh latency against the Friis prediction from `radio.md` K1. Deliverable: measured vs predicted link margin.

### K2. EM side-channels: how machines leak (security — RED core)

- **The physics of leakage:** digital logic, displays, cables, keyboards, and power rails all radiate or conduct unintended signals correlated with processed data. A display cable is a low-power transmitter of the screen; a power line carries switching noise correlated with computation. This is the TEMPEST problem — codename from US programs, now governed by NATO SDIP Red/Black separation doctrine: *Red* equipment handles plaintext/critical data; *Black* equipment connects to the outside world; the two are separated physically, electrically, and spatially.
- **Modern state of the art (2025–26):** deep-learning-assisted side-channel analysis recovering ECDSA keys from smartphone SoCs; blind SCA without device knowledge; **TEMPEST-LoRa (CCS '25)** demonstrates commodity LoRa gateways receiving covert EM emanations from air-gapped machines. The lesson generalizes: **your mesh gateways are also listening devices if the network is untrusted.**
- **The scroll-specific threat:** the ember store is an air-gapped or semi-isolated machine holding the cultural corpus. Its emanations — display, keyboard, power — are an exfiltration channel that no amount of software hardening closes, because the leak is analog physics.

### K3. Emanations hygiene checklist (defensive — BLUE)

A practical Red/Black checklist for the ember store and its operators:

| Zone | Practice |
|---|---|
| Physical separation | Red (data-handling) equipment in a room away from exterior walls and shared walls; Black (network/gateway) equipment in a separate space; no cables crossing zones |
| Distance | Attenuation is cheap physics: every doubling of distance reduces interceptable signal meaningfully; place the ember store away from parking, windows, shared structures [INFERENCE: general principle, site-specific survey needed] |

| Cabling | Shielded display/keyboard cables; unshielded cable is an antenna; ferrites on leads leaving the Red zone |
| Power | Filtered/isolated power for Red equipment; avoid sharing power circuits with outside-world devices |
| Peripherals | No wireless keyboards/mice in the Red zone (they are transmitters of keystrokes); no phones in the Red room during sensitive work |
| Gateways | Mesh/LoRa/Wi-Fi gateways are *Black* — assume any gateway not under community physical control is an untrusted collection point; the ember store never trusts a gateway with plaintext |
| Crypto hygiene | ML-DSA-65 signing operations on the Red machine; signing seeds stay in the PQC bundle (AES-256-GCM + ML-KEM-768 wrapped, per contract C2) — but note modern SCA recovers keys *from computation*, so the Red zone protects the computation, not just the key at rest |
| Verification | A receive-only sweep with an RTL-SDR around the Red zone as a *self-audit* — what can you hear from the parking lot? The community runs the audit on itself, never on others |

**A brief history, because it explains the doctrine.** TEMPEST began as a US government codename for the study of compromising emanations; the classification and countermeasure doctrine now lives under NATO SDIP (and national equivalents), with "Red/Black" separation as its practical core. Decades of government practice distilled into rules a community can adopt directly: separate the machines that handle secrets from the machines that talk to the world, control the cables and power between them, and assume anything that radiates can be read at a distance you did not intend. The 2025–26 research wave (ML-assisted SCA, TEMPEST-LoRa) did not invent the threat — it lowered the cost of exploiting it, which is precisely why the hygiene belongs in a community curriculum now.

The pairing with crypto is the design insight: FIPS 203/204 protect the ember *mathematically*; Red/Black discipline protects it *physically*. A signed archive whose signing ceremony happens next to a window radiating to a parking lot has neither.

**A little attenuation math makes the hygiene concrete** [INFERENCE: order-of-magnitude teaching numbers, not deployment guarantees]:

- Free-space path loss doubles down (~6 dB) every doubling of distance; wall/foliage losses at 2.4 GHz add roughly 3–15 dB per obstruction depending on material. Moving the ember store one interior wall and 10 m further from the nearest public space is worth tens of dB of attenuation — the cheapest "encryption" there is.
- Shielding and ferrites each contribute single-digit to low-tens of dB on leaking cable modes; combined with distance they push an interceptable emanation toward or below the environmental noise floor.
- The self-audit sweep operationalizes this: observe from the parking lot with an RTL-SDR; if a synchronized change in the broadband noise floor is visible when the Red machine scrolls or computes, the zone is leaking at a detectable level — add distance, shielding, or both, and re-sweep. The metric is *detectability from untrusted positions*, not any absolute field-strength threshold.

### K4. SDR in the program: education and self-audit only

- **Receive-only platforms** (RTL-SDR v3/v4, ~$30–40) are the program's instruments: waterfall literacy, FM/ADS-B reception, LoRa decode via gr-lora, and the self-audit sweep of K3.
- **HackRF-class transmit-capable SDRs** are for learning flowgraphs *in lab isolation*: transmit only into dummy loads, or with licenses, or under Part 15-certified test conditions. Never against shared spectrum; never against third-party systems.
- **What this module does not teach:** interception of others' communications, key recovery against third-party devices, covert-channel construction for exfiltration, or any technique aimed at systems the community does not own. Receive-only scanning is generally lawful, but using/decrypting others' traffic can violate ECPA (18 U.S.C. §2511 [INFERENCE — consult counsel]) — and the ethical line is drawn well inside the legal one.

### K5. Legality (relevant rows; full table in `radio.md` K6)

| Activity | Status | Citation |
|---|---|---|
| Receive-only listening on ISM bands | Generally lawful | 47 CFR §15.5 framework |
| Using/decrypting others' traffic | Can violate ECPA | 18 U.S.C. §2511 [INFERENCE — consult counsel] |
| Cellular interception | Prohibited | 18 U.S.C. §2511 [INFERENCE] |
| Transmitting on non-certified equipment / non-ISM bands | Prohibited | 47 CFR §15.5, §301 |
| Jamming / deliberate interference (including "test" jamming) | **Prohibited absolutely** | 47 U.S.C. §333; 18 U.S.C. §1367 [INFERENCE from statute titles] |

## Embodiment integration

A robot, drone, or fixed node consumes this module via the signed manifest (`README.md` flow):

1. **Verify:** manifest.sig (ML-DSA-65, FIPS 204) over the manifest digest; `emw-signals.md` loads only from verified `files[]`.
2. **Design-time:** `carrier_policy: red-zone-aware` nodes (the ember store's companion computer, the signing station) refuse network interfaces that would bridge Red and Black zones; the module is loaded as build-time guidance for the hardware/firmware profile.
3. **Field-time:** a drone or rover performing spectrum self-audits (`sensors-intel.md`) logs its *own* emanations posture as part of deployment checks — antenna placement, gateway trust classification, Red/Black zone confirmation.
4. **Forensics:** any observed interference anomaly (sudden wideband noise, unknown bursts) is logged as signed evidence for the community spectrum log — detection and documentation, never response-in-kind.

## RED surface + countermeasures

| RED exposure | What leaks | Countermeasure |
|---|---|---|
| Display/cable emanations | On-screen content (manifests, keys being imported) | Shielded cables; Red-zone separation; distance from windows |
| Power-rail / switching noise | Computation correlates; modern SCA recovers crypto keys from SoCs | Power filtering; signing on hardened, spatially protected machines; keep signing seeds in the PQC bundle |
| Wireless peripherals | Keystrokes broadcast | Wired-only peripherals in Red zones |
| Untrusted gateways | Every packet on the channel | End-to-end channel keys held by the community; gateways are Black, never trusted with plaintext |
| TEMPEST-LoRa class covert channels | Air-gapped machines leaking via emanations decodable by commodity gateways | Red/Black checklist (K3); self-audit sweeps; physical control of one's own gateway siting |
| Spectrum observation of the community | An adversary mapping who transmits where and when | For carriers: randomized scheduling and MAC rotation per `bluetooth.md` K4; for fixed infra: nothing to hide in content (signed public layer), but timing/traffic patterns still minimized |

## BLUE sovereignty application

- **Spectrum literacy as cultural infrastructure:** teaching the community to read waterfalls is teaching territorial awareness of the electromagnetic estate — the same land-based instinct applied to a new territory. A community that can see its spectrum is not deaf on it.
- **The self-audit as ceremony of care:** running the Red/Black checklist and the RTL-SDR sweep before the ember store goes live is a practical ritual of responsibility — the Seven Grandfather Teachings' *responsibility* and *honesty* applied to infrastructure.
- **Gateway siting authority:** the community decides where its gateways sit, who holds their keys, and what they may carry — OCAP® *possession* extended to RF infrastructure.
- **Teaching path (from digest 04):** RTL-SDR + PySDR (receive-only) → nRF52/Heltec practice → HackRF in lab isolation, with the guardrails that keep students lawful at every stage.

### K6. Verification exercises for the hygiene layer

Each exercise produces an artifact for the community spectrum log, uses receive-only tools on self-owned systems, and doubles as training for new carriers:

1. **Red/Black walk-through.** With the store powered down, physically trace every cable and radio path leaving the Red room; mark each as Red, Black, or *bridge* (a defect). Deliverable: annotated zone map; count of bridges fixed.
2. **Peripheral inventory.** Enumerate every wireless device (keyboards, mice, headphones, smart displays) in the Red zone; remove or replace with wired equivalents. Deliverable: signed inventory with zero wireless entries.
3. **Detectability sweep (before/after).** Run the RTL-SDR sweep from the nearest untrusted position (parking lot, adjacent unit); log whether Red-machine activity is observable; apply one attenuation fix; re-sweep. Deliverable: before/after pair of observations.
4. **Gateway trust audit.** For each mesh gateway: who holds its channel keys, who controls its power and siting, and what happens to its buffers if it is seized? Any gateway whose answers include a vendor or third party is reclassified Black. Deliverable: gateway trust register.
5. **Signing-ceremony rehearsal.** Run the full manifest sign flow (C2) inside the Red zone under the checklist, timing the ceremony and noting any operational friction that tempts operators to shortcut hygiene (an open door, a laptop carried in). Deliverable: rehearsal notes; checklist amendments.

## Further study

- PySDR: https://pysdr.org/ ; Ossmann SDR video series: https://greatscottgadgets.com/sdr/
- TEMPEST-LoRa (CCS '25): https://arxiv.org/html/2506.21069v1
- Blind SCA (USENIX Security '25): https://www.usenix.org/conference/usenixsecurity25/presentation/rezaeezade ; SoC SCA: https://arxiv.org/abs/2512.07292
- TEMPEST background: https://en.wikipedia.org/wiki/Tempest_(codename) ; Wyden memo on TEMPEST: https://www.wyden.senate.gov/download/memo_-tempest
- LoRa security analysis with RTL-SDR: https://www.rtl-sdr.com/evaluating-lorawan-security-with-an-rtl-sdr/
- Digests: research/04-spectrum-knowledge.md (primary), research/07-integration-contract.md (C2, C5)

## Sources

As listed under Further study, plus 47 CFR §15.5/§301, 47 U.S.C. §333, 18 U.S.C. §2511, ETSI EN 300 220/300 328 as cited in the tables.
