---
name: video-knowledge-extractor
description: Extracts structured markdown knowledge bases from YouTube videos by combining spoken transcripts with sequential visual frames via a Vision-Language Model (VLM). Use this when you need to turn a video into a deep, searchable knowledge document.
---

# Video Knowledge Extractor

Takes a YouTube URL and produces a comprehensive markdown knowledge base by combining the spoken transcript with visual frame analysis through a VLM. This solves the problem of "lossy" video transcription — slides, terminal screens, diagrams, and other visuals carry as much information as the spoken words.

Degrades gracefully: with no VLM credentials (or a failed video download) it still produces a **transcript-only knowledge base**, so a URL alone is enough to start.

## What You Get

A `[VIDEO_ID]_analysis.md` file containing chapter-by-chapter analysis that weaves together visual and spoken content into a structured knowledge base, plus `[VIDEO_ID].transcript.txt` (timestamped, deduped cues) and `info.json` (metadata). This artifact can then be fed into the **document-enhancer** skill to fuse the extracted knowledge into a target document.

## Capabilities

- **Bot Protection Bypass:** Uses `yt-dlp`, optionally with browser cookies (`--cookies-from-browser`).
- **Multimodal Context:** Downloads auto-subtitles (robust `.vtt` parsing, rolling-repeat dedup) and sequential visual frames (via `ffmpeg`, aspect-preserving).
- **Semantic Chunking:** Splits videos into YouTube chapters (or configurable N-minute chunks) and processes them sequentially to avoid context limits.
- **Transcript-Only Fallback:** No VLM credentials, `--transcript-only`, or failed download → transcript-only knowledge base instead of a crash.
- **Resume:** Re-runs skip sections already present in the output (`--fresh` forces a clean rewrite).
- **PQC-Safe Credentials:** Resolves secrets in memory only — OS env → `pqc-secrets export` (ML-KEM-768-wrapped bundle) → legacy `--env-file` (plaintext on disk; discouraged per AGENTS.md P2 and warned about). Credentials are never logged or written to outputs.
- **SSRF Guard:** VLM endpoint must be https, or plain http on loopback only (local routers).
- **Path Safety:** Video ids are strictly validated; all output paths are containment-checked against the output directory (CWE-22).
- **Focusable Analysis:** Accepts an optional prompt addendum to steer the VLM toward specific topics, CVEs, methodologies, etc.

## Prerequisites

1. `ffmpeg` on PATH (resolved to its absolute path before execution).
2. Python package `yt-dlp` (`pip install yt-dlp`).
3. VLM credentials (optional — omit for transcript-only mode) via OS environment or the PQC secrets bundle.

## Required Environment Variables

```bash
OMNI_PROVIDER=nebius          # or openrouter, zenmux, openai, custom
OMNI_MODEL=nvidia/Nemotron-3-Nano-Omni

NEBIUS_API_KEY=...            # via OS env or `pqc-secrets export` — never plaintext on disk
NEBIUS_BASE_URL=https://api.studio.nebius.com/v1

YTDLP_BROWSER=none            # chrome, brave, firefox, edge, safari — or 'none' (default; headless-safe)
```

Load the PQC way: `eval "$(pqc-secrets export)"` before invoking, or rely on the script's own `pqc-secrets export` resolution.

## How to Use

```bash
python3 .agents/skills/video-knowledge-extractor/scripts/omni_video_extractor.py \
  "YOUTUBE_URL" [OUTPUT_DIR] [ENV_FILE] [PROMPT_ADDENDUM] [options]
```

### Positional Arguments (backward compatible)

1. `YOUTUBE_URL` — The full URL of the video to process.
2. `OUTPUT_DIR` (Optional) — Defaults to `./omni_output`.
3. `ENV_FILE` (Optional) — Legacy dotenv file. Discouraged: plaintext secrets on disk (AGENTS.md P2). Prefer OS env or the PQC bundle.
4. `PROMPT_ADDENDUM` (Optional) — Extra VLM focus instructions.

### Options

| Flag | Effect |
|------|--------|
| `--transcript-only` | Skip video download and VLM calls; transcript-only knowledge base |
| `--frames N` | Frames per section for VLM analysis (default: 8) |
| `--chunk-minutes N` | Chunk length when the video has no chapters (default: 3) |
| `--retries N` | VLM retry attempts on 429/5xx with exponential backoff (default: 3) |
| `--fresh` | Ignore previous output; disable resume |

### Examples

```bash
# Full multimodal run (credentials from OS env / PQC bundle)
python3 .agents/skills/video-knowledge-extractor/scripts/omni_video_extractor.py \
  "https://www.youtube.com/watch?v=qjA__5-Bybs" ./research_output

# Transcript-only, no credentials needed
python3 .agents/skills/video-knowledge-extractor/scripts/omni_video_extractor.py \
  "https://www.youtube.com/watch?v=qjA__5-Bybs" ./research_output --transcript-only

# Legacy positional style still works
python3 .agents/skills/video-knowledge-extractor/scripts/omni_video_extractor.py \
  "URL" "./out" "./.env" "Focus heavily on architecture diagrams on screen."
```

## How it Works

1. **Metadata:** `yt-dlp --dump-json` fetches title, duration, chapters. Failure is non-fatal (video id falls back to URL parsing).
2. **Subtitles:** English VTT is downloaded (best variant picked among `en`, `en-orig`, `en-*`), parsed cue-by-cue, and rolling auto-sub repeats deduplicated.
3. **Video (optional):** ≤720p mp4 download; skipped in transcript-only mode or after failure.
4. **Chunking:** YouTube chapters, else fixed N-minute chunks (duration inferred from info JSON or transcript timestamps).
5. **Analysis:** Per section — `ffmpeg` extracts N aspect-preserving frames; the chunk transcript + base64 frames go to the VLM with retry/backoff. Without a VLM, the section is captured transcript-only with an explicit marker.
6. **Assembly:** Sections append to `[VIDEO_ID]_analysis.md` with a metadata header; completed sections are skipped on re-runs.

## Quality Verification (plugin validators)

The script is kept clean under the repo's verification tooling:

```bash
ruff check .agents/skills/video-knowledge-extractor/scripts/omni_video_extractor.py
bandit -q -ll .agents/skills/video-knowledge-extractor/scripts/omni_video_extractor.py
python3 -m py_compile .agents/skills/video-knowledge-extractor/scripts/omni_video_extractor.py
```

Zero ruff findings and zero bandit medium+ findings are the merge gate. Remaining bandit LOW findings (subprocess import/calls) are by-design: fixed argument lists, `shell=False`, timeout on every call, absolute binary paths via `shutil.which`.

## Next Step: Fusing Into Documents

The knowledge base produced by this skill is intended to be consumed by the **document-enhancer** skill, which can weave the extracted knowledge into any target document. See `document-enhancer` SKILL.md for the fusion pipeline.
