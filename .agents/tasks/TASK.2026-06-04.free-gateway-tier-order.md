# TASK 2026-06-04 — Free gateway tier order

- routing-exhaustion-order.ts
- Free bands 0–3
- Paid kilo/cline slot 5–6
- OpenCode paid band 7
- Router text free-first
- Unit tests pass

####
Model-level exhaustion: all free (Ollama → Kilo/Cline → OpenCode free) then paid (NVIDIA…Nebius → Kilo/Cline paid → OpenCode paid → tail).
