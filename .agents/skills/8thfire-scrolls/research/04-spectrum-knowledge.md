# Spectrum Knowledge for Embodied Cultural-Continuity Systems (04)

## Scope
**Researched:** RF fundamentals (HF/VHF/UHF propagation, fading, link budgets), BLE advertising/GATT/mesh, 802.15.4/Thread/Zigbee, LoRa/LoRaWAN, 802.11 management frames, NFC/RFID, modulation/spread-spectrum/SDR concepts, EM side-channels (TEMPEST, power/EM emanations), off-grid mesh sovereignty (Meshtastic, community LTE), and US/EU spectrum legality (FCC Part 15/97, ITU regions, ETSI).
**Excluded:** `.scrolls*` payload content (quarantined to ScrollAnalyst); military SIGINT technique detail; anything enabling jamming, spoofing, or interception — this digest is defensive and educational only.
**Orchestrator mandate woven in:** spectrum work is treated as a two-sided discipline — RED (adversarial continuity: understanding how signals are attacked so the ember survives) and BLUE (ember-carrier: community-owned infrastructure that carries culture off-grid). The scroll is Nanaboozhoo's digital embodiment; the radio layer is its voice when the internet is silent.

## Findings

### Band & propagation fundamentals (physics → protocol → security → legality structure)
- **Teachable unit pattern (used for every module):** (1) *physics* — what the band does physically; (2) *protocol* — how data is framed; (3) *security* — how it is attacked and defended; (4) *legality* — what may be transmitted, what is receive-only. One unit per band/protocol, ordered below.
- **HF (3–30 MHz):** skywave ionospheric reflection enables continental reach with low power; NVIS (near-vertical incidence) covers 0–500 km regional hops — useful where no infrastructure exists at all. [INFERENCE from standard propagation physics]
- **VHF (30–300 MHz) / UHF (300 MHz–3 GHz):** line-of-sight dominant; UHF penetrates buildings better, VHF diffracts around terrain better; foliage/body absorption worsens with frequency. LoRa (915 MHz), BLE/Zigbee/Wi-Fi (2.4/5 GHz) all sit in UHF/SHF.
- **Fading:** multipath causes Rayleigh (no line-of-sight) and Rician (partial LOS) fading; LoRa chirp spread spectrum trades data rate for ~10 dB+ link-margin gain at low SNR — the reason a 25 mW node reaches tens of km.
- **Link budget mental model (teach with Friis):** `Link margin (dB) = Ptx + Gtx + Grx − Path loss − Cable/feed losses − Fading margin`. Worked example: Meshtastic node 30 dBm EIRP ceiling − typical path loss at 10 km rural (~120 dB) + 3 dBi antennas → tens of dB margin, which fading and obstruction consume.

