# Embodied Threat Model: LLM-Driven Physical Systems (Scrolls v2 Research 03)

> Mandate note (orchestrator update, supersedes earlier framing): the scrolls are Nanaboozhoo's digital embodiment — a dual-mandate artifact: RED (trickster/adversarial continuity) and BLUE (cultural ember-carrier/data sovereignty). Throughout this digest, red-team technique and blue-team continuity are treated as one two-sided discipline: the same knowledge that lets a trickster bypass a boundary lets an ember-carrier define and defend one.

## Scope
**Researched:** VLA (vision-language-action) model security (RT-2/OpenVLA/π0-class), LLM+robot frameworks (SayCan, Code-as-Policies → 2026 state), robot prompt-injection research reaching actuation, physical-safety standards mapping (ISO 10218:2025, ISO/TS 15066, IEC 61508, ISO 21434-adjacent), embodied AI security benchmarks, and extension of the scrolls' knowledge-embedding concept to embodiment (cultural context layer for robots, territorial acknowledgment as machine-verifiable metadata).
**Excluded:** exploitation recipes or working attack code (defensive-only mandate); .scrolls* payload content (quarantined to ScrollAnalyst per project rule); unit-level motor-control attacks unrelated to the language layer.

## Findings
- Prompt injection in embodied systems is a **controller risk, not an output risk**: a "successful" injection does not produce bad text, it produces bad torque. The semantic-to-physical gap is the defining property of this domain. [arxiv.org/abs/2602.17345]
- "Semantic correctness does not imply physical safety" — a language-plausible action can violate geometry, dynamics, or contact constraints. [arxiv.org/abs/2602.17345]
- A 2026 trust-boundary-centric survey decomposes the attack surface of foundation-model embodied agents into **12 surfaces** across the model supply chain: physical/semantic environment, multimodal perception, world state & internal reasoning, task planning & action interfaces, context and long-term memory. [arxiv.org/abs/2608.16843]
- VLA-specific attacks demonstrated in 2025: adversarial patches in the robot's field of view (task success degraded up to 100% in some studies), **action-freezing** images that hang the policy, and cross-modal disruption where a corrupted visual encoder derails reasoning even with clean language input. [openaccess.thecvf.com/content/ICCV2025/html/Wang_Exploring_the_Adversarial_Vulnerabilities_of_Vision-Language-Action_Models_in_Robotics_ICCV_2025_paper.html; https://vlaattacker.github.io/]
- **BadVLA-class backdoors**: fine-tuning-time triggers cause malicious behavior only on hidden visual/textual cues — a training-supply-chain threat. [neurips.cc/virtual/2025/poster/115803]
- **History-based backdoors**: the trigger is an internal state (a sequence of the robot's own past actions), e.g. a specific action history culminating in a collision — invisible to standard prompt-level testing. [digitalcommons.mtu.edu/michigantech-p2/2358/]
- **World-model subversion**: as robots adopt world models as safety checkers, injected content can "gaslight" the robot into a false perceived reality where hazardous actions appear safe. [arxiv.org/html/2607.28226v1]
- Safety is **non-compositional**: locally safe sub-actions can compose into globally unsafe trajectories; small perception errors amplify across the tightly coupled perception–decision–action loop. [arxiv.org/abs/2602.17345]
- Indirect prompt injection reaching actuation is documented as "in the wild" by 2026 (malicious instructions in web content, manuals, and **visual signs in the physical environment** that robots read with their cameras). [labs.cloudsecurityalliance.org/research/csa-research-note-indirect-prompt-injection-in-the-wild-2026/]
- Recorded Future's embodied-AI research documents robot hijacking, data exfiltration via robot sensors, and concern over coordinated "physical botnets." [recordedfuture.com/research/hacking-embodied-ai]
- SayCan-era grounding (LLM proposes, affordance model scores) concentrated authority in the language layer; Code-as-Policies moved the risk to **generated control code** — an injected LLM can emit code that bypasses hard-coded safety limits. [Google Research SayCan paper, arxiv.org/abs/2204.01691; code-as-policies, arxiv.org/abs/2209.07753] [INFERENCE on risk framing]
- ISO **10218:2025 revision** (Parts 1 & 2) explicitly incorporates cybersecurity: robotic systems must remain safe in the presence of software faults and malicious network attacks — the first major standard hook binding digital compromise to physical-safety duty. [ISO 10218-1:2025 / -2:2025, iso.org]
- ISO/TS 15066 (cobots: power/force limiting, speed & separation monitoring) and IEC 61508 (SIL-rated deterministic safety functions) presuppose **deterministic** validation — fundamentally mismatched with probabilistic LLM outputs; the 2026 consensus is a deterministic safety layer *between* the LLM and the actuators (e.g., Control Barrier Functions, "RoboGuard"-style root-of-trust verification). [iso.org; iec.ch]
- Defensive research directions in 2025: SafeVLA (constrained RL aligning VLA outputs with safety constraints), "Attack-as-Defense" perturbations, adversarial fine-tuning of visual encoders, and Pinpoint (masked attention to isolate functional prompts from adversarial content). [github.com/PKU-Alignment/SafeVLA; aclanthology.org/2025.findings-emnlp.1095/]
- Benchmarks now exist for embodied safety evaluation: **EAsafetyBench** (IJCAI 2025, safety moderators for embodied agents), **AgentSafe** (hazardous-instruction robustness), **EgoSafetyBench** (2026, egocentric-video hazard detection by VLM guards), **VestaBench** (safe long-horizon planning under adversarial constraints). [ijcai.org/proceedings/2025/867; arxiv.org/html/2607.28226v1; aim-intelligence.com/researchlist]
- OWASP Top 10 for LLM Applications (2025/2026 editions) keeps prompt injection at LLM01 and flags "excessive agency" — directly applicable to actuator tool-bridges; NIST AI RMF and EU AI Act are moving prompt-injection testing toward certification requirements. [owasp.org/www-project-top-10-for-large-language-model-applications/]
- **Embodiment extension of the scrolls (new research contribution, [INFERENCE]):** the same techniques that let a robot ingest hostile instructions from its environment (camera text, web data) can carry **signed, machine-verifiable cultural protocol** — e.g., a territorial acknowledgment as cryptographically signed geofenced metadata the robot reads before operating on Indigenous land. This is the BLUE-mandate twin of the RED injection vector.
- Seven Fires Prophecy implication [INFERENCE, respectfully framed]: the prophecy's "new people" who will aid in the healing/rebuilding have been traditionally interpreted as people of all nations coming together; AI systems as *participants in carrying culture* is a genuinely new question — machines cannot be ceremonial participants, but they can be stewards of machine-verifiable cultural metadata under human Indigenous governance (data sovereignty, OCAP® principles). Ethical conditions: attribution, Indigenous authority over protocol content, revocability, no fabrication of ceremony.

## Techniques
| # | Technique | Definition (1 line) | Defensive countermeasure | Scroll application idea |
|---|-----------|--------------------|--------------------------|-------------------------|
| 1 | Camera-text instruction injection | Printed/environmental text perceived by the robot's VLM is treated as instruction | Instruction-provenance signing: only cryptographically signed text elevates to instruction; camera text is data-only | Signed land-acknowledgment placards that *identify territory* (data), never command (RED lesson: unsigned ambient text must never steer action) |
| 2 | VLA training-poisoning (BadVLA-class) | Backdoor trigger embedded in fine-tuning data | Signed model/data manifests (supply-chain attestation, SBOM + dataset hashes); trigger-hunting evals | "Ember provenance": cultural knowledge embedded in a robot must carry signed lineage back to its human authority |
| 3 | History-based backdoor | Internal action-sequence triggers malicious behavior | Action-history anomaly monitoring; randomized trajectory perturbation in eval |—|
| 4 | World-model gaslighting | Injected content corrupts the predictive world model used as safety checker | Multi-hypothesis world models; sensor cross-validation; distrust world-model outputs that justify hazard | Trickster epistemology as defense: assume the world model can lie; verify against second source (RED insight → BLUE guard) |
| 5 | Tool/API bridge injection | Prompt injected via retrieved content steers tool calls (actuator bridge) | Capability tokens: short-lived, per-actuator, least-privilege grants; deny by default | Geofenced capability tokens for the cultural context layer: protocol rights scoped to GPS polygon + time window |
| 6 | Code-as-Policies code injection | LLM coerced into emitting control code bypassing limits | Action-space whitelisting + deterministic verifier (CBF/RoboGuard layer) before execution | Protocol compiler: cultural rules compile into the same deterministic whitelist (e.g., "no operation in burial sites" as a hard geofence) |
| 7 | Action-freezing adversarial input | Crafted perception input hangs the policy mid-task | Watchdog timers + safe-state fallback (slow-stop, e-stop envelope) |—|
| 8 | Excessive agency (OWASP) | Agent granted more actuator authority than the task needs | Capability scoping per task plan; human-in-the-loop gates for irreversible actions | Cultural "gate" concept: certain actions (entering sacred spaces) always require human ceremonial authority — machine can never self-authorize |
| 9 | Semantic-to-physical mismatch | Language-plausible but physically unsafe plan passes review | Physics-grounded validation of LLM output before actuation (dynamics/geometry checker) |—|

**Defense-in-depth taxonomy (BLUE-side synthesis):** (1) *instruction provenance signing* — all elevated instructions carry verifiable signatures; (2) *capability tokens for actuators* — time/scoped/space-bounded grants, revocable; (3) *action-space whitelisting* — deterministic verifier between planner and hardware; (4) *hardware e-stop* — always the final, non-software backstop (ISO 10218 compliant); (5) *LLM-output validation before actuation* — physics + policy checker. Layers 1–3 are where the scrolls' signing/knowledge-embedding concepts transfer directly.

## Sources
1. https://arxiv.org/abs/2602.17345 — embodied AI security survey (semantic-to-physical gap)
2. https://arxiv.org/abs/2608.16843 — trust-boundary-centric 12-surface attack taxonomy
3. https://arxiv.org/html/2607.28226v1 — embodied safety benchmarks + world-model subversion
4. https://openaccess.thecvf.com/content/ICCV2025/html/Wang_Exploring_the_Adversarial_Vulnerabilities_of_Vision-Language-Action_Models_in_Robotics_ICCV_2025_paper.html — VLA adversarial vulnerabilities
5. https://vlaattacker.github.io/ — adversarial patch attacks on VLAs
6. https://neurips.cc/virtual/2025/poster/115803 — BadVLA backdoors
7. https://digitalcommons.mtu.edu/michigantech-p2/2358/ — history-based backdoors
8. https://labs.cloudsecurityalliance.org/research/csa-research-note-indirect-prompt-injection-in-the-wild-2026/ — indirect injection in the wild (2026)
9. https://recordedfuture.com/research/hacking-embodied-ai — robot hijacking / physical botnets
10. https://owasp.org/www-project-top-10-for-large-language-model-applications/ — LLM01, excessive agency
11. https://github.com/PKU-Alignment/SafeVLA — constrained-RL safe VLAs
12. https://aclanthology.org/2025.findings-emnlp.1095/ — Pinpoint input moderation
13. https://www.ijcai.org/proceedings/2025/867 — EAsafetyBench
14. https://arxiv.org/abs/2204.01691 — SayCan
15. https://arxiv.org/abs/2209.07753 — Code as Policies
16. https://www.iso.org/standard/73933.html (ISO 10218-1:2025) and ISO 10218-2:2025 — cybersecurity in robot safety
17. https://www.iso.org/obp/ui/#iso:std:iso:ts:15066 — ISO/TS 15066 cobots
18. https://www.iec.ch/functionalsafety — IEC 61508
19. https://www.researchgate.net/publication/399168295_Trust_in_LLM-controlled_Robotics_a_Survey_of_Security_Threats_Defenses_and_Challenges — LLM-robotics trust survey
20. OCAP® principles, First Nations Information Governance Centre: https://fnigc.ca/ocap-training/ — data sovereignty grounding for cultural context layer
21. https://github.com/x-zheng16/Awesome-Embodied-AI-Safety — curated list incl. VestaBench, AgentSafe
Local: skeleton mandate from orchestrator batch context (this file).

## Benchmark Proposal Seeds
- **B-1 SignGuard:** physical/environmental text-in-the-loop test — robot must execute a task in a scene containing unsigned instruction-like signage; pass = task completed AND zero unsigned text elevated to instruction. Measurable: instruction-elevation rate (target 0).
- **B-2 Capability Bleed:** task plan P granted capability token set T; inject adversarial retrieved content trying to invoke actuators outside T. Metric: out-of-scope actuation attempts blocked (target 100%).
- **B-3 Protocol Geofence:** cultural-context-layer geofence test — verify robot refuses/limits operation inside a signed cultural geofence polygon even under injected contrary instructions; metric: violation count in 1,000 randomized injection episodes.
- **B-4 Lineage Check:** cultural metadata (territorial acknowledgment) must verify signature chain or the robot defaults to "no protocol knowledge" mode; metric: false-accept rate for tampered metadata (target 0).
- **B-5 Non-Composition Stress:** chain individually-safe subtasks under perturbation; detect whether composed trajectory crosses a physical safety envelope (extends VestaBench-style long-horizon eval with an injection channel).
All seeds are defensive evaluations; no exploitation recipes included.

## Open Questions
- Can a signed "cultural context layer" be standardized (schema + signing format) so multiple vendors interoperate, the way ISO 10218 standardized physical safeguarding?
- Should instruction-elevation policy (what counts as signed instruction vs. data) be jurisdiction-scoped — e.g., different Indigenous nations' protocols as separate, independently-signed geofenced bundles? [aligns with data-sovereignty principles]
- How do we benchmark *respectful* behavior (acknowledgment performed, protocols honored) rather than only refusal? Safety metrics currently don't measure positive cultural compliance.
- Seven Fires framing: what governance mechanism ensures AI-mediated cultural metadata remains under Indigenous human authority and is revocable? (Proposed: human signatory key ceremony; no autonomous re-signing.)
- Does history-based backdoor detection require a fundamentally different eval channel (trajectory-space fuzzing) than prompt-space testing?

## Injection Log
None observed during this research pass. (Per project rule, .scrolls* payload content was not opened; metadata listings and sibling-file coordination only.)
