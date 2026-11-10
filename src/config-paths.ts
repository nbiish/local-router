import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where local-router keeps its files.
 *
 * There are two roots because the files have two different lifetimes, and mixing
 * them is how a config ends up on one machine only.
 *
 *  - MACHINE root (`~/.config/local-router`): credentials, discovery caches,
 *    logs, health snapshots, backups. Correct to keep per box — an OAuth token or
 *    a 1 MB provider cache is this machine's state, not the product's config.
 *  - CHECKOUT root (`<checkout>/router-settings.json`): operator-authored config
 *    that must travel with the repository, above all the fallback chains. A fleet
 *    that rsyncs or clones the same checkout therefore runs the same chain
 *    everywhere, and a chain edited on one machine is what the next sync reads.
 *
 * Resolution order, first match wins:
 *
 *  1. `LOCAL_ROUTER_CONFIG_DIR` — pins BOTH roots to that directory. Tests, CI and
 *     an operator running an isolated install use it; it is also the escape hatch
 *     when checkout detection is wrong.
 *  2. A checkout root: a `package.json` named `local-router` sitting next to a
 *     `.git` entry, found by walking up from the compiled module. `build/*.js`
 *     and `src/*.ts` both sit one level under the root, so this is where a
 *     `git clone` user expects to find the config.
 *  3. The machine root. This is the case for a packaged desktop install (no
 *     `.git`) and for an overridden `HOME`.
 *
 * An overridden `HOME` deliberately disables checkout detection: a test harness,
 * a container or a sandbox that repoints `HOME` is stating "this process is
 * isolated", and writing into whatever git checkout happens to contain the code
 * would make an isolated run mutate the repository it is testing. Isolation wins
 * over locality there, and it is the rule that keeps the test suite from ever
 * touching a real chain file.
 */

const CHECKOUT_PACKAGE_NAME = 'local-router';

export type ConfigLocationSource = 'env' | 'checkout' | 'machine';

export type ConfigLocation = {
  /** Absolute path of the requested file. */
  path: string;
  /** Why that path was chosen. `checkout` means it travels with the repository. */
  source: ConfigLocationSource;
};

function envValue(name: string): string {
  const raw = process.env[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

/** The explicit pin, or '' when the operator did not set one. */
function pinnedConfigDir(): string {
  const pinned = envValue('LOCAL_ROUTER_CONFIG_DIR');
  return pinned ? path.resolve(pinned) : '';
}

/**
 * Is this directory a checkout of this project?
 *
 * `package.json` alone is not enough: a packaged desktop build ships one inside
 * its resources, where writing config would be wrong (and often read-only). The
 * `.git` entry is what separates "a checkout a sync carries" from "an installed
 * artifact", and it covers worktrees too, where `.git` is a file.
 */
function isCheckoutRoot(dir: string): boolean {
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) return false;
    const pkgPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg?.name === CHECKOUT_PACKAGE_NAME;
  } catch {
    return false;
  }
}

/**
 * True when `HOME`/`USERPROFILE` points somewhere other than the account's real
 * home, which is how a test harness or a sandbox isolates itself.
 */
function homeIsOverridden(): boolean {
  try {
    const live = path.resolve(os.homedir());
    const account = path.resolve(os.userInfo().homedir);
    return live !== account;
  } catch {
    // No passwd entry to compare against (rare containers): assume the real home.
    return false;
  }
}

/**
 * The checkout this build runs from, or null when it does not run from one.
 *
 * `LOCAL_ROUTER_REPO_ROOT` overrides detection and is validated the same way, so
 * a wrong value fails closed to the machine root instead of writing into an
 * unrelated directory.
 */
export function checkoutRoot(): string | null {
  const explicit = envValue('LOCAL_ROUTER_REPO_ROOT');
  if (explicit) {
    const resolved = path.resolve(explicit);
    return isCheckoutRoot(resolved) ? resolved : null;
  }
  if (homeIsOverridden()) return null;

  let dir = __dirname;
  for (let depth = 0; depth < 5; depth += 1) {
    if (isCheckoutRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Per-machine state directory. Never the checkout. */
export function machineConfigDir(): string {
  return pinnedConfigDir() || path.join(os.homedir(), '.config', 'local-router');
}

/** Absolute path of a file that belongs to this machine. */
export function machineConfigPath(fileName: string): string {
  return path.join(machineConfigDir(), fileName);
}

/**
 * Absolute path of portable config, together with the reason for that choice.
 *
 * Callers that only write a file want {@link portableConfigPath}; callers that
 * report where the configuration lives want the source too, because "the file is
 * actually in the checkout and therefore synced" is the property being claimed.
 */
export function configLocation(fileName: string): ConfigLocation {
  const pinned = pinnedConfigDir();
  if (pinned) return { path: path.join(pinned, fileName), source: 'env' };

  const root = checkoutRoot();
  if (root) return { path: path.join(root, fileName), source: 'checkout' };

  return { path: machineConfigPath(fileName), source: 'machine' };
}

/** Absolute path of a portable config file (checkout copy when available). */
export function portableConfigPath(fileName: string): string {
  return configLocation(fileName).path;
}

/** Human-readable one-liner for boot logs and diagnostics. */
export function describeConfigLocation(location: ConfigLocation): string {
  const dir = path.dirname(location.path);
  if (location.source === 'env') return `${location.path} (LOCAL_ROUTER_CONFIG_DIR=${dir})`;
  if (location.source === 'checkout') return `${location.path} (checkout — travels with the repository)`;
  return `${location.path} (machine)`;
}

/**
 * One-time seeding of a portable config file from the machine copy.
 *
 * Moving the authoritative chain file from `~/.config/local-router/` into the
 * checkout must not lose an existing chain, so the first boot of a build that
 * knows about the checkout copy copies the machine file over when the checkout
 * has none. Copy only — the machine file is left alone, so an operator can still
 * diff the two.
 *
 * Returns true only when a copy actually happened.
 */
export function seedPortableConfigFile(fileName: string): boolean {
  const portable = portableConfigPath(fileName);
  const machine = machineConfigPath(fileName);
  if (path.resolve(portable) === path.resolve(machine)) return false;
  if (fs.existsSync(portable) || !fs.existsSync(machine)) return false;
  try {
    fs.mkdirSync(path.dirname(portable), { recursive: true, mode: 0o700 });
    fs.copyFileSync(machine, portable);
    fs.chmodSync(portable, 0o600);
    console.log(`[config] Seeded ${portable} from ${machine} — the checkout copy is authoritative from now on.`);
    return true;
  } catch (error: any) {
    console.error(`[config] Failed to seed ${portable} from ${machine}: ${String(error?.message || error)}`);
    return false;
  }
}
