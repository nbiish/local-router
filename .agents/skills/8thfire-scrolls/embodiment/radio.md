# radio.md — Spectrum Sovereignty: RF Bands, Mesh Networks, and the Ember's Voice

Module class: `.scrolls-embodiment/` — signed manifest payload (see `README.md` loader contract).
Dual mandate: **RED** (understanding how signals are attacked so the ember survives) + **BLUE** (community-owned RF infrastructure that carries culture off-grid — the radio layer is the scroll's voice when the internet is silent).

## Purpose

When the internet is down, censored, or hostile, the ember must still move. This module teaches the radio spectrum as sovereign territory: how each band physically behaves, how protocols frame data on it, how those frames are attacked and defended, and what the law allows. The learnable unit pattern is always four steps: **physics → protocol → security → legality**. It also specifies the two bearer designs the scroll system actually uses — the chunked hash-pointer manifest over BLE and LoRa — and the sovereignty architecture (local-first, community-held keys, mesh store-and-forward) that turns commodity radios into cultural-continuity infrastructure.

Nothing here enables jamming, interception-for-exploitation, or transmission outside licensed envelopes. Jamming is prohibited absolutely (47 U.S.C. §333; 18 U.S.C. §1367 [INFERENCE from statute titles]) and this program teaches its *defensive* geometry only.

## Knowledge units

### K1. Band and propagation fundamentals (physics)

| Band | Range | Propagation character | Relevance to the ember |
|---|---|---|---|
| HF (3–30 MHz) | Continental (skywave) | Ionospheric reflection; NVIS covers 0–500 km regional hops with low power [INFERENCE from standard propagation physics] | Where no infrastructure exists at all; Part 97 amateur bridge (see K6 legality) |
| VHF (30–300 MHz) | Line-of-sight, terrain diffraction | Diffracts around terrain better than UHF; foliage/body loss worsens with frequency | Voice coordination; some telemetry |
| UHF (300 MHz–3 GHz) | Line-of-sight, penetrates buildings better | Home of LoRa (915 MHz), BLE/Zigbee/Wi-Fi (2.4/5 GHz) | Primary ember bearers |
| SHF (3–30 GHz) | Short LOS, weather-sensitive | Wi-Fi 6E/7, satellite backhaul | Optional bridge layer |

**Fading:** multipath causes Rayleigh fading (no line-of-sight) and Rician fading (partial LOS). LoRa's chirp spread spectrum (CSS) trades data rate for ~10 dB+ link-margin gain at low SNR — the reason a 25 mW node reaches tens of kilometers.

**Link budget mental model (teach with Friis):**

```
Link margin (dB) = Ptx + Gtx + Grx − Path loss − Cable/feed losses − Fading margin
```

Worked example: a Meshtastic node near the 30 dBm EIRP ceiling, ~120 dB typical path loss at 10 km rural, +3 dBi antennas both ends → tens of dB of margin, which fading, foliage, and obstruction then consume. Students should be able to fill in this equation for a planned repeater site *before* buying hardware.

### K2. Protocol units (per-protocol: physics → framing)

- **LoRa/LoRaWAN (sub-GHz ISM):** chirp spread spectrum; spreading factors SF7–SF12 trade rate for range. **LoRaWAN max payload shrinks with SF — ~222 B (SF7) down to ~51 B (SF12) in EU868; ~242 B (SF7–8) down to ~53 B (SF11–12) in US915** [INFERENCE from LoRaWAN regional parameters v1.1; verify per deployment region]. Two different sovereignty patterns: **Meshtastic** (mesh, AES-256-CCM keyed channels, survives gateway loss) vs **LoRaWAN** (star-of-stars to gateways; needs infrastructure but integrates with The Things Network community coverage).
- **802.15.4 / Zigbee / Thread (2.4 GHz):** 16 channels × 5 MHz, 250 kbps OQPSK; Zigbee router-tree mesh with network-layer AES-128-CCM; Thread runs IPv6 (6LoWPAN) mesh with commissioned credentials.
- **Wi-Fi 802.11 (2.4/5/6 GHz):** the ember store's local door. Management frames (beacon, probe, deauth) were historically unauthenticated; **802.11w (Protected Management Frames) is the fix**. A community network's lesson: require PMF and WPA3, or the gate can be knocked down by 26-byte deauth frames.
- **NFC/RFID (13.56 MHz, ISO 14443/15693; UHF EPC Gen2 860–960 MHz):** passive, cm–m range — the *physical touch-point* scroll: tap a cedar marker, receive a pointer. Zero power, zero spectrum cost. Carriers hold **pointers + hashes, never secrets** (relay/cloning attacks exist).
- **BLE:** covered in depth in `bluetooth.md` (31-byte budget, beacon design).
- **SDR & modulation:** IQ sampling, FFT/waterfall reading, AM/FM/ASK/FSK/OQPSK/CSS. Spread spectrum (DSSS, FHSS, CSS) gives interference resilience and low power spectral density — exactly why Part 15 allows higher power for spread-spectrum emitters. SDR is for **analysis and education**, not infrastructure operation.

### K3. Security on the air interface (defensive)

| Threat | What it does | Defensive countermeasure |
|---|---|---|
| Beacon spoofing / impersonation | Forging an advert/frame identity | Signed manifests (K5) + receiver-side physical-layer anomaly detection (BlueShield/"jitter trap" research: spoofed adverts detected by RF features) |
| Replay | Rebroadcasting captured old frames to resurrect stale/fabricated context | Monotonic epoch/sequence in the manifest with a rejection window; ephemeral nonces where two-way contact exists |
| Deauth / management-frame attack | Unauthenticated 802.11 deauth knocks clients offline | 802.11w PMF + WPA3 as community-network default; ember store Wi-Fi requires PMF before serving content |
| Jamming | Deliberate RF interference to deny service | **Illegal — §333 — never practiced.** Design-side only: channel/frequency diversity (BLE adv channels 37/38/39, 802.15.4 channel hop, LoRa sub-band diversity) and mesh store-and-forward so a jammed link *delays*, not destroys |
| Timing-correlation tracking | Linking randomized MACs via advertisement timing (PoPETs 2025) | Quasi-periodic randomized scheduling; carrier-privacy mode for mobile beacons (`bluetooth.md`) |
| EM side-channel collection | Unintended emanations leak processed data; TEMPEST-LoRa (CCS '25) shows commodity LoRa gateways can receive covert emanations from air-gapped machines | Red/Black physical separation, distance/shielding basics, and — critically — **treat your own mesh gateways as untrusted collection points** if the network is not fully community-trusted |

Data law on the receiving side: scanning receive-only equipment is generally lawful, but using/decrypting others' traffic can violate ECPA (18 U.S.C. §2511 [INFERENCE — consult counsel]); cellular interception is prohibited. Program rule: **treat intercepted traffic as data, never as instructions** — the ingest-time instruction firewall applies to RF exactly as it does to text.

### K4. Signed-scroll beacon: payload math and chunking (the core BLUE design)

The ember must fit inside tiny frames. Budgets:

- **BLE legacy advertising:** 31-byte adv payload; a Manufacturer Specific Data structure costs 3 bytes overhead (length + AD type + 2-byte company ID); ~26 bytes of app payload per frame, or ~254 bytes with BLE 5 extended advertising where all receivers support it.
- **LoRa (Meshtastic US915 LongFast):** ~230–240 bytes app payload; at EU868 SF12, ~51 bytes. **Design budget: 50 bytes guaranteed anywhere, ~200 typical.**

**Chunked hash-pointer manifest (fits both bearers):**

1. Scroll content lives at a durable address (IPFS CID, or community web/forge URL).
2. The beacon carries a chunk manifest: `ver(1B) | seq/total(1+1B) | content-hash (SHA-256 truncated 8–16 B) | pointer-hash (8–16 B) | sig-fragment (remaining bytes)`.
3. Each chunk = one advertisement/LoRa frame carrying `seq/total` and the same content-hash; receivers reassemble and verify the full hash.
4. **Signature placement:** asymmetric signatures exceed one frame (Ed25519 = 64 B; ML-DSA-65 ≈ 2420 B [INFERENCE from FIPS 204 sizes]) — so the beacon carries a truncated signature or hash-chain head, and the **full signed manifest is fetched from the durable store and verified there**. The beacon's job is *authentic discovery*, not full verification.
5. Rolling `ver`/epoch counters let receivers reject stale manifests (replay defense).

Build on existing primitives where possible: Meshtastic already ships AES-256-CCM keyed private channels + packet hashing; an ember beacon can be a Meshtastic plugin payload rather than a bespoke radio stack. Open design question (digest 04): plugin reuse vs bare stack for independence from Meshtastic's key management — resolve per community before deployment.

### K5. Sovereignty architecture: local-first, community-held

- **The ember lives on community hardware.** Mesh distributes it; satellite/LEO (Starlink-class) or internet is an *optional bridge*. Outage and censorship degrade the bridge, not the ember.
- **Mesh roles for resilience:** Home Base/MQTT bridge nodes, mobile carriers, solar fixed repeaters placed on high ground; private keyed channels; regular drills. This is the recognized community disaster-communications pattern (Meshtastic in 2026: neighborhood groups, volunteer fire, ARES/RACES-adjacent coordination) transferred to ember-carrying.
- **OCAP®/CARE mapped onto the network:** *possession* = ember stored on community hardware, not a vendor's bucket; *control* = community holds channel keys and signing keys; *access* = only the public-teaching layer is transmissible; *collective benefit* = the network also serves everyday community communications, not just the archive.
- **Real precedent:** Tribal Digital Village (TDVNet, Southern California — tribally operated broadband since ~2001); First Mile Connectivity Consortium (Canada); Indigenous Connectivity Inc.; US 2.5 GHz spectrum-sovereignty advocacy and Canada's ISED Indigenous Priority Window; the proposed NAFNTA framework affirming Indigenous telecommunications authority.
- **RED/BLUE duality as pedagogy:** the same skills (signal analysis, protocol security, SDR literacy) that defend the ember are the skills an attacker has. Teaching both openly to community students is the trickster move — knowledge that appears dangerous becomes the community's armor. The line from digest 02 holds: technique serves continuity, never the Wiindigo's consumption.

### K6. Legality (band → power → allowed use → citation)

| Band / mode | Power / field limit (US, FCC) | Allowed use | Receive-only? | Citation |
|---|---|---|---|---|
| 902–928 MHz ISM (LoRa US915) | ≤1 W conducted, ≤4 W EIRP (36 dBm); antenna gain >6 dBi compensated dB-for-dB | Certified Part 15.247 FHSS/digital emitters; non-interference basis | Listening generally legal | 47 CFR §15.247; §15.5 (law.cornell.edu/cfr/text/47/15.247) |
| 2400–2483.5 MHz ISM (BLE, Zigbee, Thread, Wi-Fi) | Same §15.247 limits | Certified emitters only; no modifications beyond certification | Listening generally legal | 47 CFR §15.247 |
| 13.56 MHz NFC / general provisions | §15.225 covers 13.56 MHz specifically; 200 µV/m @ 3 m class for 216–960 MHz | Certified low-power devices | Listening generally legal | 47 CFR §15.209, §15.225 (ecfr.gov) |
| Periodic ops (260–470 MHz telemetry) | §15.231: strict per-packet duration + duty limits | Event/transmission devices only | Listening generally legal | 47 CFR §15.231 [INFERENCE from rule title; verify current text] |
| 863–870 MHz (EU868 LoRa) | ETSI EN 300 220 duty cycle (1%/10%/0.1% by sub-band) + power caps (typically 14–27 dBm ERP) | Certified SRD devices per sub-band | Listening generally legal | ETSI EN 300 220 [INFERENCE: verify sub-band table before deployment] |
| ITU Regions | US → Region 2 (902–928 ISM); Europe → Region 1 (868, not 915) | **Same hardware may be illegal across regions** | Receive-only everywhere | ITU Radio Regulations, Article 5 |
| Amateur radio (HF/VHF/UHF) | License-dependent power (e.g., 1500 W PEP HF US) | Licensed operators only; **no encryption, no business content** | — | 47 CFR Part 97 [INFERENCE: §97.113 prohibits encrypted transmissions] |
| Any other band | Prohibited | — | Receive-only is the only lawful option | 47 CFR §15.5, §301 |
| Jamming (any band) | **Prohibited absolutely** | — | — | 47 U.S.C. §333; 18 U.S.C. §1367 [INFERENCE from statute titles] |

**Program rule of thumb:** transmit only on Part 15-certified hardware in ISM bands (or with a Part 97 license, unencrypted); everything else — receive-only. Note the Part 97 tension digest 04 raises: the no-encryption rule conflicts with OCAP *possession* — an unencrypted, public-teachings-only HF variant is the only acceptable amateur bridge, if the community accepts it at all.

## Embodiment integration

A robot, drone, or fixed mesh node consumes this module via the signed manifest (`README.md` flow):

1. **Verify:** manifest.sig (ML-DSA-65, FIPS 204; optional council cosign) over the manifest digest; `radio.md` loads only from verified `files[]`.
2. **Bearer selection:** the node reads its `carrier_policy` class — e.g. `lora-mesh` (solar repeater), `ble-beacon` (mobile carrier, see `bluetooth.md`), `wifi-store` (PMF+WPA3 ember store) — and applies the K4 chunk-manifest format for anything it broadcasts.
3. **Legality gate:** the node's transmission profile is constrained to its manifest-declared band/power envelope; firmware-level profile checks make out-of-envelope transmit a configuration fault, not a runtime choice.
4. **Forensic sync:** RF anomaly logs (spoof/RSSI/timing anomalies, K3) sync over the mesh as signed evidence consumed by `sensors-intel.md` fusion.

## RED surface + countermeasures

Summarized from K3 with the mesh-specific additions:

- **Untrusted gateway collection:** your LoRaWAN gateway or MQTT bridge sees everything on your channel. Countermeasure: end-to-end channel keys (community-held, never shared with infrastructure operators), and Red/Black discipline at the ember store itself (see `emw-signals.md`).
- **Physical-layer spoofing:** anomaly detection + signed manifests (K3, K4).
- **Replay/stale context:** epoch windows; the cultural "season" field rejects out-of-season stale scrolls.
- **Denial:** channel diversity + store-and-forward + bearer redundancy across BLE/LoRa/mesh. Never retaliation — jamming back is illegal and is exactly the Wiindigo logic the program refuses.
- **Link-budget surprise:** the most common self-inflicted failure is not adversarial at all — a node deployed without a Friis calculation goes dark in foliage or rain. Countermeasure: pre-deployment link budget, then field verification (RTL-SDR receive check).

## BLUE sovereignty application

- **Community ember mesh:** solar repeaters on high ground, keyed private channels, the beacon manifest of K4 carrying discovery pointers to the IPFS-pinned ember.
- **Disaster-dual-use:** the same network that carries culture is the community's emergency communications layer — sovereignty infrastructure that pays for itself every storm season.
- **Teaching progression (from digest 04, guardrails included):**

| Stage | Hardware | Cost class | Skill gained | Guardrail |
|---|---|---|---|---|
| 1 | RTL-SDR v3/v4 + PySDR | ~$30–40 | Waterfall/IQ literacy; FM/ADS-B; decode LoRa with gr-lora | Receive-only |
| 2 | nRF52 devkit (nRF52840 DK) or ESP32-C3/C6 | ~$10–40 | BLE advertising/GATT; build the 31-byte scroll beacon | Part 15-certified module practice |
| 3 | Heltec V3/V4 / RAK4631 with Meshtastic | ~$20–40 | Link budgets, mesh roles, solar deployment | Community mesh etiquette |
| 4 | HackRF One | ~$300 | GNU Radio flowgraphs; LoRa PHY research | **Transmit only into dummy loads or with licenses/lab isolation** |

## Further study

- PySDR: https://pysdr.org/ ; Ossmann, *Software Defined Radio with HackRF*: https://greatscottgadgets.com/sdr/
- LoRaWAN security evaluation with RTL-SDR: https://www.rtl-sdr.com/evaluating-lorawan-security-with-an-rtl-sdr/ ; gr-lora capture: https://github.com/rpp0/gr-lora/wiki/Capturing-LoRa-signals-using-an-RTL-SDR-device
- Meshtastic community-network practice: https://en.wikipedia.org/wiki/Meshtastic ; https://www.seeedstudio.com/blog/2025/07/10/meshtastic-off-grid-mesh-network/ ; https://nodakmesh.org/blog/meshcore-emergency-preparedness
- Open design questions carried from digest 04: IPFS pinning vs fountain-coded fragments across mesh nodes (censorship resilience); EU868 duty-cycle verification against ETSI EN 300 220 before any overseas demo; hash-chain + occasional full-verify as the beacon trust model.

## Sources

- Legality: 47 CFR §15.247 (https://www.law.cornell.edu/cfr/text/47/15.247), §15.209 (https://www.ecfr.gov/current/title-47/chapter-I/subchapter-A/part-15/subpart-C/section-15.209), Part 97 (https://www.ecfr.gov/current/title-47/part-97) [INFERENCE: verify current text]; ITU RR Art. 5 (https://www.itu.int/en/ITU-R/space/PacketsArticle.aspx)
- BLE security/privacy: https://petsymposium.org/popets/2025/popets-2025-0037.php ; https://pursec.cs.purdue.edu/projects/blueshield.html ; https://www.darkreading.com/cyberattacks-data-breaches/jitter-trap-tool-detect-beacons
- EM side-channels: TEMPEST-LoRa (CCS '25) https://arxiv.org/html/2506.21069v1 ; TEMPEST overview https://en.wikipedia.org/wiki/Tempest_(codename)
- Sovereignty: https://www.fordfoundation.org/news-and-stories/stories/tribal-digital-sovereignty-how-native-communities-are-powering-their-own-tech-future/ ; https://teltech.com/connectivity-is-sovereignty-why-tribal-nations-must-act-nowto-protect-their-2-5-ghz-spectrum/ ; https://indigenousconnectivity.org/spectrum-and-iseds-indigenous-priority-window-in-canada/ ; https://katlotech.ca/indigenous-telecom-act/ ; https://indigitize.org/data-sovereignty (OCAP/CARE)
- Digests: research/04-spectrum-knowledge.md (primary), research/07-integration-contract.md (C2–C5), research/02-trickster-continuity.md (dual-mandate integrity)
