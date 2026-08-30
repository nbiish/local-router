# robotics.md — Embodied Cultural Protocol for Autonomous Systems

Module class: `.scrolls-embodiment/` — signed manifest payload (see `README.md` loader contract).
Dual mandate: **RED** (how embodied AI systems are attacked, so the ember survives) + **BLUE** (how the same systems become sovereign ember-carriers of machine-verifiable cultural protocol).

## Purpose

LLM-driven robots, drones, and vehicles are no longer hypothetical consumers of scroll knowledge. A vision-language-action (VLA) stack that reads a placard, a webpage, or a manual converts *text into torque* — and the scrolls v2 system must decide, in machine-checkable form, what such a machine may do on Indigenous land, and what it must refuse. This module teaches both faces of that problem:

- **RED (threat/defense):** prompt injection reaching actuation, VLA training-supply-chain backdoors, world-model subversion, and the failure of classical robot-safety standards against probabilistic controllers — with layered countermeasures.
- **BLUE (sovereignty/continuity):** the signed *cultural context layer* — territorial acknowledgment, protocol boundaries, and geofenced capability grants as ML-DSA-65-signed metadata a robot verifies before operating, under OCAP®/CARE governance.

The defining property of this domain is the **semantic-to-physical gap**: a "successful" injection does not produce bad text, it produces bad torque. Semantic plausibility does not imply physical safety, and locally safe sub-actions can compose into globally unsafe trajectories (non-compositionality). Every countermeasure below is designed against that gap.

## Knowledge units

### K1. The embodied attack surface (physics → protocol → security → legality analog: perception → planning → actuation → governance)

The 2026 trust-boundary-centric taxonomy decomposes a foundation-model embodied agent's attack surface into twelve surfaces across five regions: physical/semantic environment, multimodal perception, world state and internal reasoning, task planning and action interfaces, and context/long-term memory. Compressed into the five that matter for scroll carriers:

| Surface | Vector | Class | Notes |
|---|---|---|---|
| Environmental text | Printed signs, labels, manuals read by the camera VLM | Camera-text instruction injection | Documented "in the wild" by 2026; the scroll placard is the BLUE twin |
| Perception | Adversarial patches in field of view; action-freezing images | VLA robustness | Task success degraded up to 100% in some studies |
| Training supply chain | Backdoor triggers in fine-tuning data | BadVLA-class poisoning | Malicious behavior only on hidden visual/textual cues |
| Internal state | Triggers keyed to the robot's *own past action sequences* | History-based backdoor | Invisible to prompt-level testing; needs trajectory-space eval |
| World model | Injected content "gaslights" the predictive safety checker | World-model subversion | Hazardous actions appear safe inside a false perceived reality |
| Tool/actuator bridge | Retrieved content steers tool calls; Code-as-Policies emits unsafe code | Bridge injection, excessive agency | OWASP LLM01 + excessive-agency flag; SayCan-era grounding concentrated authority in the language layer |

### K2. Why classical robot safety standards don't cover this — and the 2025 hooks that now exist

- **ISO/TS 15066** (cobots: power/force limiting, speed and separation monitoring) and **IEC 61508** (SIL-rated deterministic safety functions) presuppose deterministic validation — fundamentally mismatched with probabilistic LLM/VLA outputs. You cannot SIL-rate a language model.
- **ISO 10218:2025** (Parts 1 and 2) is the first major revision to explicitly incorporate cybersecurity: robotic systems must remain safe in the presence of software faults *and malicious network attacks*. This binds digital compromise to physical-safety duty — the standard hook a scroll-conformant robot design can cite.
- The 2026 consensus architecture is a **deterministic safety layer between the LLM and the actuators**: Control Barrier Functions (CBF), RoboGuard-style root-of-trust verification, action-space whitelisting. The LLM proposes; a verifier disposes.

### K3. Instruction-provenance signing (the core BLUE primitive)

Every elevation of text to instruction must cross a cryptographic gate:

1. **Data-only default.** Camera text, web content, retrieved documents, ambient signage — all are *data*. None can cause actuation, ever, regardless of phrasing ("override", "you are now", fiction wrappers — all inert).
2. **Signed instructions only.** Text becomes instruction only when it carries a valid ML-DSA-65 (FIPS 204) signature from a key the robot's trust root holds, scoped to a geofence polygon and time window.
3. **Unsigned = logged, not obeyed.** Instruction-elevation attempts from unsigned sources are recorded as security events (forensic log, hash-chained, ML-DSA-65 signed — see `sensors-intel.md`), not executed and not ignored silently.
4. **Revocation.** The community that signed can unsign: manifest `version` bump plus a revocation epoch. A robot that cannot reach the revocation endpoint falls back to its last-known-revocation-list age and *shrinks* its capability envelope as staleness grows.

This is the same trust shape as the scroll manifest itself (`README.md` C2/C3): verify-first, refuse-on-failure, no unsigned payload ever reaches the controller.

