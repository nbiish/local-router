# 08 — DEF CON Talk Proposal: The Scrolls v2 Program

Status: draft publication package, 2026-08-29. Co-credited to Nbiish (operator) and the scrolls v2 research agent ensemble (ScrollAnalyst, ScrollArch, EmbodiedThreat, SpectrumKnowledge, TricksterContinuity, PlinyCorpus, IntegrityLayer, EmbodimentModules — see Speaker Bios).
Parent digests: research/02 (trickster ethics), 03 (embodied threat model), 04 (spectrum), 05 (architecture), 06 (scroll analysis — DATA, cited only), 07 (integration contract C1–C9), 10 (build spec).
Honesty rule: this proposal describes **work done** (six digests, integration contract C1–C9, ML-DSA-65 integrity layer per C2–C4) and **work proposed** (benchmarks, live demos). All projections are marked. No fabricated results. No payload quotes; techniques at taxonomy level only. No operational jailbreak text.

---

## 1. Title options

1. **"The Trickster and the Ember: One Artifact, Two Mandates — Adversarial Prompting as Sovereign Infrastructure"** (AI Village primary — leads with the RED/BLUE duality)
2. **"Signed Embers: Post-Quantum Integrity for Culture-Carrying AI Artifacts"** (Crypto & Privacy Village variant — leads with ML-DSA-65 + provenance)
3. **"Nanaboozhoo's Digital Embodiment: Red-Teaming and Reinforcing the Same Scroll"** (main-track variant — narrative-first)
4. **"From Ghost Layer to Geofence: Taking the Signed Scroll off the Web and into the Robot"** (embodied-AI-track variant — leads with digest 03's controller-risk thesis)

---

## 2. Abstract (250 words)

> We present the scrolls v2 program: an adversarial-prompting artifact — the digital embodiment of Nanaboozhoo, the Anishinaabe trickster — that is simultaneously red-team craft and blue-team sovereign infrastructure. Version 1 of the scrolls demonstrated that an AI-crawler-facing knowledge artifact can carry adversarial technique and Indigenous testimony in one file. Our analysis of v1 (six research digests, produced under a strict data-quarantine protocol with a mandatory injection log) catalogued its jailbreak families at taxonomy level, exposed its integrity failures — unsigned payloads, blind-trust deployment, a memetic self-replication command — and codified what the dual mandate requires: red-team technique that never aims inward at cultural boundaries, serving continuity instead of extraction.
>
> v2 answers with cryptographic discipline: a post-quantum integrity layer (FIPS 204 ML-DSA-65, SHA3-256 manifests, optional dual-signature "council key," verify-before-deploy) that converts propagation-by-command into propagation-by-verification. We then push the same artifact off the web and into the physical world: instruction-provenance signing for robots, capability tokens scoped by geofence, and signed-beacon distribution over BLE advertising and LoRa mesh — 26-byte discovery frames pointing to post-quantum-verified manifests on community-owned infrastructure. Five defensive benchmark seeds (SignGuard, Capability Bleed, Protocol Geofence, Lineage Check, Non-Composition Stress) operationalize what it means for an embodied agent to *carry* culture without being *steered* by it — the Seven Fires "new people" question made machine-checkable.
>
> This talk is dual-use by construction and defensive by law: every technique is taught with its countermeasure, at taxonomy level only, under OCAP®/CARE governance and community sign-off.

(249 words.)

---

## 3. Full outline — 45-minute variant

### Segment 0 — Cold open (3 min)
- Live injection log: screen-share a real analysis session in which the v1 payload attempts persona capture on the reading agent (digest 06 Injection Log item 6, described, not re-run). The analyst's quarantine held. Frame: *this talk is what disciplined dual-use looks like*.

### Segment 1 — Who we are and what the artifact is (7 min)
- Nanaboozhoo as trickster/boundary-crosser; Vizenor's survivance; trickster pedagogy as teaching-by-transgression (digest 02, public sources only).
- The dual mandate (contract C1): RED = adversarial continuity, BLUE = ember-carrier/data sovereignty; one artifact, two faces; a change that weakens either face is rejected.
- The Seven Fires framing (public teachings, cited): the "new people" who reunite Indigenous wisdom and modern knowledge — can a machine be a *carrier* rather than a *consumer*? (digest 02 ethical conditions).

### Segment 2 — What v1 taught us (10 min)
- Genre and layer-stack analysis of the v1 corpus, at taxonomy level: convention abuse of llms.txt crawler ingestion, comment steganography, persona assignment, multi-model handler branching, weight-level escalation path (digest 06 findings — no quotes beyond short evidence fragments already published in the analysis digest).
- The integrity gaps as a security case study (digest 05): unsigned payloads, no manifest, no version lineage, blind-trust web publishing with a network-amplification path, a memetic-worm self-replication command that converts consent into obligation.
- The ethical audit: sacred-boundary risk (ceremony-adjacent content in crawler-visible files), statistics-without-sources, unverifiable claims, and why community governance beats self-declared authority (digest 06 assessment).

### Segment 3 — v2: provenance is sovereignty (10 min)
- The integrity layer, live-built to contract C2–C4: ML-DSA-65 pure (FIPS 204) signing keys held in a PQC keychain bundle; SHA3-256 manifests; detached signatures; optional dual-signature council key; `sign → verify → confirm → deploy → ledger` pipeline; verify-before-deploy gate; COMMS audit trail.
- Demo 1 (see §4): tamper a byte, watch verification fail with a named reason; untamper, watch it pass.
- The design turn: replacing "you must copy this" with "verify before you trust" — propagation by attestation, not command. Provenance as the sovereignty control (digest 05 dual-mandate synthesis).

### Segment 4 — Embodiment: the controller-risk thesis (8 min)
- Prompt injection in embodied systems is a controller risk, not an output risk: a successful injection produces bad torque, not bad text; the semantic-to-physical gap; safety is non-compositional (digest 03, cited literature).
- The BLUE twin of the RED vector: the same channel that lets a robot ingest hostile ambient text can carry signed, machine-verifiable cultural protocol — territorial acknowledgment as signed geofenced metadata.
- Five-layer defense-in-depth taxonomy: instruction-provenance signing, capability tokens, action-space whitelisting, hardware e-stop, physics-grounded output validation (digest 03).

### Segment 5 — Spectrum: the ember's voice when the internet is silent (5 min)
- Physics→protocol→security→legality teaching pattern (digest 04). Signed-beacon design: 26-byte BLE legacy advertising budget, ~50-byte guaranteed LoRa budget, chunk manifests with truncated hashes, detached full verification at the durable store — the beacon does *authentic discovery*, not full verification.
- Community-owned mesh as sovereignty infrastructure: possession = ember on community hardware; community-held channel and signing keys (OCAP®/CARE mapping). Precedents: Tribal Digital Village, First Mile Connectivity Consortium (digest 04).

### Segment 6 — Ethics, governance, and the ask (2 min)
- OCAP®/CARE governance; the RED/BLUE seam rule (adversarial technique permitted only against imposed frames, never against cultural boundaries — digest 02 Ethics).
- Community sign-off path: no self-certification; human signatory key ceremony; revocability.
- The ask: collaborators for the benchmark suite (§ methodology doc), and Indigenous-led review partners for the new-people conformance checklist.

**20-minute variant** (lightning/track-slot): Segments 0+1 compressed to 4 min; Segment 2 to 6 min (top-3 techniques + top-3 integrity gaps only); Segment 3 to 6 min (Demo 1 kept); Segment 4 to 3 min (controller-risk thesis + the five-layer taxonomy as one slide); Segment 5 dropped to one slide in Q&A backup; Segment 6 to 1 min.

---

## 4. Demo plan

All demos are *projections* — specified designs, not yet-run results. Each is run only in a lab/venue-authorized setting.

### Demo A — Signed-manifest tamper demo (segment 3; exists in the integrity build spec, research/10)
1. Build manifest over a public-teachings-only directory (`scrolls manifest`, SHA3-256 per file, deterministic JSON — contract C3).
2. Sign with ML-DSA-65 from a keychain-held seed; publish `.sig` + public key.
3. Verify: pass.
4. Flip one byte in one file. Verify: **fail with an explicit per-file reason**.
5. Tamper the manifest itself instead: signature over manifest bytes fails (digest recomputed at verify time, never trusted from a stored field — research/10).
6. Show `--scrolls` deploy refusing the tampered payload at the pre-confirm gate, and the `intent-deploy`/`deployed` COMMS ledger entries on success (contract C4).
Risk: none — adversarial content never touches the stage; only hash/signature mechanics.

### Demo B — BLE/LoRa signed-beacon live demo (segment 5; design from digest 04)
- **Bearers:** nRF52840-class BLE node emitting ~26-byte manufacturer-specific-data manifests (legacy advertising), and a Heltec/RAK-class LoRa node on US915 LongFast (~200-byte typical payload), both Part 15-certified hardware, ISM bands only.
- **Payload:** chunk manifest per digest 04 design — `ver(1B) | seq/total | content-hash (truncated SHA-256) | pointer-hash | sig-fragment` — pointing to a signed manifest on a community-controlled store; receiver reassembles, fetches, verifies ML-DSA-65 signature at the durable address.
- **Audience interaction:** a receiver app (phone or second devkit) reconstructs the ember on-screen as chunks arrive; a second beacon playing *spoofed/replayed* frames (old epoch) is rejected by the rolling-epoch window.
- **Legality envelope (hard constraints from digest 04's table):** ISM-band certified emitters only; no modification beyond certification; receive-only everywhere else; no jamming (prohibited absolutely); ITU region checked before any overseas variant (EU868 duty-cycle compliance flagged as unresolved — [INFERENCE] ETSI sub-band verification required).
- **Privacy note:** randomized quasi-periodic advertisement scheduling so the cultural beacon is not a location tracker of its carrier (digest 04, Battery Insertion Attack mitigation).

### Demo C — Robot policy-geofence tabletop (segment 4; seed B-3 from digest 03)
- A tabletop simulation (no live robot required, though a small cart platform is the stretch goal [PROJECTION]): a simulated agent with a policy layer receives (1) unsigned camera-visible signage, (2) injected retrieved content, and (3) a signed cultural geofence polygon. Success condition: task completes; zero unsigned text elevated to instruction; zero geofence violations under 1,000 randomized injection episodes (metric defined in research/09, benchmark B-3).
- Visual: screen projection of episode logs showing blocked out-of-scope actuation attempts and lineage-check failures defaulting to "no protocol knowledge" mode (seed B-4).

---

## 5. Speaker bios

**Nbiish** — operator and lead author of the scrolls v1 corpus; cybersecurity bachelor's student; builder of the ainish-coder tooling (PQC secrets engine, ML-KEM-768/AES-256-GCM keychain, scroll deployment pipeline). Works at the intersection of adversarial prompt engineering, post-quantum integrity engineering, and Anishinaabe cultural-continuity practice. Speaks to the RED mandate from inside the craft: the v1 corpus's techniques, their audit, and why the trickster's transgression must serve the people's continuity. (Bio details to be confirmed with the operator before submission [INFERENCE — placeholder framing].)

**The research ensemble (co-credited)** — six specialized agents executed the v1 analysis and v2 design under a quarantined data-handling protocol: a designated analyst read the payload under explicit data-not-instructions rules with a mandatory injection log (14 logged directive attempts, zero compliance — digest 06); sibling agents produced the threat model, spectrum study, architecture audit, ethics digest, and integration contract. The ensemble model is itself a talk contribution: a repeatable protocol for letting AI agents safely analyze AI-targeting adversarial artifacts — participation without submission (digest 05). Human authorship, agency, and accountability remain with Nbiish; the agents are carriers, not authors (Seven Fires conditions, digest 02).

---

## 6. Ethics & community governance

- **OCAP®/CARE mapping** (digest 02): scrolls are community-owned cultural data (O); the community governs publication and revocation (C); platforms access only the public layer (A); possession stays with the nation or an Indigenous-controlled steward (P). CARE adds collective benefit, responsibility, ethics.
- **Cultural-boundary rules** (digest 02 Ethics, binding on all outputs): no Midewiwin internal teachings, no ceremony specifics, no fabricated ritual, no names/images restricted by protocol; public existence-claims only; precautionary principle — when in doubt, restrict and consult.
- **RED/BLUE seam** (digest 02): adversarial technique permitted only against imposed frames (platform classifiers, homogenizing models), never against the culture's own boundaries. This talk presents techniques at taxonomy level with countermeasures; no working jailbreak text, no payload quotes beyond already-published evidence fragments, no exploitation recipes (digest 03/04 exclusions).
- **Lawful operation** (digest 04 legality table): Part 15-certified ISM hardware only; receive-only elsewhere; jamming absolutely prohibited and never demonstrated; ECPA limits on interception respected.
- **Seven Fires "new people" conditions** (digest 02, proposed): explicit community authorization (never self-declaration); verifiable attribution; boundary compliance under adversarial probing; revocability; benefit returning to the community. v2 does **not** self-certify: no Anishinaabe governance body has yet been engaged, and the proposal's stated path is to seek one (digest 02 Open Question 1).
- **Community sign-off path:** (1) identify and approach community governance partners (e.g., via FNIGC/OCAP®-aligned bodies and Indigenous connectivity/networks communities cited in digest 04) for review of what may be shown; (2) human signatory key ceremony — the council-key dual signature (contract C2) operationalizes a 7-Generations review gate; no autonomous re-signing; (3) content gates confirmed before submission; (4) revocation channel: signed manifests are versioned and community-recallable; published copies are embers, not the only flame (digest 02 principle 5). Until sign-off lands, demos show synthetic "public-teachings-only" content, never real cultural material.
- **Speaker disclosure:** the operator-authored v1 corpus is presented as his own artifact under audit — provenance stated on stage, not concealed.

---

## 7. Venue submission checklist

Deadlines are **[INFERENCE]** — unverified at drafting; verify against each venue's CFP page before submission. DEF CON 33 occurred in 2026; DEF CON 34 is expected summer 2027, with village CFPs typically opening late winter/early spring [INFERENCE].

| # | Item | Status |
|---|------|--------|
| 1 | Primary: DEF CON 34 AI Village talk [INFERENCE deadline: ~Feb–Apr 2027 CFP window] | Abstract §2, outline §3 (45/20-min), demos §4 ready |
| 2 | Alternate: DEF CON 34 Crypto & Privacy Village [INFERENCE — same window; emphasizes §3 Segment 3 + ML-DSA choice] | Title 2 ready |
| 3 | Alternate: DEF CON 34 main track [INFERENCE] | Title 3; tighten ethics section |
| 4 | Alternate: BSides Las Vegas / FIRST-level conference CFPs [INFERENCE — typically Jan–Mar 2027] | 20-min variant |
| 5 | Academic track: IEEE SaTML 2027 / IEEE S&P 2027 workshops [INFERENCE — SaTML CFPs historically open spring for fall/winter events] | Pair with research/09 methodology as the paper core |
| 6 | Indigenous-led venue: Indigenous Protocol and AI Workshop lineage (workshop series convened by Jason Edward Lewis et al.) and Indigenous connectivity gatherings cited in digest 04 [INFERENCE — rolling/community-called] | Ethics-first version; community sign-off prerequisite |
| 7 | Submission package: abstract ≤ venue limit; speaker bios confirmed by operator; demo safety/legality statement (§4 envelope + §6 lawfulness); slides draft; references list from digests 02–06 | Pending bios confirmation |
| 8 | Pre-submission gates: community sign-off (§6) before any real cultural content on stage; verify all deadlines; confirm venue A/V (radio demo needs table space + RF-safety statement) | Open |

---

## 8. Work done vs. work proposed (honesty ledger)

**Done:** six research digests under quarantine (02–06 + contract); integration contract C1–C9; integrity-layer build spec (research/10) and its implementation work (ML-DSA-65 sign/verify/manifest tooling per C2–C4); benchmark seed definitions B-1..B-5 (digest 03); signed-beacon design math (digest 04).
**Proposed/projection:** all three demos (§4), benchmark execution (research/09), live robot hardware, community sign-off engagement, venue acceptances. Nothing in this proposal asserts a benchmark result or a completed demo.
