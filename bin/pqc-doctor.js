#!/usr/bin/env node
/**
 * pqc-doctor.js — explain why a packed PQC key is or is not used by the router.
 *
 *   node bin/pqc-doctor.js             ask the running router what it loaded
 *   node bin/pqc-doctor.js --local     scan stores on this machine directly
 *   node bin/pqc-doctor.js --local --wsl   also scan WSL stores from Windows
 *   node bin/pqc-doctor.js --json      machine-readable
 *   node bin/pqc-doctor.js --strict    exit 1 when a secret name maps to nothing
 *
 * Only secret NAMES are read and printed — never values.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function loadModules() {
  try {
    return {
      resolver: require(path.join(root, 'build', 'pqc-key-resolver.js')),
      registry: require(path.join(root, 'build', 'provider-registry.js'))
    };
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const options = {
    json: false,
    local: false,
    wsl: false,
    strict: false,
    port: process.env.PORT || '11434'
  };
  for (const token of argv) {
    if (token === '--json') options.json = true;
    else if (token === '--local') options.local = true;
    else if (token === '--wsl') options.wsl = true;
    else if (token === '--strict') options.strict = true;
    else if (token.startsWith('--port=')) options.port = token.split('=')[1];
  }
  return options;
}

function providerSummaries(registry) {
  const summaries = registry.PROVIDER_REGISTRY.map((entry) => ({
    name: entry.name,
    keyEnvVar: entry.keyEnvVar
  }));
  try {
    const customPath = path.join(os.homedir(), '.config', 'local-router', 'custom-providers.json');
    const parsed = JSON.parse(fs.readFileSync(customPath, 'utf8'));
    for (const provider of parsed.providers || []) {
      if (provider.name && provider.keyEnvVar) {
        summaries.push({ name: provider.name, keyEnvVar: provider.keyEnvVar });
      }
    }
  } catch {
    // Custom providers are optional.
  }
  return summaries;
}

function pqcBin() {
  const candidates = [
    path.join(root, 'bin', 'pqc-secrets.cmd'),
    path.join(root, 'bin', 'pqc-secrets.exe'),
    path.join(root, 'bin', 'pqc-secrets')
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function listSecretNames(dir, bin) {
  const env = { ...process.env, PQC_CONFIG_DIR: dir };
  const isCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  const output = isCmd
    ? execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${bin}" list`], {
        encoding: 'utf8',
        env,
        timeout: 120000
      })
    : execFileSync(bin, ['list'], { encoding: 'utf8', env, timeout: 120000 });
  const names = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^\s{2,}([A-Z0-9_]+)\s*$/);
    if (match) names.push(match[1]);
  }
  return names;
}

function storeDirs(options) {
  const dirs = [];
  const push = (dir) => {
    if (dir && fs.existsSync(dir) && !dirs.includes(dir)) dirs.push(dir);
  };
  if (process.env.PQC_CONFIG_DIR) push(process.env.PQC_CONFIG_DIR);
  push(path.join(os.homedir(), '.config', 'pqc-secrets'));
  push(path.join(os.homedir(), 'config', 'pqc-secrets'));
  for (const raw of String(process.env.LOCAL_ROUTER_PQC_EXTRA_DIRS || '').split(/[;:]/)) {
    push(raw.trim());
  }

  if (process.platform === 'win32' && options.wsl) {
    for (const prefix of ['\\\\wsl.localhost\\', '\\\\wsl$\\']) {
      let distros = [];
      try {
        distros = fs.readdirSync(prefix, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      } catch {
        continue;
      }
      for (const distro of distros) {
        let homes = [];
        try {
          homes = fs.readdirSync(path.join(prefix, distro, 'home'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
        } catch {
          continue;
        }
        for (const home of homes) {
          push(path.join(prefix, distro, 'home', home, '.config', 'pqc-secrets'));
        }
      }
    }
  }
  return dirs;
}

async function serverReport(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/api/pqc/status`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function localReport(options, modules) {
  const summaries = providerSummaries(modules.registry);
  const bin = pqcBin();
  const stores = [];
  if (!bin) return { error: 'pqc-secrets binary not found under bin/' };

  for (const dir of storeDirs(options)) {
    const bundlePath = path.join(dir, 'secrets.bundle.json');
    if (!fs.existsSync(bundlePath)) continue;
    let names = [];
    try {
      names = listSecretNames(dir, bin);
    } catch (error) {
      stores.push({ dir, bundlePath, exists: true, error: error.message, secretNames: [], mapped: [], unmapped: [] });
      continue;
    }
    const mapped = [];
    const unmapped = [];
    for (const name of names) {
      const providers = modules.resolver.resolveProvidersForKey(name, summaries);
      if (providers.length > 0) {
        mapped.push({ name, providers: providers.map((provider) => provider.name) });
      } else {
        unmapped.push({ name, suggestion: modules.resolver.suggestKeyName(name, summaries) });
      }
    }
    stores.push({ dir, bundlePath, exists: true, secretNames: names, mapped, unmapped });
  }
  return { stores, summaries };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const modules = loadModules();
  if (!modules) {
    console.error('[pqc-doctor] build/ is missing. Run `npm run build` (or `npm install`) first.');
    return 1;
  }

  let report = null;
  if (!options.local) {
    report = await serverReport(`http://127.0.0.1:${options.port}`);
  }
  if (!report) {
    const local = localReport(options, modules);
    if (local.error) {
      console.error('[pqc-doctor]', local.error);
      return 1;
    }
    report = { mode: 'local', stores: local.stores, expectedNames: local.summaries.map((summary) => ({
      provider: summary.name,
      keyEnvVar: summary.keyEnvVar,
      canonical: `LOCALROUTER_${summary.keyEnvVar}`
    })) };
  } else {
    report.mode = 'server';
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`PQC key doctor (${report.mode}) — ${report.stores.length} store(s)`);
    for (const store of report.stores) {
      console.log(`\nStore ${store.dir}`);
      if (store.error) console.log(`  ERROR ${store.error}`);
      for (const entry of store.mapped || []) {
        console.log(`  OK    ${entry.name}  ->  ${entry.providers.join(', ')}`);
      }
      for (const entry of store.unmapped || []) {
        console.log(`  UNMAPPED  ${entry.name}${entry.suggestion ? `  did you mean ${entry.suggestion}?` : '  (no provider name match)'}`);
      }
      if ((store.secretNames || []).length === 0) console.log('  (no secrets)');
    }
    if (Array.isArray(report.loadedProviders)) {
      console.log(`\nRouter loaded keys for: ${report.loadedProviders.map((entry) => entry.provider).join(', ') || '(none)'}`);
    }
    const unmappedCount = report.stores.reduce((sum, store) => sum + (store.unmapped || []).length, 0);
    console.log(unmappedCount > 0
      ? `\nVerdict: ${unmappedCount} secret name(s) map to no provider. Repack with the suggested LOCALROUTER_<PROVIDER_API_KEY> name.`
      : '\nVerdict: every secret name maps to a provider. If the UI still shows no key, restart the router or POST /api/pqc/resync.');
  }

  const unmapped = report.stores.some((store) => (store.unmapped || []).length > 0);
  return options.strict && unmapped ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('[pqc-doctor]', error?.message || error);
    process.exit(1);
  });
