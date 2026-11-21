/**
 * durability.ts — keep the router alive and honest across days of unattended
 * operation.
 *
 * Why this exists (audit 2026-11-20): the router had **no** `uncaughtException`
 * or `unhandledRejection` handler and no signal handling. Verified on Node 22:
 * a single stray rejected promise terminates the process. For an interactive
 * session that is a nuisance; for a router that is meant to power an agent
 * running unattended for days it is a hard stop — the agent's next turn simply
 * fails, and nothing on disk says why.
 *
 * The policy here is deliberately *survive and record*, not *swallow*:
 *
 *  - A failure escaping a request path is logged with full context, counted,
 *    and recorded as a receipt (`lastIncident`), then the process keeps serving.
 *    One bad request must not take down every other in-flight agent.
 *  - The incident is exposed on `/api/health`, so a repeat pattern is visible
 *    rather than silently absorbed. A router that keeps answering with corrupt
 *    state would be worse than one that stops, so repeats are surfaced loudly.
 *  - A failure during BOOT is still fatal: the process never became healthy, and
 *    the supervisor should restart it.
 *
 * Shutdown is the other half. A SIGTERM used to kill the process mid-stream,
 * truncating whatever an agent was receiving. `installShutdown` now stops
 * accepting, lets in-flight work finish for a bounded grace period, and exits 0
 * so the supervisor treats it as a deliberate stop rather than a crash.
 */

import type { Server } from 'http';

/** One observed crash-level event, kept for `/api/health`. */
export interface Incident {
  /** ISO timestamp of the most recent occurrence. */
  at: string;
  /** `uncaughtException` | `unhandledRejection` | `requestError`. */
  kind: string;
  /** Sanitized one-line message. */
  message: string;
  /** How many incidents of any kind have been observed since boot. */
  total: number;
  /** How many of this same kind+message, so a repeat is visible as a count. */
  repeats: number;
}

export interface DurabilityState {
  startedAt: string;
  /** Requests currently in flight, used by shutdown and `/api/health`. */
  inFlight: number;
  /** Peak concurrent requests since boot — a leak shows up here. */
  peakInFlight: number;
  incidents: Incident[];
  shuttingDown: boolean;
}

const MAX_INCIDENTS = 20;

