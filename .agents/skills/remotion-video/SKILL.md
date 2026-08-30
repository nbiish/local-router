---
name: remotion-video
description: >
  Expert skill for creating programmatic videos with Remotion using coding agents (Claude Code, Codex, OpenCode).
  Covers project scaffolding, all APIs (interpolate, spring, Easing, Sequence, Series, TransitionSeries, AbsoluteFill),
  media components (Video, Audio, Img, Gif), 3D (ThreeCanvas), captions, fonts, Tailwind, Lottie, audio visualization,
  parameterized videos with Zod, dynamic metadata, the llms.txt system prompt, Agent Skills from agentskills.io,
  MCP server, LLM code generation with Vercel AI SDK, just-in-time dynamic compilation, Lambda rendering, and
  video-layout design rules. Use when the user wants to create, generate, or render videos programmatically with React.
version: 2.0.0
---

# Remotion — Programmatic Video with Coding Agents

Remotion is a React framework for creating videos programmatically. All output is valid React/TypeScript. Coding agents (Claude Code, Codex, OpenCode) can generate complete video compositions from natural language prompts.

## Quick Start

```bash
# 1. Scaffold a new project (Blank template, no Tailwind by default)
npx create-video@latest --yes --blank --no-tailwind my-video

# 2. Enter project, install, start Studio preview
cd my-video && npm install && npm start
# or: npx remotion studio

# 3. In a separate terminal, start coding agent
cd my-video && claude   # or: codex / opencode
```

The Studio opens a preview at `localhost:3000`. The coding agent can now generate and modify React components that render as live video. Changes hot-reload in the Studio.

**Tip:** Add `.md` to any Remotion doc URL (e.g. `remotion.dev/docs/player.md`) to fetch raw markdown. Docs also respect `Accept: text/markdown` header — paste any doc link into your coding agent and it auto-fetches markdown.

## Reference Docs

| Resource | URL | Purpose |
|----------|-----|---------|
| **llms.txt** | `https://www.remotion.dev/llms.txt` | Full API reference for LLMs |
| **Coding Agents** | `https://www.remotion.dev/docs/ai/coding-agents` | Tutorial + 5-min video walkthrough |
| **Skills** | `https://www.remotion.dev/docs/ai/skills` | Modular agent skill system |
| **Code Generation** | `https://www.remotion.dev/docs/ai/generate` | LLM→code patterns with Vercel AI SDK |
| **Dynamic Compilation** | `https://www.remotion.dev/docs/ai/dynamic-compilation` | JIT compile generated code in browser |
| **MCP Server** | `https://www.remotion.dev/docs/ai/mcp` | Remotion docs lookup via MCP |
| **Prompt→Motion SaaS** | `https://www.remotion.dev/docs/ai/ai-saas-template` | Next.js starter for AI video SaaS |
| **System Prompt** | `https://www.remotion.dev/docs/ai/system-prompt` | Hosted system prompt |
| **Agent Skills registry** | `https://agentskills.io` | Community skill modules |
| **GitHub Skills** | `https://github.com/remotion-dev/remotion/tree/main/packages/skills/skills/remotion` | 40+ official rule files |
| **Chatbot** | `https://remotion.ai` | AI answers about Remotion (also ⌘I in Studio) |

Install official agent skills into a project:
```bash
npx skills add remotion-dev/skills
```

## Project Structure

```
my-video/
├── public/              # Static assets (referenced via staticFile())
│   ├── audio.mp3
│   └── video.mp4
├── src/
│   ├── index.ts         # Entry: registerRoot(Root)
│   ├── Root.tsx          # Defines <Composition> and <Still> entries
│   └── MyComp.tsx        # React component (the video)
├── remotion.config.ts    # Optional: Webpack overrides, Tailwind, etc.
└── package.json
```

### Entry file (`src/index.ts`)
```ts
import {registerRoot} from 'remotion';
import {Root} from './Root';
registerRoot(Root);
```

