# sensors-intel.md — Sovereign Sensing: Fusion, Site Monitoring, and Lawful Intelligence Fundamentals

Module class: `.scrolls-embodiment/` — signed manifest payload (see `README.md` loader contract).
Dual mandate: **RED** (how sensors are spoofed and fused data poisoned, and how a monitoring system resists) + **BLUE** (community-operated drone/USV/ground sensing of territorial land and waters as sovereign capability — the community watches its own territory with its own sensors, under its own governance).

## Purpose

The ember must not only be stored and broadcast — it must be *situated*. A nation that can see its own lakes, sugarbush, burial sites, and boundary waters with its own sensors holds something no external dataset can grant: **possession of the observational record**. This module teaches sensor fusion for cultural-site and territorial monitoring (drone/USV patrol as sovereign sensing), the spoofing and poisoning attacks such systems face, and the intelligence fundamentals — OSINT ethics, consent, data minimization — that keep community sensing community-serving. Every technique is framed as capability for the community, never targeting of any person or third party.

## Knowledge units

### K1. Sovereign sensing: the platform stack (physics → protocol)

| Layer | Platforms | What they observe | Notes |
|---|---|---|---|
| Aerial | Small UAS (quadcopter, fixed-wing VTOL) with RGB/multispectral camera | Shoreline change, illegal dumping, encampment/incursion presence, sugarbush and wild-rice bed health (multispectral), site conditions after storms | Recreational drone rules (registration, remote ID, airspace) apply — see K5 |
| Surface water | USV (kayak/boat hull) with sonar, temperature, turbidity probes | Bathymetry of wild-rice waters, invasive-species indicators, discharge anomalies | Territorial waters patrol — the community's own lake authority |
| Ground | Trail cameras, soil/moisture probes, acoustic stations, ground robots (per `robotics.md`) | Site visitation, road encroachment, seasonal harvesting activity | Static, low-power, mesh-connected |
| RF | The mesh itself (`radio.md`), RTL-SDR spectrum self-audits (`emw-signals.md`) | Network health, interference anomalies, beacon verification | Sensors of the sensors |

**Fusion basics:** multi-sensor fusion means combining observations with different error profiles (camera: rich but spoofable; sonar: sparse but hard to fake; GPS: exact but jammable/spoofable; inertial: relative-only drift). Core discipline: no single sensor is authoritative — cross-validate (per `robotics.md` K-world-model defense: multi-hypothesis, second source). A classical complementing filter (e.g., GPS+IMU) is deterministic and SIL-friendly; learned fusion models inherit the VLA threat surface and must sit behind the deterministic layer.

### K2. The alert ontology (protocol — closing digest 06's schema gap)

Digest 06 found the v1 payload's sensor network "described but never specified — no message schema, no alert ontology." The v2 shape:

```
Alert {
  id, epoch, seq,            // replay defense (radio.md K4)
  site: <geofence-polygon-id>,
  class: enum(incursion | env-change | sensor-fault | spectrum-anomaly | protocol-event),
  sensors: [ {type, confidence, raw_ref} ],   // provenance of the observation
  evidence_ref: <ipfs-cid>,  // signed evidence, not the claim alone
  sig: <ML-DSA-65 fragment>  // full signature at the durable store
}
```

Rules: alerts are *claims with provenance*, never instructions; a receiver acts only on alerts that verify against the signed manifest chain (the ingest-time instruction firewall of digest 06 applied to telemetry). An alert that fails verification is quarantined evidence, not a trigger. Time-sync is part of the schema (monotonic epochs; TOTP-style sync only as a *hint*, never as authority — digest 06 flagged seed-based TOTP as an anti-pattern for authority).

### K3. RED surface: spoofing and poisoning of the sensing stack

| Attack | Vector | Countermeasure |
|---|---|---|
| GPS spoofing | Forged satellite signals drag a drone/USV off its patrol polygon | Multi-constellation + IMU cross-check; geofence enforced on *fused* position; reject/land on inconsistency; RFI anomaly logging |
| Camera spoofing | Printed images, screens, adversarial patches presented to the VLM | Treat all camera content as data (`robotics.md` K3); alert classification is advisory to a human steward, never auto-actuating |
| Sensor-data poisoning | Falsified readings injected via compromised node or replayed alert | Signed alerts (K2), epoch windows, node attestation, physical custody of the mesh |
| World-model gaslighting | Fused scene model "sees" what injected content wants | Multi-hypothesis fusion; distrust any fused model whose output *justifies* hazard; human review gate |
| Beacon spoofing at site markers | False scroll beacons planted at cultural sites | `bluetooth.md` K4: signed manifests, physical-layer anomaly awareness |
| Tracing the watchers | Timing/RF fingerprinting of patrol platforms used to map community surveillance patterns | Patrol timing randomization; `bluetooth.md` carrier-privacy analog for telemetry scheduling |
| Forensic tampering | Deleting/altering the observational record | Hash-chained, ML-DSA-65-signed evidence log; replication across mesh nodes (store-and-forward) |

