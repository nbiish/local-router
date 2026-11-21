/**
 * log-rotation.ts — keep long-lived log files bounded.
 *
 * Why this exists (audit 2026-11-20): nothing in this repository rotates a log.
 * On this host `ollama-backend-11435.log` had reached 13.2 MB, `launchd.log` 5 MB,
 * and `proxy-11434.log` 0.86 MB — all of them append-only, all of them growing.
 * For a router meant to run for days between restarts that is an unbounded disk
 * write against the operator's config directory.
 *
 * The rotation strategy is **copy-and-truncate**, not rename-and-recreate, for
 * one specific reason: a supervisor launches the daemon with its stdout and
 * stderr bound to an open file descriptor. Renaming the file would leave that
 * descriptor writing to an unlinked inode — the log would silently stop growing
 * where the operator expects it, and every byte written after the rotation would
 * be invisible. Truncating the existing inode in place keeps the descriptor
 * valid and keeps the new writes visible.
 *
 * Retention: keep `generations` compressed-ish copies (plain `.N`, oldest
 * dropped), bounded by both size and count. The operator picked 10 MB × 5.
 */

import fs from 'fs';
import path from 'path';

export interface RotationOptions {
  /** Rotate once the file exceeds this many bytes. Default 10 MB. */
  maxBytes?: number;
  /** How many historical copies to keep (`.1` … `.N`). Default 5. */
  generations?: number;
}

export const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024;
export const DEFAULT_LOG_GENERATIONS = 5;

/**
 * Rotate `filePath` if it exceeds `maxBytes`.
 *
 * Returns the number of rotations performed (0 or 1), so a caller can log it.
 * Every failure mode is non-fatal: a log that cannot be rotated is a problem, but
 * it must never be a reason to stop serving requests.
 */
export function rotateLogIfNeeded(filePath: string, options: RotationOptions = {}): number {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_LOG_BYTES;
  const generations = Math.max(1, options.generations ?? DEFAULT_LOG_GENERATIONS);

  let stats: fs.Stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    // No file yet: nothing to rotate.
    return 0;
  }
  if (!stats.isFile() || stats.size <= maxBytes) return 0;

  try {
    // Shift the chain: .N-1 -> .N, ..., .1 -> .2, live -> .1
    for (let index = generations - 1; index >= 1; index -= 1) {
      const from = `${filePath}.${index}`;
      const to = `${filePath}.${index + 1}`;
      if (fs.existsSync(from)) {
        try {
          fs.renameSync(from, to);
        } catch {
          // A missing intermediate generation is not fatal; the chain is
          // best-effort and the live file is what matters.
        }
      }
    }
    try {
      fs.copyFileSync(filePath, `${filePath}.1`);
    } catch {
      // If the copy fails, do NOT truncate: losing the only copy of a log is
      // worse than an unbounded log.
      return 0;
    }
    // Truncate in place, preserving the inode so a supervisor's open descriptor
    // keeps pointing at this path.
    fs.truncateSync(filePath, 0);
    return 1;
  } catch {
    return 0;
  }
}

/**
 * Rotate every log this deployment writes. Called on a timer by the server and on
 * boot by the launcher (which is the process that opens the supervisor fd).
 */
export function rotateKnownLogs(configDir: string, port: number | string, options: RotationOptions = {}): string[] {
  const candidates = [
    path.join(configDir, `proxy-${port}.log`),
    path.join(configDir, 'launchd.log'),
    path.join(configDir, 'launchd.err'),
    path.join(configDir, 'ollama-backend-11435.log'),
    path.join(configDir, 'ollama-backend-11436.log')
  ];
  const rotated: string[] = [];
  for (const file of candidates) {
    if (rotateLogIfNeeded(file, options) > 0) rotated.push(file);
  }
  return rotated;
}