### Root file (`src/Root.tsx`)
```tsx
import {Composition, Still, Folder} from 'remotion';
import {MyComp, MyCompProps} from './MyComp';
import {Thumbnail} from './Thumbnail';

export const RemotionRoot: React.FC = () => (
  <>
    <Folder name="Marketing">
      <Composition
        id="MyComp"
        component={MyComp}
        durationInFrames={120}
        width={1920}
        height={1080}
        fps={30}
        defaultProps={{ title: 'Hello' } satisfies MyCompProps}
      />
    </Folder>
    <Still id="Thumbnail" component={Thumbnail} width={1280} height={720} />
  </>
);
```

**Defaults:** `id="MyComp"`, `width=1920`, `height=1080`, `fps=30`. Use `type` for props (not `interface`) for `defaultProps` type safety. `Folder` organizes in the sidebar. `Still` renders a single image — no `durationInFrames` or `fps` needed.

### Dynamic metadata with `calculateMetadata`

```tsx
import {Composition, CalculateMetadataFunction} from 'remotion';

const calculateMetadata: CalculateMetadataFunction<MyCompProps> = async ({props, abortSignal}) => {
  const data = await fetch(`https://api.example.com/video/${props.videoId}`, {signal: abortSignal})
    .then(res => res.json());
  return {
    durationInFrames: Math.ceil(data.duration * 30),
    props: {...props, videoUrl: data.url},
    width: 1080,
    height: 1080,
  };
};

<Composition
  id="MyComp"
  component={MyComp}
  fps={30}
  width={1080}
  height={1080}
  defaultProps={{videoId: 'abc123'}}
  calculateMetadata={calculateMetadata}
/>
```

Can return `props`, `durationInFrames`, `width`, `height`, `fps`, and codec defaults. Runs once before rendering.

### Parameterized videos with Zod

```tsx
// src/MyComp.tsx
import {z} from 'zod';
import {zColor} from '@remotion/zod-types';

export const MyCompSchema = z.object({
  title: z.string(),
  bgColor: zColor(),
});

const MyComp: React.FC<z.infer<typeof MyCompSchema>> = (props) => (
  <div style={{backgroundColor: props.bgColor}}>{props.title}</div>
);

// src/Root.tsx — pass schema to Composition for visual parameter editing in sidebar
<Composition id="MyComp" component={MyComp} schema={MyCompSchema} defaultProps={{title: 'Hello', bgColor: '#000'}} ... />
```

Top-level must be `z.object()`. Install `zod` and `@remotion/zod-types` (for `zColor()`) as needed.

## Core Animation APIs

### useCurrentFrame() and useVideoConfig()

```tsx
import {useCurrentFrame, useVideoConfig} from 'remotion';

const frame = useCurrentFrame();                         // 0-based frame counter
const {fps, durationInFrames, width, height} = useVideoConfig();
```

### interpolate() — Animate values over time

```tsx
import {interpolate, Easing} from 'remotion';

// Basic linear
const opacity = interpolate(frame, [0, 100], [0, 1], {
  extrapolateLeft: 'clamp',
  extrapolateRight: 'clamp',
});

// With Bézier easing (same params as CSS cubic-bezier)
const enter = interpolate(frame, [0, 45], [0, 1], {
  easing: Easing.bezier(0.16, 1, 0.3, 1),    // Crisp entrance
  extrapolateLeft: 'clamp',
  extrapolateRight: 'clamp',
});

