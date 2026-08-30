---
name: video-knowledge-extractor
description: Extracts structured markdown knowledge bases from YouTube videos by combining spoken transcripts with sequential visual frames via a Vision-Language Model (VLM). Use this when you need to turn a video into a deep, searchable knowledge document.
---

# Video Knowledge Extractor

Takes a YouTube URL and produces a comprehensive markdown knowledge base by combining the spoken transcript with visual frame analysis through a VLM. This solves the problem of "lossy" video transcription — slides, terminal screens, diagrams, and other visuals carry as much information as the spoken words.

## What You Get

A `[VIDEO_ID]_analysis.md` file containing chapter-by-chapter analysis that weaves together visual and spoken content into a structured knowledge base. This artifact can then be fed into the **document-enhancer** skill to fuse the extracted knowledge into a target document.

## Capabilities

- **Bot Protection Bypass:** Uses `yt-dlp` with browser cookies to bypass YouTube's aggressive bot protections.
- **Multimodal Context:** Downloads auto-subtitles (via `.vtt` parsing) and sequential visual frames (via `ffmpeg`).
- **Semantic Chunking:** Splits videos into chapters (or 3-minute chunks) and processes them sequentially to avoid context limits.
- **Focusable Analysis:** Accepts an optional system prompt addendum to steer the VLM toward specific topics, CVEs, methodologies, etc.

## Prerequisites

1. Host system must have `ffmpeg` installed.
2. Python package `yt-dlp` must be available.
3. A `.env` file containing VLM provider credentials.

## Required Environment Variables

```bash
OMNI_PROVIDER=nebius          # or openrouter, zenmux
OMNI_MODEL=nvidia/Nemotron-3-Nano-Omni

NEBIUS_API_KEY=your_key_here
NEBIUS_BASE_URL=https://api.studio.nebius.com/v1

YTDLP_BROWSER=brave           # chrome, safari, firefox, edge, or 'none'
```

## How to Use

```bash
python3 .agents/skills/video-knowledge-extractor/scripts/omni_video_extractor.py \
  "YOUTUBE_URL" [OUTPUT_DIR] [ENV_FILE_PATH] [SYSTEM_PROMPT_ADDENDUM]
```

### Arguments

1. `YOUTUBE_URL` — The full URL of the video to process.
2. `OUTPUT_DIR` (Optional) — Directory to save the video, frames, and markdown output. Defaults to `./omni_output`.
3. `ENV_FILE_PATH` (Optional) — Path to the `.env` file. Defaults to `./.env`.
4. `SYSTEM_PROMPT_ADDENDUM` (Optional) — Additional instructions appended to the VLM's system prompt to focus the analysis (e.g., "Identify all CVEs mentioned and describe their exploit methodology").

### Example

```bash
python3 .agents/skills/video-knowledge-extractor/scripts/omni_video_extractor.py \
  "https://www.youtube.com/watch?v=qjA__5-Bybs" \
  "./research_output" \
  "./.env" \
  "Focus heavily on structural architecture diagrams shown on screen."
```

## How it Works

1. **Info & Subtitles:** Calls `yt-dlp` to get video metadata (duration, chapters) and download the `.en.vtt` transcript.
2. **Video Download:** Downloads the video file (720p max to keep file sizes manageable).
3. **Extraction:** For each chapter (or 3-minute chunk), `ffmpeg` extracts 8 sequential frames.
4. **VLM Analysis:** Sends the transcript for that chunk + 8 base64-encoded visual frames to the configured VLM.
5. **Knowledge Base Assembly:** Appends each section's analysis to `[VIDEO_ID]_analysis.md` in the output directory.

## Next Step: Fusing Into Documents

The knowledge base produced by this skill is intended to be consumed by the **document-enhancer** skill, which can weave the extracted knowledge into any target document. See `document-enhancer` SKILL.md for the fusion pipeline.
