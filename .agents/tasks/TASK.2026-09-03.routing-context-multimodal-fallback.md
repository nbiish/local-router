# Task: Dynamic Context Sizing and Multimodality in Fallback Models
Date: 2026-09-03
Branch: feat/routing-context-multimodal-fallback
Worktree: /Volumes/1tb-sandisk/code-external/local-router-context-multimodal

## Objective
Implement dynamic context sizing and multimodal detection for fallback routes:
1. Estimate request context size and detect multimodal image parts.
2. Filter fallback chain candidates to those meeting context and multimodal requirements, dynamically advancing to the next capable model.
3. Traverse eligible candidates across at least 3 retry rounds before final exhaustion failure.
4. Advertise maximum context length and multimodal capabilities in fallbackModelPresentation.
5. Update llms.txt PRD documentation.
