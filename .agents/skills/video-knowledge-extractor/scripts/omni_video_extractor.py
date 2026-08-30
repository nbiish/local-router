#!/usr/bin/env python3
"""
omni_video_extractor.py
Downloads a YouTube video, splits it into chapters (or fixed chunks),
extracts frames, and uses the configured OMNI model to analyze each section visually.
"""

import os
import sys
import json
import base64
import subprocess
import urllib.request
import urllib.error
import math
import re
from pathlib import Path

# Load environment variables
def load_env(env_path_str):
    env_vars = {}
    env_file = Path(env_path_str)
    if not env_file.exists():
        print(f"Error: Environment file '{env_path_str}' not found.")
        sys.exit(1)
    with open(env_file) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                key, val = line.split("=", 1)
                env_vars[key.strip()] = val.strip()
    return env_vars

def get_provider_config(env, provider_name):
    prefix = provider_name.upper()
    api_key = env.get(f"{prefix}_API_KEY")
    base_url = env.get(f"{prefix}_BASE_URL")
    return api_key, base_url

def download_video_info(env, url, output_dir):
    print(f"[yt-dlp] Fetching video info for: {url}")
    info_path = output_dir / "info.json"
    
    browser = env.get("YTDLP_BROWSER", "chrome")
    cmd = ["yt-dlp", "--dump-json"]
    if browser and browser.lower() != "none":
        cmd.extend(["--cookies-from-browser", browser])
    cmd.append(url)
    
    subprocess.run(cmd, stdout=open(info_path, "w"), check=True)
    
    with open(info_path) as f:
        return json.load(f)

def download_video(env, url, output_path):
    print(f"[yt-dlp] Downloading video to: {output_path}")
    browser = env.get("YTDLP_BROWSER", "chrome")
    cmd = [
        "yt-dlp", "-f", "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "-o", str(output_path)
    ]
    if browser and browser.lower() != "none":
        cmd.extend(["--cookies-from-browser", browser])
    cmd.append(url)
    
    subprocess.run(cmd, check=True)

def download_transcript(env, url, output_dir, video_id):
    print(f"[yt-dlp] Downloading transcript for: {url}")
    browser = env.get("YTDLP_BROWSER", "chrome")
    vtt_path = output_dir / f"{video_id}.en.vtt"
    cmd = [
        "yt-dlp", "--write-auto-subs", "--write-subs", "--sub-lang", "en",
        "--skip-download", "--sub-format", "vtt", "-o", str(output_dir / "%(id)s.%(ext)s")
    ]
    if browser and browser.lower() != "none":
        cmd.extend(["--cookies-from-browser", browser])
    cmd.append(url)
    
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return vtt_path if vtt_path.exists() else None

def extract_frames(video_path, start_time, end_time, num_frames, output_dir, prefix):
    duration = end_time - start_time
    if duration <= 0:
        return []
    
    interval = duration / (num_frames + 1)
    frames = []
    print(f"[ffmpeg] Extracting {num_frames} frames from {start_time}s to {end_time}s")
    for i in range(num_frames):
        timestamp = start_time + interval * (i + 1)
        frame_path = output_dir / f"{prefix}_frame_{i:03d}.jpg"
        subprocess.run([
            "ffmpeg", "-y", "-ss", str(timestamp), "-i", str(video_path),
            "-vframes", "1", "-q:v", "2", "-s", "854x480", str(frame_path)
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        
        if frame_path.exists():
            with open(frame_path, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("utf-8")
                frames.append(b64)
    return frames

def analyze_section(env, model, provider_name, title, frames, prompt):
    api_key, base_url = get_provider_config(env, provider_name)
    if not api_key or not base_url:
        print(f"Error: Credentials for {provider_name} not found.")
        return None

    content = [{"type": "text", "text": prompt}]
    for b64 in frames:
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{b64}"}
        })

    payload = {
        "model": model,
        "max_tokens": 4096,
        "messages": [
            {
                "role": "user",
                "content": content
            }
        ]
    }

    req = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}"
        }
    )

    print(f"[{provider_name}] Analyzing section: {title} (with {len(frames)} frames)")
    try:
        with urllib.request.urlopen(req) as response:
            result = json.loads(response.read().decode("utf-8"))
            return result["choices"][0]["message"]["content"]
    except urllib.error.HTTPError as e:
        print(f"HTTP Error: {e.code} - {e.read().decode('utf-8')}")
        return None
    except Exception as e:
        print(f"Error: {e}")
        return None

def extract_video_id(url):
    match = re.search(r"(?:v=|\/)([0-9A-Za-z_-]{11}).*", url)
    return match.group(1) if match else None

def parse_time(time_str):
    parts = time_str.replace(",", ".").split(":")
    if len(parts) == 3:
        return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
    elif len(parts) == 2:
        return float(parts[0]) * 60 + float(parts[1])
    return 0.0