// Preset easings
const v = interpolate(frame, [0, 100], [0, 1], {
  easing: Easing.out(Easing.cubic),            // Good default
  extrapolateLeft: 'clamp',
  extrapolateRight: 'clamp',
});
```

**Always add `extrapolateLeft/Right: 'clamp'`.** The default is no clamping (values continue past the range).

**Copy-paste Bézier curves:**
- Crisp entrance (strong ease-out): `Easing.bezier(0.16, 1, 0.3, 1)`
- Editorial slow fade (balanced): `Easing.bezier(0.45, 0, 0.55, 1)`
- Playful overshoot: `Easing.bezier(0.34, 1.56, 0.64, 1)`

**Easing direction convention:** `Easing.out` for enter animations (fast arrive, decelerate). `Easing.in` for exit (slow start, accelerate away).

**Composing interpolations** — separate timing from mapping:
```tsx
const slideIn = interpolate(frame, [start, start + dur], [0, 1], {easing: ..., extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
const slideOut = interpolate(frame, [outStart, outStart + dur], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
const progress = slideIn - slideOut;

// Derive multiple properties from one progress value
const x = interpolate(progress, [0, 1], [100, 0]);
const opacity = interpolate(progress, [0, 1], [0, 1]);
```

**Named curves (most linear → most curved):** `Easing.quad`, `Easing.cubic`, `Easing.sin`, `Easing.exp`, `Easing.circle`.

### spring() — Physics-based motion

```tsx
import {spring} from 'remotion';

const scale = spring({fps, frame, config: {damping: 200}});
// Returns 0→1 with spring easing. Duration is NOT fixed — depends on config.
```

### Determinism

**CSS transitions/animations are FORBIDDEN** — they will not render correctly.
**Tailwind animation classes are FORBIDDEN** (e.g. `animate-bounce`, `transition-all`).
**Never use `Math.random()`.** Use Remotion's deterministic `random()`:

```tsx
import {random} from 'remotion';
const val = random('my-seed');  // Returns 0–1, same result every render
```

## Layout & Timing Components

### AbsoluteFill — Layer elements

```tsx
import {AbsoluteFill} from 'remotion';

<AbsoluteFill>
  <AbsoluteFill style={{background: 'blue'}}>Back layer</AbsoluteFill>
  <AbsoluteFill style={{background: 'red'}}>Front layer</AbsoluteFill>
</AbsoluteFill>
```

### Sequence — Delay, trim, limit duration

```tsx
import {Sequence} from 'remotion';

// Appears at frame 30, lasts 60 frames
<Sequence from={30} durationInFrames={60}>
  <Title />
</Sequence>

// Negative from: starts immediately but cuts first N frames (trim beginning)
<Sequence from={-15}>
  <MyAnimation />    {/* useCurrentFrame() inside starts at 15 */}
</Sequence>

// Inline layout (not absolute-fill wrapper)
<Sequence layout="none">
  <InlineElement />
</Sequence>

// Always premount Sequences for smoother rendering
<Sequence premountFor={1 * fps}>
  <Title />
</Sequence>
```

Inside a Sequence, `useCurrentFrame()` returns the **local** frame (starting at 0).

### Series — Elements one after another

```tsx
import {Series} from 'remotion';

<Series>
  <Series.Sequence durationInFrames={45}><Intro /></Series.Sequence>
  <Series.Sequence durationInFrames={60}><MainContent /></Series.Sequence>
  <Series.Sequence durationInFrames={30} offset={-15}><Outro /></Series.Sequence>
</Series>
```

Negative `offset` creates overlap. Default layout is `AbsoluteFill`; use `layout="none"` for inline.

### TransitionSeries — Scenes with transitions

Install: `npx remotion add @remotion/transitions`

```tsx
import {TransitionSeries, linearTiming, springTiming} from '@remotion/transitions';
import {fade} from '@remotion/transitions/fade';
import {slide} from '@remotion/transitions/slide';
import {wipe} from '@remotion/transitions/wipe';
import {flip} from '@remotion/transitions/flip';
import {clockWipe} from '@remotion/transitions/clock-wipe';

<TransitionSeries>
  <TransitionSeries.Sequence durationInFrames={60}><SceneA /></TransitionSeries.Sequence>
  <TransitionSeries.Transition
    presentation={fade()}
    timing={linearTiming({durationInFrames: 15})}
  />
  <TransitionSeries.Sequence durationInFrames={60}><SceneB /></TransitionSeries.Sequence>
  <TransitionSeries.Transition
    presentation={slide({direction: 'from-left'})}
    timing={springTiming({config: {damping: 200}, durationInFrames: 25})}
  />
  <TransitionSeries.Sequence durationInFrames={60}><SceneC /></TransitionSeries.Sequence>
</TransitionSeries>
```

**Transition tags must sit between Sequence tags.** No `offset` prop on `TransitionSeries.Sequence`.

**Duration math:** Transitions overlap adjacent scenes, so total = sum of sequences minus transition durations. Overlays do NOT affect total duration.

**Slide directions:** `"from-left"`, `"from-right"`, `"from-top"`, `"from-bottom"`.

### Overlays — Effects on top of cuts (no timeline shortening)

```tsx
import {LightLeak} from '@remotion/light-leaks';

<TransitionSeries>
  <TransitionSeries.Sequence durationInFrames={60}><SceneA /></TransitionSeries.Sequence>
  <TransitionSeries.Overlay durationInFrames={30}>
    <LightLeak />
  </TransitionSeries.Overlay>
  <TransitionSeries.Sequence durationInFrames={60}><SceneB /></TransitionSeries.Sequence>
</TransitionSeries>
```

Overlay `offset` prop shifts relative to cut center. Positive = later, negative = earlier.

**Constraint:** An overlay cannot be adjacent to a transition or another overlay.

### Nesting compositions

```tsx
<AbsoluteFill>
  <Sequence width={COMPOSITION_WIDTH} height={COMPOSITION_HEIGHT}>
    <CompositionComponent />
  </Sequence>
</AbsoluteFill>
```

## Media Components

All media from `@remotion/media` (install: `npx remotion add @remotion/media`). Assets go in `public/` and are referenced via `staticFile()`.

### Video

```tsx
import {Video} from '@remotion/media';
import {staticFile} from 'remotion';

<Video
  src={staticFile('video.mp4')}
  style={{width: '100%', objectFit: 'cover'}}
  trimBefore={2 * fps}       // Skip first 2 seconds (in frames)
  trimAfter={10 * fps}        // End at 10-second mark
  volume={0.5}                // Static 0-1
  volume={(f) => interpolate(f, [0, fps], [0, 1], {extrapolateRight: 'clamp'})}  // Dynamic
  muted={frame >= 2 * fps && frame <= 4 * fps}
  playbackRate={2}            // 2x speed (no reverse)
  loop
  loopVolumeCurveBehavior="extend"  // "repeat" (default) or "extend"
  toneFrequency={1.5}         // Pitch shift (0.01-2), SSR only
/>
```

### Audio

```tsx
import {Audio} from '@remotion/media';

<Audio src={staticFile('audio.mp3')} volume={0.5} loop />
// Same props as Video: trimBefore, trimAfter, volume (static or callback), muted, playbackRate, loop, toneFrequency
```

Multiple audio tracks layer naturally by adding multiple `<Audio>` components. Wrap in `<Sequence from={fps}>` to delay.

### Sound effects

```tsx
import {Audio} from '@remotion/sfx';

<Audio src="https://remotion.media/whoosh.wav" />
```

Available SFX URLs: `whoosh`, `whip`, `page-turn`, `switch`, `mouse-click`, `shutter-modern`, `shutter-old`, `ding`, `vine-boom`, `wilhelm-scream`, `minecraft-hurt`, and more at `https://remotion.media/<name>.wav`.

### Images

```tsx
import {Img, staticFile} from 'remotion';

<Img src={staticFile('logo.png')} style={{width: 100, height: 100, objectFit: 'cover'}} />

// Dynamic paths
<Img src={staticFile(`frames/frame${frame}.png`)} />
<Img src={staticFile(`icons/${isActive ? 'active' : 'inactive'}.svg`)} />

// Get dimensions
import {getImageDimensions} from 'remotion';
const {width, height} = await getImageDimensions(staticFile('photo.png'));
```

### GIFs

Install: `npx remotion add @remotion/gif`

```tsx
import {Gif} from '@remotion/gif';
<Gif src="https://media.giphy.com/media/xyz/giphy.gif" style={{width: '100%'}} />
```

Synchronized with Remotion's timeline.

## Fonts

### Google Fonts (recommended)

Install: `npx remotion add @remotion/google-fonts`

```tsx
import {loadFont} from '@remotion/google-fonts/Montserrat';

const {fontFamily} = loadFont('normal', {
  weights: ['400', '700'],
  subsets: ['latin'],
});

export const Title: React.FC = () => (
  <h1 style={{fontFamily, fontSize: 80, fontWeight: 'bold'}}>Hello</h1>
);
```

Automatically blocks rendering until the font is ready. Call `loadFont()` at the top level of the component file.

### Local fonts

```tsx
import {loadFont} from '@remotion/google-fonts/LocalFont';
// See rules/local-fonts.md for full instructions
```

## 3D Content (Three.js / React Three Fiber)

Install: `npx remotion add @remotion/three`

```tsx
import {ThreeCanvas} from '@remotion/three';
import {useVideoConfig} from 'remotion';

const {width, height} = useVideoConfig();

<ThreeCanvas width={width} height={height}>
  <ambientLight intensity={0.4} />
  <directionalLight position={[5, 5, 5]} intensity={0.8} />
  <mesh rotation={[0, frame * 0.02, 0]}>
    <boxGeometry args={[2, 2, 2]} />
    <meshStandardMaterial color="#4a9eff" />
  </mesh>
</ThreeCanvas>
```

**Rules:**
- MUST wrap in `<ThreeCanvas>` with `width` and `height` props
- MUST include lighting
- MUST NOT use self-animating shaders or `useFrame()` from R3F — causes flickering during render
- All animation MUST be driven by `useCurrentFrame()`
- `<Sequence>` inside `<ThreeCanvas>` must have `layout="none"`

## Lottie Animations

Install: `npx remotion add @remotion/lottie`

```tsx
import {Lottie, LottieAnimationData} from '@remotion/lottie';
import {useState, useEffect} from 'react';
import {delayRender, continueRender, cancelRender} from 'remotion';

export const MyAnimation = () => {
  const [handle] = useState(() => delayRender('Loading Lottie'));
  const [animationData, setAnimationData] = useState<LottieAnimationData | null>(null);

  useEffect(() => {
    fetch('https://assets4.lottiefiles.com/packages/lf20_zyquagfl.json')
      .then(r => r.json())
      .then(json => { setAnimationData(json); continueRender(handle); })
      .catch(err => cancelRender(err));
  }, [handle]);

  if (!animationData) return null;
  return <Lottie animationData={animationData} style={{width: 400, height: 400}} />;
};
```

## Audio Visualization

Install: `npx remotion add @remotion/media-utils`

### Spectrum bars
```tsx
import {useWindowedAudioData, visualizeAudio} from '@remotion/media-utils';

const {audioData, dataOffsetInSeconds} = useWindowedAudioData({
  src: staticFile('music.mp3'), frame, fps, windowInSeconds: 30,
});
if (!audioData) return null;

const frequencies = visualizeAudio({
  fps, frame, audioData, numberOfSamples: 256, optimizeFor: 'speed', dataOffsetInSeconds,
});
// numberOfSamples must be power of 2 (32-1024). Values 0-1. Left=bass, right=highs.
```

### Waveform
```tsx
import {visualizeAudioWaveform, createSmoothSvgPath} from '@remotion/media-utils';

const waveform = visualizeAudioWaveform({
  fps, frame, audioData, numberOfSamples: 256, windowInSeconds: 0.5, dataOffsetInSeconds,
});
const path = createSmoothSvgPath({
  points: waveform.map((y, i) => ({x: (i / (waveform.length - 1)) * width, y: HEIGHT / 2 + (y * HEIGHT) / 2})),
});
```

### Bass-reactive effects
```tsx
const bass = frequencies.slice(0, 32);
const intensity = bass.reduce((sum, v) => sum + v, 0) / bass.length;
const scale = 1 + intensity * 0.5;
```

**Important:** When passing `audioData` to child components, also pass `frame` from the parent. Do not call `useCurrentFrame()` in each child — causes discontinuous visualization when inside `<Sequence>` with offsets.

## Captions & Subtitles

```tsx
import type {Caption} from '@remotion/captions';

type Caption = {
  text: string;
  startMs: number;
  endMs: number;
  timestampMs: number | null;
  confidence: number | null;
};
```

See official rules for: transcribing (`transcribe-captions.md`), displaying (`display-captions.md`), importing SRT (`import-srt-captions.md`).

## TailwindCSS

Can be enabled during `npx create-video@latest` or installed after:
```bash
npm i -D @remotion/tailwind-v4 tailwindcss
```

Then add to `remotion.config.ts`:
```ts
import {Config} from '@remotion/cli/config';
import {enableTailwind} from '@remotion/tailwind-v4';
Config.overrideWebpackConfig((currentConfiguration) => enableTailwind(currentConfiguration));
```

Create `src/index.css` with `@import 'tailwindcss';` and import in `Root.tsx`. Ensure `package.json` doesn't have `"sideEffects": false` (or add `["*.css"]` exception).

**FORBIDDEN in Tailwind:** `transition-*` classes, `animate-*` classes — they won't render. Always animate via `useCurrentFrame()`.

## Video Layout Design Rules

Videos are watched differently than web pages. Design for quick understanding from the full frame.

1. **One focal point per scene** — build the frame around one thing the viewer should notice first
2. **Safe area** — keep key text ≥80px from sides and ≥100px from top/bottom (for 1080px-wide)
3. **Text sizing** (for 1080px-wide): headline ≥84px, supporting ≥44px, labels ≥32px. Scale with width.
4. **Centered/stacked layouts** — avoid scattered dashboard-like layouts
5. **Use flex/grid/gap for layout** — absolute positioning only for backgrounds and decorative shapes
6. **Animate from reserved slots** — use `opacity`, `transform`, `scale`; don't animate into occupied space
7. **Solve crowding with time** — reveal elements one after another instead of shrinking everything
8. **Short lines** — break long text into multiple scenes rather than shrinking font
9. **Strong contrast** — add backing shapes if text is hard to read against background
10. **Consistent system** — repeat spacing, alignment, and a small set of shapes/colors across scenes

## Rendering

```bash
# Studio (dev preview)
npx remotion studio                # or: npm start

# One-frame sanity check
npx remotion still MyComp --scale=0.25 --frame=30

# Render video
npx remotion render MyComp         # defaults to out/MyComp.mp4
npx remotion render                # shows picker

# Render still image
npx remotion still MyComp

# Audio-only export
npx remotion render --codec mp3 MyComp

# Image sequence
npx remotion render --sequence MyComp
```

### AWS Lambda rendering

```bash
npx remotion lambda functions deploy
npx remotion lambda sites create src/index.ts
npx remotion lambda render MyComp
```

Node.js API equivalents: `deployFunction()`, `deploySite()`, `renderMediaOnLambda()`, poll with `getRenderProgress()`.

**Lambda limits:** ~80 min at Full HD, 10GB storage, 1000 concurrent lambdas default.

### Google Cloud Run (alpha)
Available at `https://www.remotion.dev/docs/cloudrun`.

### Render variants
- GIF: `npx remotion render --codec gif`
- Transparent video (overlay): see `docs/overlay`
- GitHub Actions: see `docs/ssr#render-using-github-actions`

## LLM Code Generation

### Basic generation with Vercel AI SDK

All LLM calls route through **OpenRouter** (primary) with **ZenMux** as fallback proxy, using `google/gemini-3.1-flash-lite` for fast, cost-effective video code generation.

```ts
import {generateText} from 'ai';
import {createOpenAI} from '@ai-sdk/openai';

// ── Provider Setup: OpenRouter (primary) + ZenMux (fallback) ──────────────
// Both are OpenAI-compatible, so we use the same SDK with different base URLs.

const openrouter = createOpenAI({
  apiKey: process.env.OPENROUTER_API_KEY!,
  baseURL: 'https://openrouter.ai/api/v1',
});

const zenmux = createOpenAI({
  apiKey: process.env.ZENMUX_API_KEY!,
  baseURL: process.env.ZENMUX_BASE_URL!, // e.g. https://zenmux.ai/v1
});

// Default model for Remotion code generation
const MODEL = 'google/gemini-3.1-flash-lite';

const systemPrompt = `You are a Remotion component generator.
Rules:
- Export as named export "MyComposition"
- Use useCurrentFrame() and useVideoConfig() from "remotion"
- Animate with interpolate() or spring()
- Only output code, no markdown`.trim();

// Try OpenRouter first, fall back to ZenMux on failure
let code: string;
try {
  const result = await generateText({
    model: openrouter(MODEL),
    system: systemPrompt,
    prompt: 'Create a countdown from 5 to 1 with smooth motion',
  });
  code = result.text;
} catch (err) {
  console.warn('[Remotion] OpenRouter failed, falling back to ZenMux:', err);
  const result = await generateText({
    model: zenmux(MODEL),
    system: systemPrompt,
    prompt: 'Create a countdown from 5 to 1 with smooth motion',
  });
  code = result.text;
}
```

### Structured output with Zod

```ts
import {generateText, Output} from 'ai';
import {z} from 'zod';

const {output} = await generateText({
  model: openrouter('google/gemini-3.1-flash-lite'),
  system: systemPrompt,
  prompt: 'Create a typing animation for "Hello World"',
  maxRetries: 3,
  output: Output.object({
    schema: z.object({
      code: z.string().describe('Complete React component code'),
      title: z.string().describe('Short title'),
      durationInFrames: z.number().describe('Recommended duration'),
      fps: z.number().min(1).max(120).describe('Recommended FPS'),
    }),
  }),
});
```

### Skill-based context injection

Instead of one giant system prompt, detect which skills are relevant and load only those:

```ts
const SKILL_NAMES = ['charts', 'typography', 'transitions', 'spring-physics', '3d'] as const;

// Step 1: Classify with fast/cheap model (same gemini-3.1-flash-lite via OpenRouter)
const {output: detectedSkills} = await generateText({
  model: openrouter('google/gemini-3.1-flash-lite'),
  prompt: userPrompt,
  output: Output.object({
    schema: z.object({skills: z.array(z.enum(SKILL_NAMES))}),
  }),
});

// Step 2: Load only relevant skills
const skillContent = detectedSkills.skills.map(s => loadSkillMarkdown(s)).join('\n\n');

// Step 3: Generate with focused context
const {output} = await generateText({
  model: openrouter('google/gemini-3.1-flash-lite'),
  system: baseSystemPrompt + '\n\n' + skillContent,
  prompt: userPrompt,
  output: Output.object({...}),
});
```

### Prompt→Motion Graphics SaaS template

```bash
npx create-video@latest --template prompt-to-motion-graphics
```

Features: chat interface, live Player preview, smart editing (targeted edits or full replacement), input validation, LLM output sanitation, self-correction on compilation errors, Lambda rendering. Requires `OPENROUTER_API_KEY` in `.env` (and optionally `ZENMUX_API_KEY` + `ZENMUX_BASE_URL` for fallback). Set model to `google/gemini-3.1-flash-lite`.

**Images vs URLs in prompts:**
- **Attached images** → assistant tries to replicate the image in code
- **URL references** → assistant embeds the image in the animation

## Just-in-Time Dynamic Compilation

Compile AI-generated code strings into live React components in the browser:

```ts
import * as Babel from '@babel/standalone';
import React, {useMemo} from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate, Sequence} from 'remotion';

function useCompilation(code: string) {
  return useMemo(() => {
    if (!code?.trim()) return {Component: null, error: null};
    try {
      // 1. Strip imports (these are injected manually)
      const codeWithoutImports = code.replace(/^import\s+.*$/gm, '').trim();

      // 2. Extract component body
      const match = codeWithoutImports.match(/export\s+const\s+\w+\s*=\s*\(\s*\)\s*=>\s*\{([\s\S]*)\};?\s*$/);
      const body = match ? match[1].trim() : codeWithoutImports;
      const wrapped = `const DynamicComponent = () => {\n${body}\n};`;

      // 3. Transpile JSX/TS
      const transpiled = Babel.transform(wrapped, {
        presets: ['react', 'typescript'],
        filename: 'dynamic.tsx',
      });
      if (!transpiled.code) return {Component: null, error: 'Transpilation failed'};

      // 4. Create component with injected APIs
      const create = new Function(
        'React', 'AbsoluteFill', 'useCurrentFrame', 'useVideoConfig',
        'spring', 'interpolate', 'Sequence',
        `${transpiled.code}\nreturn DynamicComponent;`
      );
      return {
        Component: create(React, AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate, Sequence),
        error: null,
      };
    } catch (error) {
      return {Component: null, error: error instanceof Error ? error.message : 'Unknown error'};
    }
  }, [code]);
}
```

Render via Player:
```tsx
import {Player} from '@remotion/player';

const {Component, error} = useCompilation(generatedCode);
return Component
  ? <Player component={Component} durationInFrames={150} fps={30} compositionWidth={1920} compositionHeight={1080} controls />
  : <div>Error: {error}</div>;
```

**Security:** Dynamic compilation runs in global scope. For production, sandbox in an iframe with CSP.

## MCP Server (Cursor / VS Code / Claude Code)

```json
{
  "mcpServers": {
    "remotion-documentation": {
      "command": "npx",
      "args": ["@remotion/mcp@latest"]
    }
  }
}
```

Indexes Remotion docs into a vector database via CrawlChat for real-time context during code generation.

## Agent Skills System

The official skills (`npx skills add remotion-dev/skills`) install 40+ modular rule files under `.skills/remotion/rules/`. The agent loads relevant rules based on the task. Available rules:

| Category | Rules |
|----------|-------|
| **Layout** | video-layout, measuring-dom-nodes, measuring-text |
| **Animation** | timing, text-animations, transitions, trimming, sequencing |
| **Media** | videos, audio, audio-visualization, sfx, images, gifs, light-leaks |
| **3D** | 3d |
| **Fonts** | google-fonts, local-fonts |
| **Captions** | subtitles, display-captions, transcribe-captions, import-srt-captions |
| **Data** | parameters, calculate-metadata, compositions |
| **Integrations** | lottie, maplibre, html-in-canvas, voiceover (ElevenLabs TTS) |
| **Tailwind** | tailwind |
| **Tools** | ffmpeg, silence-detection, get-audio-duration, get-video-dimensions, get-video-duration |

## Additional Tools

- **Voiceover** — AI-generated voice with ElevenLabs TTS (see `rules/voiceover.md`)
- **Maps** — Static map images for simple maps; MapLibre for animated routes (see `rules/maplibre.md`)
- **HTML in canvas** — Render HTML into `<canvas>` for 2D/WebGL effects via `<HtmlInCanvas>` (see `rules/html-in-canvas.md`)
- **Measuring text** — `measureText()` for fitting text to containers (see `rules/measuring-text.md`)
- **FFmpeg** — Trimming, silence detection, media operations (see `rules/ffmpeg.md`)

## Best Practices

1. **Start simple** — Get a static composition working, then add animation
2. **Always premount Sequences** — `<Sequence premountFor={1 * fps}>` for smoother rendering
3. **Always clamp extrapolation** — `extrapolateLeft: 'clamp'` and `extrapolateRight: 'clamp'`
4. **Never use CSS animations or Tailwind animation classes** — Only `useCurrentFrame()` + `interpolate()`/`spring()`
5. **Never use `Math.random()`** — Use `random('seed')` from Remotion
6. **Use `layout="none"` on Sequence** when you don't want absolute-fill wrapping
7. **Use flex/grid for readable content** — absolute positioning only for decorative/background elements
8. **Use `useVideoConfig()` for fps** — never hardcode fps; derive durations with `fps * seconds`
9. **One focal point per scene** — solve crowding with time, not smaller text
10. **Load llms.txt** — `https://www.remotion.dev/llms.txt` teaches any LLM all Remotion APIs
11. **Watch for context rot** — keep prompts focused; quality degrades as context grows
12. **Sanity-check with a still** — `npx remotion still MyComp --scale=0.25 --frame=30`
13. **Default composition** — 1920x1080 @ 30fps unless user specifies otherwise
14. **Iterate with live preview** — keep Studio running while the agent edits