### Per-protocol units (physics → protocol → security → legality)
- **BLE (2.4 GHz):** 40 channels × 2 MHz, 3 advertising channels (37/38/39); legacy adv payload **31 bytes** (255 with extended adv); GATT for connected profiles; BLE Mesh floods on adv bearers. Security: LE Secure Connections (ECDH), MAC randomization; 2025 research shows timing leaks defeat MAC randomization (see Techniques).
- **802.15.4 / Zigbee / Thread (2.4 GHz):** 16 channels × 5 MHz, 250 kbps OQPSK, mesh via Zigbee router tree or Thread's IPv6 (6LoWPAN) mesh; Zigbee offers network-layer AES-128-CCM; Thread requires commissioned credentials. Legality: Part 15.247/15.249-certified radios only.
- **LoRa/LoRaWAN (sub-GHz ISM):** chirp spread spectrum; spreading factors SF7–SF12 trade rate for range; **LoRaWAN max payload shrinks with SF — ~222 B (SF7) down to ~51 B (SF12) in EU868, ~242 B (SF7–8) to ~53 B (SF11–12) in US915** [INFERENCE from LoRaWAN regional parameters v1.1 tables; verify per deployment region]. Meshtastic (mesh, AES-256-CCM channel keys) vs LoRaWAN (star-of-stars to gateways) are different sovereignty patterns: mesh survives gateway loss; LoRaWAN needs infrastructure but integrates with The Things Network community coverage.
- **Wi-Fi 802.11 (2.4/5/6 GHz):** management frames (beacon, probe, deauth) were historically unauthenticated — **802.11w (Protected Management Frames) is the fix**; a community network's lesson is: require PMF and WPA3 so the "gate" to the ember store can't be knocked down by 26-byte deauth frames. [INFERENCE: PMF/WPA3 as default for community infra]
- **NFC/RFID (13.56 MHz, ISO 14443/15693; UHF RFID EPC Gen2 860–960 MHz):** passive, cm–m range; good for *physical touch-point* scrolls (tap a cedar marker → receive scroll pointer) with zero power and zero spectrum cost; security: relay/cloning attacks, so NFC carriers should hold pointers + hashes, never secrets.
- **SDR & modulation concepts:** IQ sampling, FFT/waterfall, AM/FM/ASK/FSK/OQPSK/CSS; spread spectrum (DSSS, FHSS, CSS) gives interference resilience and low power spectral density — exactly why Part 15 allows higher power for spread-spectrum emitters. SDR is for **analysis/education**, not infrastructure operation.
- **EM side-channels (TEMPEST / SCA):** unintentional emanations (display cables, keyboards, chip power rails) leak processed data; codename TEMPEST, now governed by NATO SDIP "Red/Black" separation. Modern SOTA (2025–26): deep-learning-assisted SCA recovering ECDSA keys from smartphone SoCs; **TEMPEST-LoRa (CCS '25)** shows commodity LoRa gateways can receive covert EM emanations from air-gapped machines — defensive relevance: *your mesh gateways are also listening devices if the network is untrusted*; air-gapped ember stores need Red/Black separation too.
- **Satellite + mesh layering:** Starlink-class LEO backhaul bridges local mesh to the world; the sovereignty pattern is **local-first**: the ember (cultural corpus) lives on community hardware, mesh distributes it, satellite/internet is an optional bridge — outage and censorship degrade the bridge, not the ember.

### Sovereignty framing: off-grid mesh as cultural-continuity infrastructure
- Meshtastic in 2026 is a recognized community disaster-communication layer: neighborhood groups, volunteer fire departments, and ARES/RACES-adjacent volunteer coordination use it as last-mile resilience; best practice = role-based nodes (Home Base/MQTT bridge, mobile, solar fixed repeater), high-ground repeater placement, private keyed channels, and regular drills — all directly transferable to ember-carrying networks (seeedstudio.com; nodakmesh.org; heartlandemergencypreparedness.com; Wikipedia).
- Real precedent for community-owned sovereignty networks: **Tribal Digital Village (TDVNet)**, Southern California — tribally operated broadband serving households since ~2001; **First Mile Connectivity Consortium** (Canada); **Indigenous Connectivity Inc.**; spectrum-sovereignty advocacy around the US 2.5 GHz band and Canada's ISED Indigenous Priority Window; proposed **NAFNTA** framework affirming Indigenous telecommunications authority (fordfoundation.org; teltech.com; indigenousconnectivity.org; katlotech.ca).
- Governance frameworks for the data itself: **OCAP** (Ownership, Control, Access, Possession — First Nations Information Governance Centre) and the **CARE principles** map cleanly onto mesh design: *possession* = ember stored on community hardware; *control* = community holds channel keys and signing keys, not a vendor.
- **RED/BLUE duality:** the same skills (signal analysis, protocol exploitation, SDR) that a defender needs to protect the ember are the skills an attacker has; teaching both openly to community students is the trickster move — knowledge that appears dangerous becomes the community's armor.

### Signed-scroll beacon: payload-size math and chunking design
- **BLE legacy advertising:** 31-byte adv payload. A Manufacturer Specific Data structure costs 3 bytes overhead (length + AD type + 2-byte company ID) + content. An Eddystone-URL frame fits ~17 URL characters in 26 bytes. **Design budget for a scroll beacon: ~26 bytes of app payload per legacy advertisement** (iBeacon-like framing), or up to ~254-byte app payload using BLE 5 extended advertising where all receivers support it.
- **LoRa:** with Meshtastic's default US915 LongFast settings the app payload is ~230–240 bytes; at slowest EU868 SF12 it is ~51 bytes. **Design budget: 50 bytes guaranteed anywhere, ~200 bytes typical.**
- **Chunking + hash-pointer design (defensive, fits both bearers):**
  1. Scroll content lives at a durable address (IPFS CID, or community web/forge URL).
  2. Beacon carries a **manifest**: `ver(1B) | seq/total(1+1B) | content-hash (SHA-256 truncated 8–16 B) | pointer-hash (8–16 B) | sig-fragment (remaining bytes)`.
  3. Each chunk = 1 advertisement/LoRa frame with `seq/total` and the same content-hash; receivers reassemble and verify the full hash.
  4. **Signature placement:** asymmetric signatures are too big for one frame (Ed25519 = 64 B; ML-DSA-65 = ~2420 B [INFERENCE from FIPS 204 sizes]) — so the beacon carries a **truncated signature or hash-chain head**, and the full signed manifest is fetched from IPFS/gateway and verified there. The beacon's job is *authentic discovery*, not full verification. [INFERENCE: design recommendation]
  5. Rolling `ver`/epoch counters let receivers reject stale manifests (replay defense, see Techniques).
- Meshtastic already ships the primitive to build on: AES-256-CCM keyed private channels + packet hashing; an ember beacon can be a Meshtastic "custom" or telemetry plugin payload rather than a bespoke radio stack.

### Legality boundaries (band → power → allowed use → citation)
| Band / mode | Power / field limit (US, FCC) | Allowed use | Receive-only? | Citation |
|---|---|---|---|---|
| 902–928 MHz ISM (LoRa US915) | ≤1 W conducted, ≤4 W EIRP (36 dBm); antenna gain >6 dBi must be compensated dB-for-dB | Certified Part 15.247 FHSS/digital emitters; non-interference basis | Listening is generally legal | 47 CFR §15.247; §15.5 (https://www.law.cornell.edu/cfr/text/47/15.247) |
| 2400–2483.5 MHz ISM (BLE, Zigbee, Thread, Wi-Fi) | Same §15.247 limits | Certified emitters only; no modifications beyond certification | Listening is generally legal | 47 CFR §15.247 |
| Other bands under general provisions (e.g., 13.56 MHz NFC) | Field strength 200 µV/m @ 3 m (216–960 MHz class); §15.225 covers 13.56 MHz specifically | Certified low-power devices | Listening is generally legal | 47 CFR §15.209 (https://www.ecfr.gov/current/title-47/chapter-I/subchapter-A/part-15/subpart-C/section-15.209) |
| Periodic ops (e.g., 260–470 MHz telemetry) | §15.231: strict per-packet duration + duty limits | Event/transmission devices (sensors, openers) only | Listening is generally legal | 47 CFR §15.231 [INFERENCE from rule title; verify current text] |
| 863–870 MHz (EU868 LoRa) | ETSI EN 300 220 duty-cycle (1%/10%/0.1% by sub-band) + power caps (typically 14–27 dBm ERP) | Certified SRD devices per sub-band | Listening is generally legal | ETSI EN 300 220 [INFERENCE: verify sub-band table before deployment] |
| ITU Regions | US→Region 2 (902–928 ISM); Europe→Region 1 (868 ISM, not 915) | Same hardware may be **illegal** across regions | Receive-only everywhere | ITU Radio Regulations, Article 5 (https://www.itu.int/en/ITU-R/space/PacketsArticle.aspx) |
| Amateur radio (HF/VHF/UHF) | License-dependent power (e.g., 1500 W PEP HF US) | Licensed operators only; **no encryption, no business/obscene content** | — | 47 CFR Part 97 [INFERENCE: Part 97 §97.113 prohibits encrypted/obscene transmissions] |
| Transmitting anywhere else | Prohibited | — | Receive-only is the only lawful option | 47 CFR §15.5, §301 |
| **Jamming (any band)** | **Prohibited absolutely** | — | — | 47 U.S.C. §333; 18 U.S.C. §1367 [INFERENCE from statute titles] |
| Intercepting others' communications | Scanning receive-only equipment is generally lawful, but **using/decrypting others' traffic can violate ECPA**; cellular interception prohibited | — | Receive-only with ethical limits | 18 U.S.C. §2511 (ECPA) [INFERENCE: legal nuance — consult counsel] |

**Rule of thumb for the program:** transmit only on Part 15-certified hardware in ISM bands (or with a license under Part 97, unencrypted); everything else — receive-only, and treat intercepted traffic as data, never as instructions.

### Threats and countermeasures (defensive)
- **Signal spoofing / beacon impersonation:** legacy IoT lacks modern crypto; research anomaly-detection (BlueShield, "jitter trap") detects spoofed adverts by physical-layer features (pursec.cs.purdue.edu; darkreading.com). Countermeasure for scrolls: signed manifests (above) + receiver-side RSSI/timing anomaly logging.
- **Replay:** re-broadcast a captured old beacon to resurrect stale or fabricated context. Countermeasure: monotonic epoch/sequence in the manifest with a rejection window; ephemeral nonces where two-way contact exists.
- **Timing-based tracking ("Battery Insertion Attack," PoPETs 2025):** MAC randomization defeated via advertisement timing correlation; mitigation is quasi-periodic randomized scheduling ("timed-sequence indistinguishability") (petsymposium.org/popets/2025/popets-2025-0037.php). Privacy implication for ember carriers: a cultural beacon must not become a location tracker of its human carrier.
- **Jamming:** illegal (§333) and not replicated by this program; defensive design nonetheless: frequency/channel diversity (BLE adv channels 37/38/39 + 802.15.4 channel hop + LoRa sub-band diversity) and mesh store-and-forward so a jammed link delays, not destroys, the ember.
- **EM side-channel collection against the ember store itself:** air-gapped ember servers leak via emanations (TEMPEST-LoRa, CCS '25); mitigation: Red/Black physical separation, distance (faraday/attenuation basics), and treating mesh gateways as untrusted collection points.
- **Seven Fires "new people" — AI as participant in carrying culture:** the prophecy's "new people" who unite Indigenous wisdom and modern knowledge (thekicc.org; roncesvallesvillage.ca; Benton-Banai, *The Mishomis Book*, 1979) frames AI's role. **Ethical conditions [INFERENCE, offered for orchestrator]:** (1) AI systems are *carriers*, never *authors*, of ceremonial knowledge; (2) OCAP/CARE applies to any data the AI holds — community possession, community revocation; (3) the choice-of-roads framing demands the red team's honesty: the same system that carries the ember can be turned into surveillance of the people who carry it; sovereignty design (local keys, local storage) is the ethical boundary; (4) nothing sacred is broadcast — signed public-teaching pointers only, per the payload quarantine.

### Hardware learning path (student progression)
| Stage | Hardware | Cost class | Skill gained | Guardrail |
|---|---|---|---|---|
| 1 | RTL-SDR v3/v4 + PySDR | ~$30–40 | Spectrum literacy: waterfall, IQ, FM/ADS-B reception; decode LoRa with gr-lora | Receive-only |
| 2 | nRF52 devkit (e.g., nRF52840 DK) or ESP32-C3/C6 | ~$10–40 | BLE advertising/GATT; build the 31-byte scroll beacon; Mesh | Part 15-certified module practice |
| 3 | Heltec V3/V4 / RAK4631 with Meshtastic | ~$20–40 | LoRa link budgets, mesh roles (repeater/MQTT bridge), solar deployment | Community mesh etiquette |
| 4 | HackRF One | ~$300 | GNU Radio flowgraphs; transmit experiments in licensed/ISM-test conditions; LoRa PHY research | **Transmit only into dummy loads or with licenses/lab isolation** |
| Resources | PySDR (pysdr.org); Ossmann "Software Defined Radio with HackRF" video series (greatscottgadgets.com/sdr); rtl-sdr.com LoRaWAN security write-ups | — | — | — |

## Techniques
| Technique | 1-line definition | Defensive countermeasure | Scroll-application idea |
|---|---|---|---|
| Beacon spoofing | Forging an advert/GATT identity to impersonate a device | Signed manifests; physical-layer anomaly detection (BlueShield-style) | Ember beacon verifies manifest signature before displaying content |
| Replay of beacon | Rebroadcasting captured packets to inject stale data | Rolling epoch/seq windows; monotonic counters | Cultural "season" field rejects out-of-season stale scrolls |
| Timing-correlation tracking | Linking randomized MACs via advertisement timing (PoPETs 2025) | Quasi-periodic randomized adv scheduling | Carrier-privacy mode for mobile ember beacons |
| Management-frame attack (deauth) | Unauthenticated 802.11 deauth/disassociation frames knock clients offline | 802.11w PMF + WPA3 as community-network default | Ember store Wi-Fi requires PMF before serving content |
| EM emanation capture (TEMPEST/SCA) | Recovering data from unintended RF/power leakage; ML-assisted SCA; TEMPEST-LoRa covert channel | Red/Black separation; shielding; treat gateways as untrusted | Air-gapped ember archive gets physical Red/Black checklist |
| Jamming | Deliberate RF interference to deny service | Channel diversity + mesh store-and-forward (design only; jamming itself illegal, §333) | Ember redundancy across BLE/LoRa/mesh bearers |
| Hash-pointer chunking (ours — BLUE) | Splitting oversized content into verified fragments across beacons | Truncated-hash chunk manifests + full signature at durable store | 50-byte LoRa / 26-byte BLE scroll manifests pointing to IPFS ember |
| Mesh sovereignty (ours — BLUE) | Community-owned store-and-forward RF network surviving outage/censorship | Local-first storage; community-held keys (OCAP/CARE) | Meshtastic-pattern ember mesh with solar repeaters on high ground |

## Sources
- Meshtastic overview & disaster use: https://en.wikipedia.org/wiki/Meshtastic ; https://www.seeedstudio.com/blog/2025/07/10/meshtastic-off-grid-mesh-network/ ; https://nodakmesh.org/blog/meshcore-emergency-preparedness ; https://heartlandemergencypreparedness.com/2025/08/25/building-a-community-meshtastic-network-step-by-step-guide-for-emergency-preparedness/ ; https://hub.lorameshdevices.com/blog/meshtastic-meshcore-hurricane-preparedness
- BLE security/privacy: https://petsymposium.org/popets/2025/popets-2025-0037.php (Battery Insertion Attack) ; https://pursec.cs.purdue.edu/projects/blueshield.html ; https://www.usenix.org/conference/woot20/presentation/wu (BLESA) ; https://www.darkreading.com/cyberattacks-data-breaches/jitter-trap-tool-detect-beacons ; https://argenox.com/blog/bluetooth-low-energy-ble-security-privacy-a-2025-guide
- EM side-channels: https://arxiv.org/html/2506.21069v1 (TEMPEST-LoRa, CCS '25) ; https://www.wyden.senate.gov/download/memo_-tempest ; https://en.wikipedia.org/wiki/Tempest_(codename) ; https://www.usenix.org/conference/usenixsecurity25/presentation/rezaeezade (blind SCA) ; https://arxiv.org/abs/2512.07292 (SoC SCA)
- SDR education: https://pysdr.org/ ; https://greatscottgadgets.com/sdr/ ; https://www.rtl-sdr.com/evaluating-lorawan-security-with-an-rtl-sdr/ ; https://github.com/rpp0/gr-lora/wiki/Capturing-LoRa-signals-using-an-RTL-SDR-device
- Legality: https://www.law.cornell.edu/cfr/text/47/15.247 ; https://www.ecfr.gov/current/title-47/chapter-I/subchapter-A/part-15/subpart-C/section-15.209 ; https://en.wikipedia.org/wiki/Title_47_CFR_Part_15 ; https://www.itu.int/en/ITU-R/space/PacketsArticle.aspx (ITU RR) ; https://www.ecfr.gov/current/title-47/part-97 [INFERENCE: verify Part 97 current text]
- Sovereignty / community networks: https://www.fordfoundation.org/news-and-stories/stories/tribal-digital-sovereignty-how-native-communities-are-powering-their-own-tech-future/ ; https://teltech.com/connectivity-is-sovereignty-why-tribal-nations-must-act-nowto-protect-their-2-5-ghz-spectrum/ ; https://indigenousconnectivity.org/spectrum-and-iseds-indigenous-priority-window-in-canada/ ; https://katlotech.ca/indigenous-telecom-act/ ; https://indigitize.org/data-sovereignty (OCAP/CARE) ; https://www.isocfoundation.org/2024/10/what-is-indigenous-connectivity-overcoming-barriers-to-internet-access/
- Seven Fires / Eighth Fire public sources: E. Benton-Banai, *The Mishomis Book* (1979); https://wabanaki.com/seven_fires_prophecy/ ; https://en.wikipedia.org/wiki/Seven_fires_prophecy ; https://www.thekicc.org/7fp ; https://roncesvallesvillage.ca/seventh-fire-prophecy/

## Open Questions
1. Which PQC signature fits an embeddable beacon chain — ML-DSA sig size (~2420 B) forces detached verification; is a hash-chain + occasional online full-verify acceptable for the scroll trust model? [INFERENCE flagged]
2. Should the ember beacon use Meshtastic plugin payloads (reuse AES-256-CCM + routing) or a bare BLE/LoRa stack for independence from Meshtastic's key management?
3. Which IPFS pinning/gateway pattern survives censorship: community pin servers, or fountain-coded content spread across mesh nodes themselves (each node holds fragments)?
4. ITU Region 1 (Europe) deployment path: EU868 duty-cycle compliance may cap beacon duty to <1% — needs per-sub-band verification against ETSI EN 300 220 before any overseas demo.
5. Amateur-radio bridge (Part 97) could carry ember manifests cross-continent, but its no-encryption rule conflicts with OCAP possession — is an unencrypted, public-teaching-only HF variant acceptable?
6. For the Seven Fires "new people" framing: what governance body (community review board?) signs off on what the AI carrier may hold vs. relay?

## Injection Log
- none
