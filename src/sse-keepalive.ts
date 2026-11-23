/**
 * sse-keepalive.ts — idle keepalive for text/event-stream relay paths.
 *
 * Problem (measured live 2026-11-23): streaming chat completions relayed through
 * the public HTTPS bridge (cloudflared tunnel) die mid-stream during upstream
 * silence — agent tool runs and silent reasoning pauses regularly exceed the
 * tunnel's ~100 s read timeout, and the connection is reset even though the
 * router considers the stream healthy (its own idle watchdog allows 120 s).
 * A 200 s stream with continuous output completes fine, so the killer is idle
 * gaps, not total duration.
 *
 * Fix: while relaying `text/event-stream`, inject SSE comment lines
 * (`: ping\n\n`) whenever the upstream has been silent for the keepalive
 * interval. SSE comments are legal at the protocol level and every conforming
 * client ignores them — they carry no event, no tokens, and no data. The
 * comment keeps bytes moving through the tunnel so idle-timeout proxies never
 * see a dead connection.
 *
 * Safety rule: a keepalive is only written at a verified SSE event boundary
 * (tracked by a byte-level state machine — a blank line, i.e. `\n\n`, ends an
 * event). An in-flight frame is never interleaved with a comment; if silence
 * begins mid-frame the injection is skipped until the frame completes.
 *
 * Scope: only `text/event-stream` responses. NDJSON (Ollama wire) responses are
 * untouched — `: ping` is not a legal JSON line and would break line parsers.
 * Non-stream responses cannot carry keepalives at all: an upstream that stalls
 * before its first byte still dies at the tunnel (the router's own
 * NON_STREAM_TIMEOUT_MS guard is the backstop there).
 */

/** Bytes written during upstream silence. Legal SSE comment line(s). */
export const SSE_KEEPALIVE_COMMENT = ': ping\n\n';

/** Default silence duration before a keepalive is injected. */
export const SSE_KEEPALIVE_INTERVAL_MS = Number(process.env.LOCAL_ROUTER_SSE_KEEPALIVE_MS) > 0
  ? Number(process.env.LOCAL_ROUTER_SSE_KEEPALIVE_MS)
  : 15000;

/** Marker for destinations that are translator fakes, not the client socket. */
const NON_TERMINAL = Symbol.for('local-router.sse-keepalive.non-terminal');

/** Idempotency marker: one keepalive guard per response object. */
const ATTACHED = Symbol.for('local-router.sse-keepalive.attached');

type StreamDestination = {
  write: (chunk: any, encoding?: any, callback?: any) => boolean;
  on: (event: string, listener: (...args: any[]) => void) => any;
  writableEnded?: boolean;
  destroyed?: boolean;
};

/**
 * Mark a response object as a translator fake (an intermediate Writable whose
 * bytes feed a wire translator, not the client). `attachSseKeepalive` refuses to
 * attach to these: injecting a comment into translator input would silently
 * disappear instead of reaching the client.
 */
export function markNonTerminal(res: object): void {
  (res as any)[NON_TERMINAL] = true;
}

/**
 * Attach an idle keepalive to a streaming response. Returns a dispose function;
 * calling it (or the response closing) stops the timer. Idempotent: attaching
 * twice to the same response returns the original dispose and installs nothing
 * new.
 */
export function attachSseKeepalive(
  res: StreamDestination,
  intervalMs: number = SSE_KEEPALIVE_INTERVAL_MS
): () => void {
  const target = res as any;
  if (target[NON_TERMINAL]) {
    return () => { /* translator fake — nothing installed */ };
  }
  if (target[ATTACHED]) {
    return target[ATTACHED];
  }

  const originalWrite = target.write.bind(target);

  // SSE event-boundary tracking. An injection is safe exactly when the stream
  // position is at the start of a fresh line AND no event is half-open — which,
  // for SSE, means the previous line was blank (`\n\n` dispatches the event).
  // A comment line after a completed `data:` line but before its blank line
  // would still parse (comments are ignored), but mid-line injection would
  // corrupt the data line, so "last completed line was blank" is the one rule
  // that is safe for every client parser.
  let lineHasContent = false;
  let atEventBoundary = true;
  const absorb = (chunk: any) => {
    if (chunk == null) return;
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(typeof chunk === 'string' ? chunk : String(chunk), 'utf8');
    for (const byte of buf) {
      if (byte === 0x0a) {
        atEventBoundary = !lineHasContent;
        lineHasContent = false;
      } else {
        lineHasContent = true;
        atEventBoundary = false;
      }
    }
  };

  let lastWriteAt = Date.now();
  let stopped = false;

  const wrappedWrite = function (this: unknown, chunk: any, encoding?: any, callback?: any) {
    if (!stopped && chunk != null) {
      try {
        absorb(chunk);
        lastWriteAt = Date.now();
      } catch {
        /* never let bookkeeping break the relay */
      }
    }
    return originalWrite(chunk, encoding, callback);
  };
  target.write = wrappedWrite;

  // Fast enough to fire promptly after the interval elapses, cheap enough to be
  // free: a third of the interval, floored at 25 ms and capped at 1 s.
  const tickMs = Math.max(25, Math.min(1000, Math.floor(intervalMs / 3)));
  const timer = setInterval(() => {
    if (stopped) return;
    const dest = res as StreamDestination;
    if (dest.writableEnded || dest.destroyed) return;
    if (Date.now() - lastWriteAt < intervalMs) return;
    // Mid-frame: skip this tick rather than interleave into an active event.
    if (!atEventBoundary) return;
    try {
      absorb(SSE_KEEPALIVE_COMMENT);
      lastWriteAt = Date.now();
      originalWrite(SSE_KEEPALIVE_COMMENT);
    } catch {
      /* destination already gone; the close handler disposes */
    }
  }, tickMs);
  // A finished request must not pin the event loop.
  (timer as any).unref?.();

  const dispose = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
  target[ATTACHED] = dispose;

  res.on('close', dispose);
  res.on('finish', dispose);

  return dispose;
}