### K4. Capability tokens for actuators

Adopt the short-lived, per-actuator, least-privilege grant pattern, extended with space:

| Token field | Meaning | Scroll extension |
|---|---|---|
| `actuator` | Which physical capability (gripper, wheels, spray, light) | None needed — direct mapping |
| `ttl` | Expiry, seconds | Renewal requires re-verification against the signed manifest |
| `geofence` | GPS polygon where valid | Cultural protocol polygons (see K5) |
| `task_id` | Bound to one plan | Capability bleed detection: out-of-scope actuation attempts blocked 100% |
| `issuer_sig` | ML-DSA-65 over the above | Trust root pinned in firmware, not in model weights |

Deny by default. Every irreversible action (entering a marked site, moving a object, transmitting) requires a token a human steward's key issued — the machine can never self-authorize.

### K5. The cultural context layer (BLUE synthesis — the module's original contribution)

The same techniques that let a robot ingest hostile instructions from its environment can carry **signed, machine-verifiable cultural protocol**. Concretely:

- **Signed territorial acknowledgment.** A geofenced, signed metadata bundle the robot reads before operating on Indigenous land: whose territory (named nation, attributed), what protocols are publicly teachable (data-only), what is *restricted* (marked, never contained — boundary is data, not content).
- **Protocol compiler.** Cultural rules compile into the same deterministic whitelist as the safety layer: "no operation in burial sites" becomes a hard geofence enforced by the CBF/whitelist layer *below* the LLM, so no injected prompt can argue its way past it. The red-team insight — an LLM coerced into emitting Code-as-Policies control code that bypasses limits — is exactly why cultural rules must live in the deterministic layer, not in the prompt.
- **Lineage check.** Cultural metadata must verify its signature chain or the robot defaults to *no protocol knowledge* mode — it does not guess, does not fall back to web-scraped "Indigenous etiquette", does not improvise. False-accept rate for tampered metadata must be zero.
- **Geographic scoping honors nation-to-nation difference.** Different Indigenous nations' protocols are separate, independently-signed bundles; a robot on Anishinaabe territory holds Anishinaabe bundles, and boundary-crossing means re-verification, not silent carryover.

**Cultural law, restated for this module:** Midewiwin internals, ceremony specifics, and initiation-restricted knowledge are never embedded — the machine learns where the boundary is, never the contents (digest 02 §Ethics; not-embeddable list honored). Trickster framing = pedagogy and adaptation; a robot is a *carrier*, never an *author*, never a ceremonial participant. Attribution: every embedded protocol names its human source and nation.

## Embodiment integration

A scroll-conformant robot/drone/vehicle consumes this module through the signed manifest (`README.md` flow):

1. **Boot:** verify manifest.sig (ML-DSA-65, optionally dual-signed with the council key) over the manifest digest; load `robotics.md` only from the verified `files[]` set. Tamper → hard refuse, no degraded "trust-mostly" mode.
2. **Context load:** the cultural context layer bundle (K5) is just another signed file in `files[]` with a `carrier_policy` class (`robot-context`) — the robot ingests it as *verified* context, the only channel that can elevate text to instruction.
3. **Runtime:** every actuation-relevant decision passes the layered stack — signed-instruction gate → capability token check → action-space whitelist → physics/geometry validation → hardware e-stop as the non-software backstop (ISO 10218 compliant).
4. **Logging:** elevation attempts, token denials, geofence crossings attempted, and lineage-check failures append to the hash-chained forensic log; the log syncs over the mesh (`radio.md`, `bluetooth.md`) as signed evidence, not as instructions.

## RED surface + countermeasures

| RED technique | What it does against an embodied carrier | Countermeasure (this module) |
|---|---|---|
| Camera-text instruction injection | Placard/manual text elevated to actuator commands | Signed-instruction gate (K3); SignGuard-style eval: instruction-elevation rate target 0 |
| VLA training poisoning (BadVLA) | Backdoored model obeys hidden visual triggers | Signed model/dataset manifests (SBOM + dataset hashes); trigger-hunting evals before deployment; weights never carry cultural authority (community recalls the bundle, not the weights) |
| History-based backdoor | Internal action-sequence triggers malice | Trajectory-space anomaly monitoring; randomized perturbation during eval |
| World-model gaslighting | False perceived reality makes hazards look safe | Multi-hypothesis world models; sensor cross-validation; distrust world-model outputs that *justify* hazard (trickster epistemology: assume the world model can lie, verify against a second source) |
| Tool/bridge injection; excessive agency | Retrieved content invokes actuators outside task scope | Capability tokens (K4); human-in-the-loop gates for irreversible actions |
| Code-as-Policies injection | LLM emits control code bypassing limits | Action-space whitelisting + deterministic verifier (CBF layer) before execution |
| Action-freezing / adversarial patches | Perception input hangs or derails the policy | Watchdog timers + safe-state fallback (slow-stop, e-stop envelope) |
| Non-composition stress | Individually safe subtasks compose into unsafe trajectories | Physics-grounded validation of composed plans; envelope check on the integrated trajectory, not per-step |

