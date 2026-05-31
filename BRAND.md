# Local Router Brand And Character Brief

## Product Promise

Local Router is the friendly local routing layer for AI tools: Ollama-compatible at the port users already know, OpenAI-compatible for hosted model providers, and transparent enough for the community to inspect, tune, and improve the routing logic.

The product should feel like:

- Local-first and easy to run.
- Compatible with Ollama clients without copying Ollama's code, brand, mascot, or assets.
- Open about model choice, fallback behavior, and auto-routing scores.
- Technical enough for power users, but approachable for people who just want a working localhost proxy.

## Character Direction

The project character should be an original cool, cutesy cyberpunk Anishinaabe guide for local model routing. The character should signal sovereignty, technical skill, humor, and care for local-first computing.

Working description:

- A small cyberpunk Anishinaabe systems guide who helps route model traffic through a local server.
- Friendly, clever, and capable rather than childish or decorative.
- Modern techwear, luminous interface accents, local-network motifs, and routing-map details.
- A visual language that can support icons, docs headers, release notes, loading states, and lightweight UI empty states.

## Cultural Guardrails

Do:

- Keep the character original and operator/community reviewed.
- Use broad cyberpunk and local-network motifs before using specific cultural motifs.
- Treat Anishinaabe identity as living and contemporary, not historical costume.
- Prefer subtle references that can be explained and approved.
- Keep the tool UI practical; the character supports the product, it does not replace the product.

Do not:

- Copy Ollama's mascot, composition, color treatment, or trade dress.
- Use sacred, ceremonial, clan, or medicine imagery without explicit operator/community approval.
- Use pan-Indigenous stereotypes, generic "tribal" patterns, feathers-as-shortcut styling, costume tropes, or mystical framing.
- Turn the character into a tokenized decoration.
- Generate or ship final assets before review.

## Visual System Direction

The UI should remain a dense local operations tool. The character and brand layer should appear in places where personality helps but should not reduce scanability.

Recommended palette direction:

- Base: near-black ink, clean off-white, and neutral grays.
- Accent: electric cyan, warm magenta, and signal green in restrained amounts.
- Avoid a one-note purple/blue cyberpunk wash; use contrast and function first.

Recommended graphic motifs:

- Localhost port rings.
- Routing paths and node maps.
- Small terminal glyphs.
- Proxy arrows and model-switching indicators.
- Light grid details that stay behind content.

## First Asset Requirements

Before shipping a visual asset in the app or README, create and review:

1. Character concept sheet with 3 distinct directions.
2. One approved head-and-shoulders avatar.
3. One small full-body pose for docs or release notes.
4. One tiny icon-safe mark that still works at 32x32.
5. A plain-language cultural review note explaining what motifs are used and what was avoided.

All asset files should be non-secret project artifacts. Do not embed prompts containing local paths, provider keys, or private operator details.

## App Integration Rules

- The first screen of `/config` remains the usable Local Router configuration tool, not a landing page.
- Character art can appear as a compact header/avatar, empty state, or docs hero, but never as a full-screen blocker.
- Tool controls, provider lists, route tables, diagnostics, and model metadata stay information-dense and readable.
- Any generated bitmap assets must be checked in only after review and should include source notes in this file or a sibling asset README.
- Accessibility stays mandatory: sufficient contrast, no text embedded only in images, and no animation that blocks work.

## Open Routing Personality

The character should reinforce the product's open-routing promise:

- "I show my route."
- "No hidden model pools."
- "Local policy, visible scores."
- "Fallbacks you can inspect."
- "One localhost, many models."

These are direction notes, not final marketing copy.

## Implementation Sequence

1. Keep this brief current as the source of truth for visual identity decisions.
2. Draft 3 text-only character concepts for operator review.
3. After approval, generate bitmap concept art in a separate asset branch.
4. Review for cultural fit, readability, uniqueness, and non-infringement.
5. Add approved assets under `assets/brand/` with source notes.
6. Add a compact brand treatment to README/docs first.
7. Add a small optional `/config` header/avatar only after asset and accessibility review.