def parse_vtt(vtt_path):
    transcript = []
    if not vtt_path or not vtt_path.exists():
        return transcript
    with open(vtt_path, "r", encoding="utf-8") as f:
        content = f.read()
        blocks = content.split("\n\n")
        for block in blocks:
            lines = block.strip().split("\n")
            if len(lines) >= 2 and "-->" in lines[0]:
                times = lines[0].split("-->")
                start_time = parse_time(times[0].strip())
                text = " ".join(lines[1:]).replace("<c>", "").replace("</c>", "")
                # Remove timestamps inside the text like <00:00:01.000>
                text = re.sub(r'<[^>]+>', '', text)
                transcript.append({"start": start_time, "text": text.strip()})
            elif len(lines) >= 3 and "-->" in lines[1]:
                times = lines[1].split("-->")
                start_time = parse_time(times[0].strip())
                text = " ".join(lines[2:]).replace("<c>", "").replace("</c>", "")
                text = re.sub(r'<[^>]+>', '', text)
                transcript.append({"start": start_time, "text": text.strip()})
    return transcript

def get_transcript_for_chunk(transcript, start_time, end_time):
    if not transcript:
        return "No transcript available."
    
    lines = []
    for entry in transcript:
        t_start = entry['start']
        if t_start >= end_time:
            break
        if t_start >= start_time:
            lines.append(entry['text'])
    
    # Deduplicate sequential identical lines (common in auto-subs)
    deduped = []
    for line in lines:
        if not deduped or deduped[-1] != line:
            deduped.append(line)
            
    return " ".join(deduped)

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 omni_video_extractor.py <youtube_url> [output_dir] [env_file_path] [system_prompt_addendum]")
        sys.exit(1)

    url = sys.argv[1]
    out_dir_str = sys.argv[2] if len(sys.argv) > 2 else "./omni_output"
    env_file_str = sys.argv[3] if len(sys.argv) > 3 else "./.env"
    sys_prompt_addendum = sys.argv[4] if len(sys.argv) > 4 else ""
    
    env = load_env(env_file_str)
    
    omni_provider = env.get("OMNI_PROVIDER")
    omni_model = env.get("OMNI_MODEL")
    
    if not omni_provider or not omni_model:
        print(f"Error: OMNI_PROVIDER or OMNI_MODEL not set in {env_file_str}")
        sys.exit(1)

    output_dir = Path(out_dir_str)
    output_dir.mkdir(parents=True, exist_ok=True)

    # 1. Get info
    info = download_video_info(env, url, output_dir)
    video_id = info.get("id", "unknown")
    duration = info.get("duration", 0)
    chapters = info.get("chapters")
    title = info.get("title", "Unknown Title")

    print(f"\nTarget Video: {title} ({duration}s)")
    
    if not chapters:
        print("No chapters found. Splitting into 3-minute chunks.")
        chapters = []
        chunk_len = 180
        for i in range(math.ceil(duration / chunk_len)):
            start = i * chunk_len
            end = min((i + 1) * chunk_len, duration)
            chapters.append({
                "start_time": start,
                "end_time": end,
                "title": f"Chunk {i+1}"
            })

    # 2. Get Transcript
    vtt_path = download_transcript(env, url, output_dir, video_id)
    transcript_data = parse_vtt(vtt_path)

    # 3. Download video
    video_path = output_dir / f"{video_id}.mp4"
    if not video_path.exists():
        download_video(env, url, video_path)

    # 4. Process chapters
    results_path = output_dir / f"{video_id}_analysis.md"
    with open(results_path, "w") as out:
        out.write(f"# Omni Analysis: {title}\n\n")

    for i, chapter in enumerate(chapters):
        c_title = chapter.get("title", f"Section {i+1}")
        start = chapter["start_time"]
        end = chapter["end_time"]
        
        # Extract frames
        frames = extract_frames(video_path, start, end, 8, output_dir, f"sec_{i}")
        
        # Get transcript for this section
        chunk_transcript = get_transcript_for_chunk(transcript_data, start, end)
        
        prompt = (
            f"You are an Omni Model Research Analyst. Analyze this section of the video titled '{c_title}'. "
            f"The section runs from {start}s to {end}s.\n\n"
            f"### Spoken Transcript for this section:\n\"{chunk_transcript}\"\n\n"
            f"### Visuals:\nI have provided sequential frames from this section below.\n\n"
            "Combine what is spoken in the transcript with what is happening visually. "
            "Identify any symbols, actions, or underlying truths. Create a comprehensive markdown "
            "knowledge base entry for this section. "
            f"{sys_prompt_addendum}"
        )

        analysis = analyze_section(env, omni_model, omni_provider, c_title, frames, prompt)
        
        if analysis:
            print(f"✓ Analysis complete for {c_title}\n")
            with open(results_path, "a") as out:
                out.write(f"## {c_title} ({start}s - {end}s)\n\n")
                out.write(f"{analysis}\n\n")
        else:
            print(f"✗ Failed to analyze {c_title}\n")

    print(f"\nAll done! Analysis saved to: {results_path}")

if __name__ == "__main__":
    main()