/** Bound and sanitize: an error message can be arbitrarily long or contain a key. */
function sanitize(value: unknown, max = 400): string {
  let text = value instanceof Error ? value.message : String(value ?? 'unknown');
  // A secret can end up in an error message (an upstream echo). Keep the shape,
  // drop anything that looks like a credential.
  text = text
    .replace(/\b(sk|pk|ghp|gho|ghu|xoxb|AKIA)[-_A-Za-z0-9]{8,}\b/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi, 'Bearer [redacted]');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export class DurabilityMonitor {
  private state: DurabilityState = {
    startedAt: new Date().toISOString(),
    inFlight: 0,
    peakInFlight: 0,
    incidents: [],
    shuttingDown: false
  };
  private repeatCounts = new Map<string, number>();

  public record(kind: string, error: unknown): Incident {
    const message = sanitize(error);
    const key = `${kind}::${message}`;
    const repeats = (this.repeatCounts.get(key) || 0) + 1;
    this.repeatCounts.set(key, repeats);
    const total = this.state.incidents.length > 0
      ? this.state.incidents[0].total + 1
      : 1;

    const incident: Incident = {
      at: new Date().toISOString(),
      kind,
      message,
      total,
      repeats
    };
    // Newest first, bounded. The repeat counter above is the long-term signal;
    // this list is the recent detail and must not grow for days.
    this.state.incidents = [incident, ...this.state.incidents].slice(0, MAX_INCIDENTS);
    return incident;
  }

  public beginRequest(): void {
    this.state.inFlight += 1;
    if (this.state.inFlight > this.state.peakInFlight) {
      this.state.peakInFlight = this.state.inFlight;
    }
  }

  public endRequest(): void {
    if (this.state.inFlight > 0) this.state.inFlight -= 1;
  }

  public beginShutdown(): void {
    this.state.shuttingDown = true;
  }

  public get inFlight(): number {
    return this.state.inFlight;
  }

  /** A copy for the health endpoint; callers never mutate internal state. */
  public snapshot(): DurabilityState {
    return {
      ...this.state,
      incidents: this.state.incidents.map((incident) => ({ ...incident }))
    };
  }
}

export const durability = new DurabilityMonitor();

/**
 * Install process-level handlers. Called once, before the server listens.
 *
 * `isBooted` is a thunk rather than a boolean because the handlers are installed
 * early: a failure between installation and a successful listen has to stay
 * fatal, or the supervisor would see a "healthy" process that never bound a port.
 */
export function installCrashGuards(isBooted: () => boolean): void {
  const handle = (kind: string) => (error: unknown) => {
    const incident = durability.record(kind, error);
    const stack = error instanceof Error && error.stack ? `\n${error.stack}` : '';
    console.error(`[durability] ${kind}: ${incident.message}${stack}`);
    if (incident.repeats > 1) {
      console.error(`[durability] same failure seen ${incident.repeats}× since boot`);
    }
    if (!isBooted()) {
      // Never became healthy: let the supervisor restart rather than linger.
      console.error('[durability] failure before boot completed — exiting for a clean restart');
      process.exit(1);
    }
    // Survive: one request's failure cannot take down every other agent.
  };

  process.on('uncaughtException', handle('uncaughtException'));
  process.on('unhandledRejection', handle('unhandledRejection'));
}

export interface ShutdownOptions {
  /**
   * How long to wait for in-flight requests before forcing exit.
   *
   * Measured live 2026-11-20: a 15 s window cut a long generation mid-stream
   * ("transfer closed with outstanding read data remaining"). The whole point of
   * a graceful shutdown is that an agent's turn survives it, and agent turns are
   * routinely minutes long — a 15 s drain protects almost nothing. 10 minutes is
   * long enough for a realistic turn and still bounded, so a wedged request
   * cannot make the process unkillable.
   */
  graceMs?: number;  /** Extra cleanup (timers, sockets) run after draining. */
  onDrain?: () => void | Promise<void>;
}

/**
 * Drain then exit, on SIGTERM/SIGINT/SIGHUP.
 *
 * A second signal during the drain exits immediately — an operator pressing
 * Ctrl-C twice means it, and a stuck drain must not become an unkillable
 * process. SIGHUP is treated as a restart request because that is what a
 * terminal close or a supervisor reload delivers on some setups.
 */
export function installShutdown(servers: Array<Server | null>, options: ShutdownOptions = {}): void {
  const graceMs = options.graceMs ?? 10 * 60 * 1000;
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      console.warn(`[durability] ${signal} again — exiting now without waiting for the drain`);
      process.exit(1);
    }
    shuttingDown = true;
    durability.beginShutdown();
    const pending = durability.inFlight;
    console.log(
      `[durability] ${signal} received — draining ${pending} in-flight request(s) for up to ${Math.round(graceMs / 1000)}s`
    );

    // Stop accepting. `close()` waits for connections, so it is not awaited
    // directly: an idle keep-alive socket would hold it open past the deadline.
    for (const server of servers) {
      try { server?.close(); } catch { /* already closing */ }
    }

    const deadline = Date.now() + graceMs;
    while (durability.inFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => {
        // `unref` would be wrong here: while draining, this timer is the only
        // thing keeping the process alive, and an unref'd timer plus an empty
        // event loop is exactly how a drain silently never finishes.
        setTimeout(resolve, 100);
      });
    }
    const remaining = durability.inFlight;
    if (remaining > 0) {
      console.warn(`[durability] grace period expired with ${remaining} request(s) still open — exiting`);
    } else {
      console.log('[durability] drain complete');
    }

    try {
      await options.onDrain?.();
    } catch (error) {
      console.warn('[durability] drain cleanup failed:', sanitize(error));
    }
    // 0, not 1: this was a deliberate stop, and the supervisor's KeepAlive
    // policy keys off a clean exit to avoid restarting on purpose.
    process.exit(0);
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGHUP', () => { void shutdown('SIGHUP'); });
}

/**
 * Track in-flight requests so shutdown knows what to wait for and health can
 * report it. Attached as the very first middleware, so a request counted here is
 * counted before any async handler can start.
 */
export function trackInFlight(
  req: { on?: (event: string, cb: () => void) => void },
  res: { on?: (event: string, cb: () => void) => void; writableFinished?: boolean },
  next: () => void
): void {
  durability.beginRequest();
  let ended = false;
  const done = () => {
    if (ended) return;
    ended = true;
    durability.endRequest();
  };
  // `close` fires on both a normal finish and a client abort, which is the one
  // event that always arrives. `finish` alone leaks a counter on an aborted
  // download that never finishes writing.
  res.on?.('close', done);
  res.on?.('finish', done);
  next();
}
