#!/usr/bin/env node
/**
 * Generate the Tauri updater manifest (latest.json) for a release.
 *
 * The manifest is hosted at https://local-router.com/updates/latest.json
 * (local-router-dot-com repo, public/updates/latest.json). The desktop app
 * checks it on startup and via the tray "Check for Updates" item; updates are
 * signature-verified against the minisign public key in tauri.conf.json.
 *
 * Usage:
 *   node scripts/make-update-manifest.mjs \
 *     --version 1.2.0 \
 *     --notes "Bug fixes" \
 *     --platform darwin-aarch64=https://github.com/nbiish/local-router/releases/download/v1.2.0/local-router.app.tar.gz=/abs/path/to/.sig \
 *     [--platform windows-x86_64=<url>=<sigpath>] ... \
 *     [--out latest.json]
 *
 * Signatures are produced by `tauri build` when TAURI_SIGNING_PRIVATE_KEY is
 * set (see RELEASING.md). Never commit or print the private key.
 */
import fs from "node:fs";

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const version = flag("--version");
const notes = flag("--notes") || "";
const out = flag("--out") || "latest.json";
const platforms = {};
for (const a of args) {
  if (a.startsWith("--platform ")) {
    const spec = a.slice("--platform ".length);
    const [target, url, sigPath] = spec.split("=");
    if (!target || !url || !sigPath) {
      console.error(`bad --platform spec: ${spec} (want target=url=sigPath)`);
      process.exit(1);
    }
    platforms[target] = {
      signature: fs.readFileSync(sigPath, "utf8").trim(),
      url,
    };
  }
}
// also accept repeated `--platform` `target=url=sigPath` form
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--platform" && args[i + 1]) {
    const [target, url, sigPath] = args[i + 1].split("=");
    platforms[target] = {
      signature: fs.readFileSync(sigPath, "utf8").trim(),
      url,
    };
  }
}

if (!version) {
  console.error("--version is required");
  process.exit(1);
}
if (Object.keys(platforms).length === 0) {
  console.error("at least one --platform target=url=sigPath is required");
  process.exit(1);
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
};
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote ${out}: v${version}, platforms: ${Object.keys(platforms).join(", ")}`);
