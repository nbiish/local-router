#!/usr/bin/env node
/**
 * Fail-closed check of a GitHub release's Tauri updater manifest.
 *
 * The desktop app looks platforms up by exact `{os}-{arch}` key, so a manifest that
 * lost a platform in the release pipeline would leave that platform silently unable
 * to update. This runs between "every platform uploaded" and "promote to production"
 * in .github/workflows/desktop-release.yml, and passes only when the manifest's
 * version matches the tag and every required platform names an asset on that
 * release with a non-empty signature.
 *
 * Usage: node scripts/verify-updater-manifest.mjs <tag>
 *
 * Reads the release through the `gh` CLI (GH_TOKEN in CI, the operator's login
 * locally); this script never handles a token itself.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Keys the updater resolves on its supported desktops. */
export const REQUIRED_PLATFORMS = Object.freeze([
  'darwin-aarch64',
  'darwin-x86_64',
  'windows-x86_64',
  'linux-x86_64'
]);

function withoutLeadingV(value) {
  return String(value).replace(/^v/, '');
}

/**
 * Problems that make `manifest` unsafe to promote for `tag`.
 *
 * `assets` is the GitHub release's asset list. A platform entry is trusted only
 * when its url is exactly one of their `browser_download_url` values.
 * Returns [] when the manifest is complete.
 */
export function manifestProblems(manifest, { tag, assets = [] }) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['latest.json is not a JSON object'];
  }
  const problems = [];
  if (withoutLeadingV(manifest.version ?? '') !== withoutLeadingV(tag)) {
    problems.push(`version is ${JSON.stringify(manifest.version)}, but the tag is ${tag}`);
  }
  const platforms = manifest.platforms;
  if (!platforms || typeof platforms !== 'object' || Array.isArray(platforms)) {
    problems.push('"platforms" is missing or not an object');
    return problems;
  }
  const downloadUrls = new Set(assets.map((asset) => asset?.browser_download_url));
  for (const target of REQUIRED_PLATFORMS) {
    const entry = platforms[target];
    if (!entry || typeof entry !== 'object') {
      const present = Object.keys(platforms).join(', ') || 'none';
      problems.push(`platform "${target}" is missing (present: ${present})`);
      continue;
    }
    if (typeof entry.url !== 'string' || !downloadUrls.has(entry.url)) {
      problems.push(`platform "${target}" does not point at an asset of this release`);
    }
    if (typeof entry.signature !== 'string' || entry.signature.trim() === '') {
      problems.push(`platform "${target}" has no signature`);
    }
  }
  return problems;
}

/** Read the updater manifest and asset list of a published release. Throws when it cannot. */
export function loadReleaseManifest(tag) {
  const release = JSON.parse(
    execFileSync('gh', ['api', `repos/{owner}/{repo}/releases/tags/${encodeURIComponent(tag)}`], {
      encoding: 'utf8'
    })
  );
  const dir = mkdtempSync(path.join(tmpdir(), 'local-router-manifest-'));
  try {
    execFileSync('gh', ['release', 'download', tag, '--pattern', 'latest.json', '--dir', dir], {
      encoding: 'utf8'
    });
    const manifest = JSON.parse(readFileSync(path.join(dir, 'latest.json'), 'utf8'));
    return { manifest, assets: release.assets ?? [] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Problems with the release's manifest; `release` defaults to the live release for `tag`. */
export function verifyReleaseManifest(tag, release = loadReleaseManifest(tag)) {
  return manifestProblems(release.manifest, { tag, assets: release.assets });
}

function main(argv) {
  const [tag] = argv;
  if (!tag || argv.length !== 1) {
    console.error('usage: node scripts/verify-updater-manifest.mjs <tag>');
    return 2;
  }
  let release;
  try {
    release = loadReleaseManifest(tag);
  } catch (error) {
    console.error(`::error::cannot read the release ${tag}: ${error.message}`);
    return 1;
  }
  const problems = verifyReleaseManifest(tag, release);
  for (const problem of problems) {
    console.error(`::error::updater manifest for ${tag}: ${problem}`);
  }
  if (problems.length > 0) {
    console.error(`Refusing to promote ${tag}: ${problems.length} updater manifest problem(s).`);
    return 1;
  }
  console.log(`Updater manifest for ${tag} is complete: ${REQUIRED_PLATFORMS.join(', ')}.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