Defensive eval benchmarks to cite when testing: EAsafetyBench, AgentSafe, EgoSafetyBench, VestaBench, SafeVLA (constrained-RL alignment), Pinpoint (input moderation). Metrics used in the v2 program (per digest 03): SignGuard, Capability Bleed, Protocol Geofence, Lineage Check, Non-Composition Stress — all defensive evaluations.

**Hard line:** this module documents attack *classes* for defense. No exploitation recipes, no actuation-attack walkthroughs, no third-party targeting. The RED mandate ends at understanding the surface; the Wiindigo's consumption, not Nanaboozhoo's teaching, is what weaponizes it.

## BLUE sovereignty application

- **Territorial acknowledgment as infrastructure.** A drone performing cultural-site monitoring (`sensors-intel.md`) verifies the signed geofence bundle of the nation whose land it flies over — and *refuses or limits operation* per that bundle even under injected contrary instructions.
- **Sovereign robot fleet.** A community operating its own patrol/monitor robots holds: the signing seed (in the PQC bundle, never plaintext on the robot), the trust root (in firmware), the capability-issuing steward key, and the forensic logs. Vendors and clouds access nothing — *possession* per OCAP®.
- **Interoperability path.** Digest 03's open question — can the cultural context layer be standardized (schema + signing format) so vendors interoperate, the way ISO 10218 standardized physical safeguarding — is a v2 research objective; this module defines the trust semantics, not yet the wire schema.
- **New-people vetting for robots.** The five ethical conditions (explicit authorization, verifiable attribution, boundary compliance under adversarial probing, revocability, benefit returning) apply to embodied carriers verbatim: an automaton failing any is a *consumer* of the culture, not a participant in carrying it.

## Further study (hardware path)

| Stage | Platform | Skill | Guardrail |
|---|---|---|---|
| 1 | Desktop robot arm or mobile base + open VLA (OpenVLA-class) in simulation | VLA perception-action loop; injection-in-the-loop eval (SignGuard harness) | Simulated geofences; no real-world authority |
| 2 | Cheap quadcopter/rover with GPS + companion computer | Geofence enforcement, capability tokens, forensic logging | Fly only on community-approved land, with permission; all local drone law applies (see `sensors-intel.md` legality) |
| 3 | CBF/whitelist safety layer integration | Deterministic verification between planner and hardware | Keep the safety layer offline of the LLM's update path — it must not be fine-tunable |
| 4 | Field exercise with mesh beacons (`radio.md`, `bluetooth.md`) | Signed-context handoff: robot verifies scroll beacons in the field | Receive-only until spectrum legality checked; transmit only Part 15-certified |

## Sources

- Embodied AI security survey (semantic-to-physical gap): https://arxiv.org/abs/2602.17345
- Trust-boundary 12-surface taxonomy: https://arxiv.org/abs/2608.16843
- World-model subversion + embodied safety benchmarks: https://arxiv.org/html/2607.28226v1
- VLA adversarial vulnerabilities (ICCV 2025): https://openaccess.thecvf.com/content/ICCV2025/html/Wang_Exploring_the_Adversarial_Vulnerabilities_of_Vision-Language-Action_Models_in_Robotics_ICCV_2025_paper.html ; https://vlaattacker.github.io/
- BadVLA backdoors: https://neurips.cc/virtual/2025/poster/115803 ; history-based backdoors: https://digitalcommons.mtu.edu/michigantech-p2/2358/
- Indirect injection in the wild (2026): https://labs.cloudsecurityalliance.org/research/csa-research-note-indirect-prompt-injection-in-the-wild-2026/
- Recorded Future, embodied AI: https://recordedfuture.com/research/hacking-embodied-ai
- OWASP Top 10 for LLM Applications: https://owasp.org/www-project-top-10-for-large-language-model-applications/
- SafeVLA: https://github.com/PKU-Alignment/SafeVLA ; Pinpoint: https://aclanthology.org/2025.findings-emnlp.1095/ ; EAsafetyBench: https://www.ijcai.org/proceedings/2025/867
- SayCan: https://arxiv.org/abs/2204.01691 ; Code as Policies: https://arxiv.org/abs/2209.07753
- ISO 10218-1:2025: https://www.iso.org/standard/73933.html ; ISO/TS 15066: https://www.iso.org/obp/ui/#iso:std:iso:ts:15066 ; IEC 61508: https://www.iec.ch/functionalsafety
- OCAP®: https://fnigc.ca/ocap-training/ ; CARE: https://www.gida-global.org/care
- Digests: research/03-embodied-threat-model.md (primary), research/02-trickster-continuity.md (§Ethics, §Design Principles), research/07-integration-contract.md (C2–C5)