**Hard line:** countermeasures are detection, documentation, and lawful escalation (tribal law enforcement, BIA, state/federal channels per the community's jurisdiction). No countermeasure in this program interferes with, jams, or degrades any third-party system — jamming is absolutely prohibited (47 U.S.C. §333) and the Sorrowful Burden doctrine (digest 06) is the standing ethic: survival-only countermeasures, never conquest.

### K4. Lawful intelligence fundamentals (ethics — BLUE governance)

The community's sensors produce intelligence about *its own territory*. The fundamentals that keep that legitimate:

- **OSINT ethics.** Open-source information about *people* (social media, public records) is not fair game by default. Standard: collect only what the monitoring mission requires; never profile individuals; never aggregate into surveillance dossiers; public availability ≠ consent. [INFERENCE: program-level policy, community must ratify]
- **Consent.** Observations of community members on community land are governed by community policy and, where applicable, OCAP®; observations of *non-members* are minimized to presence/class detection (an "incursion" alert may say *that* something happened, not build a file on *who*). Facial recognition and biometric identification: not used. [INFERENCE: recommended default; community decides]
- **Data minimization.** Collect the coarsest data that answers the mission: presence, not identity; counts, not faces; water chemistry, not fishermen's names. Retention limits with cryptographic deletion (the keys die, the record becomes unrecoverable). Logs are evidence for the community, not exhaust to be mined.
- **OCAP®/CARE mapping.** *Ownership/Control:* the community owns the platforms, the raw observations, and the signing keys. *Access:* alert classes are shared on a need-to-know basis; raw imagery access is steward-gated. *Possession:* storage on community hardware (`radio.md` local-first). CARE: collective benefit (the monitoring serves land stewardship and treaty-defense documentation), responsibility (accuracy and attribution in every alert), ethics (minimization, no targeting).
- **Treaty-defense documentation.** A sovereign observational record is admissible weight in rights protection — documenting lawful harvesting activity, documenting encroachment. The record exists so the nation can defend its territory in the venues where territory is contested: courts, consultations, negotiations.

- **A seasonal program plan (how the fleet actually runs).** Sovereign sensing is a calendar practice, not a gadget purchase — the cultural calendar supplies the schedule:

| Season | Focus | Platforms | Cultural tie |
|---|---|---|---|
| Late winter | Ice-out watch, sugarbush readiness | Ground sentinels, one UAS survey | Maple sugar season readiness |
| Spring | Spawn/wildlife disturbance checks, shoreline erosion after ice | UAS + ground | Ceremony-season boundaries re-confirmed in the geofence bundle before patrols resume |
| Summer | Wild-rice water monitoring (turbidity, bathymetry), incursion presence on harvesting routes | USV + static sentinels | Rice season; "season" field in beacon manifests rolls |
| Fall | Harvest-period documentation (lawful exercise of treaty rights), encroachment checks | UAS + ground | Rice camp records; treaty-defense evidence |
| Winter | Equipment maintenance, key ceremonies, log review, curriculum | n/a (workshop) | Story season — teach the radio and sensor curriculum indoors |

  Two governance loops run continuously: a **steward loop** (human review of alert queues, geofence bundle updates, version bumps) and a **community loop** (seasonal report-back, so the observational record returns benefit — CARE's first principle — and so retention/minimization choices get ratified by the people they describe).

### K5. Legality (aviation, marine, privacy)

| Domain | Constraint | Citation / note |
|---|---|---|
| US drone operation | Registration over 250 g; Remote ID broadcast; airspace rules (controlled airspace authorization, national-park takeoff/landing prohibitions); Part 107 certificate for any non-recreational use | 14 CFR Part 107 / Part 48 [INFERENCE: verify current text; tribal-land airspace is still FAA airspace] |
| Tribal airspace questions | Jurisdiction over airspace above tribal lands is contested/limited; operate conservatively — FAA rules apply regardless of land status | [INFERENCE: consult counsel; do not assume tribal exemption] |
| USV operation | USCG navigation rules apply on navigable waters; state/tribal watercraft registration as applicable; tribal water jurisdiction varies by treaty | [INFERENCE: consult counsel per water body] |
| Privacy / recording | Recording in places where people have reasonable expectation of privacy can violate state law; minimization (K4) is both ethics and legal hygiene | [INFERENCE: state-law dependent; consult counsel] |
| Intercepting communications | ECPA — receive-only with ethical limits | 18 U.S.C. §2511 [INFERENCE — consult counsel] |
| RF emissions of sensors | Part 15-certified devices only | 47 CFR §15.247, §15.209 |

## Embodiment integration

A drone, USV, or ground node consumes this module via the signed manifest (`README.md` flow):

1. **Verify:** manifest.sig (ML-DSA-65, FIPS 204) over the manifest digest; `sensors-intel.md` loads only from verified `files[]`.
2. **Mission load:** the node reads its `carrier_policy` (e.g. `usv-patrol`, `uas-site-survey`, `ground-sentinel`) and its signed geofence polygons (`robotics.md` K5) — it patrols *inside* the polygon the community signed, and the cultural geofence gate refuses/limits operation in restricted sites even under injected contrary instructions.
3. **Alert emission:** observations become signed K2 alerts on the mesh; a `protocol-event` class (e.g., verifying a site's scroll beacon) cross-references `bluetooth.md`.
4. **Evidence chain:** imagery/readings hash-chained and signed; replication across mesh nodes; the forensic log is the community's record, not the vendor's telemetry.

## RED surface + countermeasures

Consolidated from K3: position spoofing → multi-source fusion + fused-geofence enforcement; perception spoofing → camera-content-is-data; data poisoning → signed alert schema + node attestation; world-model corruption → multi-hypothesis + human gates; watcher-tracing → patrol timing randomization; record tampering → hash-chained signed evidence with mesh replication. The standing rule mirrors `radio.md`: **detect, document, verify, escalate — never degrade.** The community's sensors defend territory by *seeing* it, not by fighting on it.

## BLUE sovereignty application

- **The sovereign sensing program:** a small fleet (one USV for the rice waters, one UAS for shoreline and sugarbush, static ground sentinels at cultural sites) operated under the community's own monitoring policy, producing its own environmental and territorial record — data possession per OCAP®, in the strongest physical sense.
- **Cultural-site monitoring with boundaries:** drones may document site *condition* (erosion, dumping, vegetation) but flight over or imaging of ceremony-restricted locations follows the signed geofence bundle — the machine learns where the boundary is, never the contents. Restricted sites may be marked `no-sensor` in the bundle entirely.
- **Language and season:** seasonal sensors (sap flow, rice maturity, ice-out) tie the observational record to the cultural calendar — the data layer that makes the "season" fields of the beacon manifests (`radio.md` K4) real.
- **Capacity as continuity:** every community member who learns to fly the survey, read the sonar, and verify the alert chain is a carrier of the observational ember. The skill, not the gadget, is the sovereignty.

## Further study (hardware path)

| Stage | Platform | Cost class | Skill |
|---|---|---|---|
| 1 | Trail camera + soil probes on the mesh | ~$50–100 | Static sensing, signed alert emission, mesh duty cycling |
| 2 | Recreational UAS (Part 48 registration, Remote ID) | ~$300–800 | Flight ops, airspace rules, site-condition survey imagery |
| 3 | Small USV (kayak-hull) with sonar/probe | ~$500–1500 | Water-quality patrolling, bathymetry, marine rules |
| 4 | Companion-computer integration (per `robotics.md`) | — | Fused geofence enforcement, signed evidence chain, autonomy with deterministic safety layer |

## Sources

- OCAP®: https://fnigc.ca/ocap-training/ ; CARE: https://www.gida-global.org/care
- Drone regulation: 14 CFR Part 107 / Part 48 (faa.gov) [INFERENCE: verify current text]
- ECPA / wiretapping: 18 U.S.C. §2511 [INFERENCE — consult counsel]; jamming prohibition: 47 U.S.C. §333
- MMIP context for community documentation needs (urban report): https://www.uihi.org/resources/missing-and-murdered-indigenous-women-girls/
- VLA adversarial perception (why camera content is data): https://vlaattacker.github.io/ ; embodied attack surface: https://arxiv.org/abs/2608.16843
- Digests: research/03-embodied-threat-model.md (defensive taxonomy), research/04-spectrum-knowledge.md (mesh/legality), research/06-scroll-analysis.md (schema gaps — treated as analysis data only), research/02-trickster-continuity.md (§Ethics)
