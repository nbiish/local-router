#!/usr/bin/env python3
"""
omni_video_extractor.py
Downloads a YouTube video, splits it into chapters (or fixed chunks),
extracts frames, and uses the configured OMNI model to analyze each section
visually. Falls back to a transcript-only knowledge base when no VLM
credentials are configured or the video cannot be downloaded.

Secrets policy (AGENTS.md P2 / PQC mandate):
    Credentials resolve in-memory only, in priority order:
      1. OS environment variables (already in memory)
      2. `pqc-secrets export` (ML-KEM-768-wrapped bundle, decrypted in memory)
      3. Legacy `--env-file` (PLAINTEXT ON DISK - discouraged; warning emitted)
    Credentials are never logged, never written to output artifacts.
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

VIDEO_ID_RE = re.compile(r"^[0-9A-Za-z_-]{11}$")
DEFAULT_FRAMES = 8
DEFAULT_CHUNK_MINUTES = 3
DEFAULT_RETRIES = 3
YTDLP_TIMEOUT = 600
FFMPEG_TIMEOUT = 120
VLM_TIMEOUT = 180
SUPPORTED_PROVIDERS = ("nebius", "openrouter", "zenmux", "openai", "custom")


class ExtractorError(RuntimeError):
    """Fatal, user-facing extraction failure."""


# --------------------------------------------------------------------------
# Credentials (in-memory only; never persisted, never logged)
# --------------------------------------------------------------------------

def parse_env_text(text: str) -> dict:
    """Parse KEY=VALUE lines from dotenv or shell-export style text.

    Accepts both `KEY=VALUE` and `export KEY=VALUE` (the canonical
    `pqc-secrets export` output format per agent-integration.md).
    """
    env_vars = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = re.sub(r"^export\s+", "", key.strip())
        if key:
            env_vars[key] = val.strip().strip("'\"")
    return env_vars


def load_env_file(env_path: Path) -> dict:
    """Load a legacy .env file. Discouraged: plaintext secrets on disk."""
    if not env_path.is_file():
        return {}
    print(
        f"[secrets] WARNING: loading plaintext env file '{env_path}'. "
        "Per AGENTS.md P2, prefer OS env or `pqc-secrets export` (PQC-wrapped)."
    )
    return parse_env_text(env_path.read_text(encoding="utf-8"))


def load_pqc_secrets() -> dict:
    """Pull in-memory secrets from the local PQC bundle via pqc-secrets export.

    Never uses a shell; stdout is parsed in-memory; failures are silent because
    an absent bundle is a normal configuration state.
    """
    exe = shutil.which("pqc-secrets")
    if not exe:
        return {}
    try:
        proc = subprocess.run(
            [exe, "export"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
            shell=False,
        )
    except (subprocess.TimeoutExpired, OSError):
        return {}
    if proc.returncode != 0:
        return {}
    return parse_env_text(proc.stdout)


def resolve_environment(env_file: Path | None) -> dict:
    """Merge credential sources without letting plaintext override memory."""
    env: dict = {}
    env.update(load_env_file(env_file) if env_file else {})
    env.update(load_pqc_secrets())
    env.update({k: v for k, v in os.environ.items() if v})  # OS env wins
    return env


@dataclass
class VLMConfig:
    provider: str
    model: str
    api_key: str
    base_url: str


def resolve_vlm(env: dict) -> VLMConfig | None:
    """Resolve VLM credentials; return None to signal transcript-only mode."""
    provider = env.get("OMNI_PROVIDER", "").strip().lower()
    model = env.get("OMNI_MODEL", "").strip()
    if not provider or not model:
        print("[secrets] OMNI_PROVIDER/OMNI_MODEL unset -> transcript-only mode.")
        return None
    if provider not in SUPPORTED_PROVIDERS:
        print(f"[secrets] Unsupported provider '{provider}' -> transcript-only mode.")
        return None
    prefix = provider.upper()
    api_key = env.get(f"{prefix}_API_KEY", "")
    base_url = env.get(f"{prefix}_BASE_URL", "")
    if not api_key or not base_url:
        print(f"[secrets] No {prefix} credentials found -> transcript-only mode.")
        return None
    if not is_allowed_endpoint(base_url):
        print(f"[secrets] {prefix} base_url blocked (https or loopback http only) "
              "-> transcript-only mode.")
        return None
    return VLMConfig(provider=provider, model=model, api_key=api_key, base_url=base_url)


def is_allowed_endpoint(base_url: str) -> bool:
    """SSRF guard (CWE-918): https anywhere, plain http only on loopback."""
    match = re.match(r"^(https?)://([^/:?#]+)(?::(\d+))?", base_url.strip().lower())
    if not match:
        return False
    scheme, host = match.group(1), match.group(2)
    if scheme == "https":
        return True
    return host in ("127.0.0.1", "localhost", "::1", "[::1]")


class _EndpointGuardRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Follow redirects only when each hop passes the SSRF endpoint guard.

    Prevents an https provider URL from redirecting requests to file://,
    plain-http, or internal-network targets (redirect-based SSRF bypass).
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not is_allowed_endpoint(newurl):
            raise urllib.error.URLError(
                f"Redirect blocked by endpoint guard: {newurl}"
            )
        return super().redirect_request(req, fp, code, msg, headers, newurl)


# --------------------------------------------------------------------------
# Path safety (CWE-22 hardening)
# --------------------------------------------------------------------------

def validate_video_id(video_id: str) -> str:
    """Reject anything that is not a bare 11-char YouTube id."""
    if not video_id or not VIDEO_ID_RE.match(video_id):
        raise ExtractorError(f"Refusing unsafe video id: {video_id!r}")
    return video_id


def contained_path(output_dir: Path, name: str) -> Path:
    """Join inside output_dir and guarantee the result cannot escape it."""
    candidate = (output_dir / name).resolve()
    root = output_dir.resolve()
    if not str(candidate).startswith(str(root) + os.sep):
        raise ExtractorError(f"Path traversal blocked: {name!r}")
    return candidate


def extract_video_id(url: str) -> str | None:
    match = re.search(r"(?:v=|\/|shorts\/|youtu\.be\/)([0-9A-Za-z_-]{11})", url)
    return match.group(1) if match else None


# --------------------------------------------------------------------------
# yt-dlp helpers
# --------------------------------------------------------------------------

def ytdlp_cookie_args(browser: str) -> list:
    if browser and browser.lower() != "none":
        return ["--cookies-from-browser", browser.lower()]
    return []


def resolve_bin(name: str) -> str:
    """Resolve a tool to its absolute path (deterministic, supply-chain safe)."""
    return shutil.which(name) or name


def run_ytdlp(args: list, timeout: int = YTDLP_TIMEOUT) -> subprocess.CompletedProcess:
    """Run yt-dlp without a shell, capturing stderr for diagnostics."""
    cmd = [resolve_bin("yt-dlp"), "--no-warnings", *args]
    try:
        return subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout,
            check=False, shell=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise ExtractorError(f"yt-dlp timed out after {timeout}s: {' '.join(args[:3])}...") from exc
    except FileNotFoundError as exc:
        raise ExtractorError("yt-dlp is not installed (pip install yt-dlp).") from exc


def fetch_video_info(env: dict, url: str, output_dir: Path) -> dict | None:
    """Fetch metadata; returns None on failure so extraction can degrade."""
    print(f"[yt-dlp] Fetching video info for: {url}")
    browser = env.get("YTDLP_BROWSER", "none")
    proc = run_ytdlp(["--dump-json", *ytdlp_cookie_args(browser), url])
    if proc.returncode != 0 or not proc.stdout.strip():
        print(f"[yt-dlp] Info fetch failed: {proc.stderr.strip()[:400]}")
        return None
    try:
        info = json.loads(proc.stdout.strip().splitlines()[0])
    except json.JSONDecodeError as exc:
        print(f"[yt-dlp] Could not parse info JSON: {exc}")
        return None
    info_path = contained_path(output_dir, "info.json")
    info_path.write_text(json.dumps(info, indent=2), encoding="utf-8")
    return info


def download_video(env: dict, url: str, output_path: Path) -> Path | None:
    """Download <=720p mp4; returns None on failure (transcript-only fallback)."""
    print(f"[yt-dlp] Downloading video to: {output_path}")
    browser = env.get("YTDLP_BROWSER", "none")
    proc = run_ytdlp([
        "-f", "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "-o", str(output_path),
        *ytdlp_cookie_args(browser),
        url,
    ])
    if proc.returncode != 0 or not output_path.exists():
        print("[yt-dlp] Video download failed, continuing without frames.")
        print(f"[yt-dlp]   detail: {proc.stderr.strip()[:400]}")
        return None
    return output_path


def download_transcript(env: dict, url: str, output_dir: Path, video_id: str) -> Path | None:
    """Download English subtitles and return the best VTT variant."""
    print(f"[yt-dlp] Downloading transcript for: {url}")
    browser = env.get("YTDLP_BROWSER", "none")
    proc = run_ytdlp([
        "--write-auto-subs", "--write-subs", "--sub-langs", "en.*",
        "--skip-download", "--sub-format", "vtt",
        "-o", str(output_dir / "%(id)s.%(ext)s"),
        *ytdlp_cookie_args(browser),
        url,
    ])
    candidates = sorted(output_dir.glob(f"{video_id}*.vtt"))
    if not candidates:
        print(f"[yt-dlp] No subtitles found ({proc.stderr.strip()[:200] or 'none available'}).")
        return None

    def rank(path: Path) -> int:
        name = path.stem.lower()
        if name == video_id:
            return 0  # exact ".en.vtt" pattern legacy naming
        if "en-orig" in name:
            return 1
        if ".en" in name:
            return 2
        return 3

    best = min(candidates, key=rank)
    print(f"[yt-dlp] Using subtitle file: {best.name}")
    return best


# --------------------------------------------------------------------------
# Transcript parsing
# --------------------------------------------------------------------------

def parse_time(time_str: str) -> float:
    parts = time_str.strip().replace(",", ".").split(":")
    try:
        if len(parts) == 3:
            return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
        if len(parts) == 2:
            return float(parts[0]) * 60 + float(parts[1])
        if len(parts) == 1:
            return float(parts[0])
    except ValueError:
        return 0.0
    return 0.0


def parse_vtt(vtt_path: Path | None) -> list:
    """Parse a VTT file into [{start, text}] cues, skipping headers/notes.

    Text is only accepted after a cue timing line has been seen, so file-level
    metadata (e.g. "Kind: captions") never leaks into the transcript.
    """
    transcript = []
    if not vtt_path or not vtt_path.is_file():
        return transcript
    cue_re = re.compile(r"^\s*(\d[\d:.,]*)\s*-->\s*(\d[\d:.,]*)")
    current_start = 0.0
    in_cue = False
    for raw_line in vtt_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line or line.upper().startswith(("WEBVTT", "NOTE", "STYLE", "REGION")):
            continue
        match = cue_re.match(line)
        if match:
            current_start = parse_time(match.group(1))
            in_cue = True
            continue
        if not in_cue:
            continue  # pre-cue metadata (Kind:, Language:, ...)
        if re.match(r"^\d+$", line):
            continue  # bare cue counter
        text = re.sub(r"<[^>]+>", "", line).strip()
        if text:
            transcript.append({"start": current_start, "text": text})
    return transcript


def dedupe_transcript(transcript: list, window: int = 3) -> list:
    """Drop rolling-repeat lines emitted by YouTube auto-subs (3-line window)."""
    deduped = []
    recent = []
    for entry in transcript:
        text = entry["text"]
        if text in recent:
            continue
        deduped.append(entry)
        recent.append(text)
        if len(recent) > window:
            recent.pop(0)
    return deduped


def get_transcript_for_chunk(transcript: list, start_time: float, end_time: float) -> str:
    lines = [
        entry["text"]
        for entry in transcript
        if start_time <= entry["start"] < end_time
    ]
    return " ".join(lines).strip()


# --------------------------------------------------------------------------
# Frame extraction (aspect-preserving)
# --------------------------------------------------------------------------

def extract_frames(video_path: Path, start_time: float, end_time: float,
                   num_frames: int, output_dir: Path, prefix: str) -> list:
    """Extract up to num_frames JPEG frames, scaled to fit 854x480 keeping aspect."""
    duration = end_time - start_time
    if duration <= 0 or not video_path.is_file():
        return []
    interval = duration / (num_frames + 1)
    frames = []
    print(f"[ffmpeg] Extracting {num_frames} frames from {start_time:.0f}s to {end_time:.0f}s")
    for i in range(num_frames):
        timestamp = start_time + interval * (i + 1)
        frame_path = contained_path(output_dir, f"{prefix}_frame_{i:03d}.jpg")
        try:
            subprocess.run(
                [
                    resolve_bin("ffmpeg"), "-y", "-ss", f"{timestamp:.3f}", "-i", str(video_path),
                    "-vframes", "1", "-q:v", "2",
                    "-vf", "scale=854:480:force_original_aspect_ratio=decrease",
                    str(frame_path),
                ],
                capture_output=True, timeout=FFMPEG_TIMEOUT, shell=False, check=True,
            )
        except (subprocess.SubprocessError, OSError) as exc:
            print(f"[ffmpeg] Frame {i} failed: {exc}")
            continue
        if frame_path.is_file():
            frames.append(base64.b64encode(frame_path.read_bytes()).decode("ascii"))
    return frames


# --------------------------------------------------------------------------
# VLM analysis
# --------------------------------------------------------------------------

def analyze_section(vlm: VLMConfig, title: str, frames: list, prompt: str,
                    retries: int) -> str | None:
    """Call the VLM with text + optional frames; retry 429/5xx with backoff."""
    content = [{"type": "text", "text": prompt}]
    for b64 in frames:
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
        })
    payload = {
        "model": vlm.model,
        "max_tokens": 4096,
        "messages": [{"role": "user", "content": content}],
    }
    req = urllib.request.Request(
        f"{vlm.base_url.rstrip('/')}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {vlm.api_key}",
        },
    )
    opener = urllib.request.build_opener(_EndpointGuardRedirectHandler())
    for attempt in range(1, retries + 1):
        print(f"[{vlm.provider}] Analyzing: {title} "
              f"(attempt {attempt}/{retries}, {len(frames)} frames)")
        try:
            # Scheme allowlisted by is_allowed_endpoint(); every redirect hop
            # is re-validated by _EndpointGuardRedirectHandler (SSRF guard).
            with opener.open(req, timeout=VLM_TIMEOUT) as response:
                result = json.loads(response.read().decode("utf-8"))
                return result["choices"][0]["message"]["content"]
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")[:300]
            print(f"[{vlm.provider}] HTTP {exc.code}: {body}")
            if exc.code not in (429, 500, 502, 503, 504):
                return None
        except (urllib.error.URLError, TimeoutError, KeyError, IndexError,
                TypeError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            print(f"[{vlm.provider}] Request failed: {exc}")
        if attempt < retries:
            backoff = 2 ** attempt
            print(f"[{vlm.provider}] Retrying in {backoff}s...")
            time.sleep(backoff)
    return None


# --------------------------------------------------------------------------
# Chunk planning
# --------------------------------------------------------------------------

def build_sections(info: dict | None, transcript: list, duration_hint: float,
                   chunk_minutes: int) -> list:
    """Return [{title, start, end}] from chapters, or fixed-length chunks."""
    if info:
        chapters = info.get("chapters") or []
        sections = [
            {"title": c.get("title", f"Section {i + 1}"),
             "start": float(c.get("start_time", 0)),
             "end": float(c.get("end_time", 0))}
            for i, c in enumerate(chapters)
        ]
        if sections and all(s["end"] > s["start"] for s in sections):
            return sections
    duration = duration_hint or float((info or {}).get("duration") or 0)
    if duration <= 0:
        raise ExtractorError(
            "Video duration unknown (info fetch failed, no transcript timestamps). "
            "Cannot plan sections; pass a URL yt-dlp can read."
        )
    chunk_len = max(60, chunk_minutes * 60)
    count = math.ceil(duration / chunk_len)
    return [
        {"title": f"Chunk {i + 1}",
         "start": i * chunk_len,
         "end": min((i + 1) * chunk_len, duration)}
        for i in range(count)
    ]


def existing_section_keys(results_path: Path) -> set:
    """Headers already present in a previous analysis run (resume support)."""
    if not results_path.is_file():
        return set()
    return {
        line.strip()
        for line in results_path.read_text(encoding="utf-8").splitlines()
        if line.startswith("## ")
    }


# --------------------------------------------------------------------------
# Main pipeline
# --------------------------------------------------------------------------

def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="omni_video_extractor.py",
        description="Extract a markdown knowledge base from a YouTube video "
                    "(VLM frames + transcript, or transcript-only fallback).",
    )
    parser.add_argument("url", help="YouTube URL")
    parser.add_argument("output_dir", nargs="?", default="./omni_output",
                        help="Output directory (default: ./omni_output)")
    parser.add_argument("env_file", nargs="?",
                        default=None, type=Path,
                        help="Legacy .env file (discouraged; OS env / pqc-secrets preferred)")
    parser.add_argument("prompt_addendum", nargs="?", default="",
                        help="Extra instructions appended to the VLM prompt")
    parser.add_argument("--transcript-only", action="store_true",
                        help="Skip video download and VLM calls; transcript-only KB")
    parser.add_argument("--frames", type=int, default=DEFAULT_FRAMES,
                        help=f"Frames per section (default: {DEFAULT_FRAMES})")
    parser.add_argument("--chunk-minutes", type=int, default=DEFAULT_CHUNK_MINUTES,
                        help=f"Chunk length when no chapters (default: {DEFAULT_CHUNK_MINUTES})")
    parser.add_argument("--retries", type=int, default=DEFAULT_RETRIES,
                        help=f"VLM retry attempts (default: {DEFAULT_RETRIES})")
    parser.add_argument("--fresh", action="store_true",
                        help="Ignore previous analysis output (disable resume)")
    return parser


def main(argv: list | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    env = resolve_environment(args.env_file)
    vlm = None if args.transcript_only else resolve_vlm(env)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # 1. Metadata (info failure degrades gracefully)
    info = fetch_video_info(env, args.url, output_dir)
    video_id = validate_video_id(
        (info or {}).get("id") or extract_video_id(args.url) or ""
    )
    title = (info or {}).get("title", "Unknown Title")
    channel = (info or {}).get("channel") or (info or {}).get("uploader") or "Unknown"
    duration = float((info or {}).get("duration") or 0)
    print(f"\nTarget Video: {title} ({duration:.0f}s, {channel})")

    # 2. Transcript
    vtt_path = download_transcript(env, args.url, output_dir, video_id)
    transcript = dedupe_transcript(parse_vtt(vtt_path))
    print(f"[transcript] {len(transcript)} cues parsed")
    transcript_hint = max((c["start"] for c in transcript), default=0.0)
    if transcript:
        contained_path(output_dir, f"{video_id}.transcript.txt").write_text(
            "\n".join(f"[{c['start']:.0f}s] {c['text']}" for c in transcript),
            encoding="utf-8",
        )

    # 3. Video (optional)
    video_path = None
    if vlm and not args.transcript_only:
        candidate = contained_path(output_dir, f"{video_id}.mp4")
        video_path = candidate if candidate.exists() else download_video(
            env, args.url, candidate
        )
        if video_path is None:
            print("[extract] Continuing in text-only analysis (no frames).")

    # 4. Sections
    duration_hint = transcript_hint + 5 if transcript else 0
    sections = build_sections(info, transcript, duration_hint, args.chunk_minutes)
    print(f"[extract] {len(sections)} sections planned\n")

    # 5. Analyze + assemble knowledge base
    results_path = contained_path(output_dir, f"{video_id}_analysis.md")
    done = set() if args.fresh else existing_section_keys(results_path)
    if not done:
        results_path.write_text(
            f"# Omni Analysis: {title}\n\n"
            f"- Video: {args.url}\n"
            f"- Channel: {channel}\n"
            f"- Duration: {duration:.0f}s\n"
            f"- Mode: {'transcript-only' if (vlm is None or video_path is None) else 'transcript+frames (VLM)'}\n\n",
            encoding="utf-8",
        )

    analyzed = 0
    with results_path.open("a", encoding="utf-8") as out:
        for i, section in enumerate(sections):
            header = f"## {section['title']} ({section['start']:.0f}s - {section['end']:.0f}s)"
            if header in done:
                print(f"= Skipping (already analyzed): {section['title']}")
                continue
            chunk_transcript = get_transcript_for_chunk(
                transcript, section["start"], section["end"]
            )
            frames = []
            if video_path:
                frames = extract_frames(
                    video_path, section["start"], section["end"],
                    args.frames, output_dir, f"sec_{i}",
                )

            if vlm:
                prompt = (
                    f"You are an Omni Model Research Analyst. Analyze this section of the "
                    f"video titled '{section['title']}'. The section runs from "
                    f"{section['start']:.0f}s to {section['end']:.0f}s.\n\n"
                    f"### Spoken Transcript for this section:\n\"{chunk_transcript}\"\n\n"
                    f"### Visuals:\n{len(frames)} sequential frames provided below.\n\n"
                    "Combine what is spoken with what is visible. Identify symbols, actions, "
                    "and underlying truths. Create a comprehensive markdown knowledge base "
                    f"entry for this section. {args.prompt_addendum}"
                )
                analysis = analyze_section(vlm, section["title"], frames, prompt, args.retries)
            else:
                analysis = None

            out.write(f"{header}\n\n")
            if analysis:
                out.write(f"{analysis}\n\n")
                analyzed += 1
                print(f"OK Analysis complete for {section['title']}\n")
            else:
                out.write(
                    "*(Transcript-only capture - no VLM analysis available.)*\n\n"
                    f"**Transcript:**\n\n> {chunk_transcript or '(no transcript captured)'}\n\n"
                )
                analyzed += 1 if chunk_transcript else 0
                print(f"~ Transcript-only entry for {section['title']}\n")

    print(f"\nAll done! Analysis saved to: {results_path}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ExtractorError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(3)
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        sys.exit(130)
