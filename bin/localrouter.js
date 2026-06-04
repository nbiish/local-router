#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const client = require('./lib/localrouter-client');

const VERSION = '0.1.0';

function usage() {
  console.log(`Local Router CLI (Ollama-compatible ergonomics)

Usage:
  localrouter serve [--port 11434] [--host 127.0.0.1]
  localrouter start|stop|status [--port 11434] [--host 127.0.0.1]
  localrouter list [--custom|--all] [--json]
  localrouter show <model> [--json]
  localrouter ps [--json]
  localrouter keys list [--json]
  localrouter keys set <provider> [--stdin|--env VAR]
  localrouter keys unset <provider> [--json]
  localrouter providers [--json]
  localrouter router list [--json]
  localrouter router show <route-id> [--json]
  localrouter router check [--json]
  localrouter verify [--json]          Headless smoke checks (server, keys, routers, catalog)
  localrouter config [--open]          Print or open http://127.0.0.1:11434/config
  localrouter route <set|unset|status|custom ...>
  localrouter version

Headless / scripting:
  - Pass --json on any query command for machine-readable output
  - Exit 0 on success, 1 on usage/runtime error, 2 when server is not running
  - Environment: LOCAL_ROUTER_HOST, LOCAL_ROUTER_PORT

Compatibility:
  local-router remains the lifecycle daemon CLI; localrouter adds operator UX.
`);
}

function parseGlobalOptions(argv) {
  const options = {
    host: client.DEFAULT_HOST,
    port: client.DEFAULT_PORT,
    json: false,
    open: false,
    catalog: 'active',
    stdin: false,
    envVar: null,
    rest: []
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--json') {
      options.json = true;
      continue;
    }
    if (token === '--open') {
      options.open = true;
      continue;
    }
    if (token === '--stdin') {
      options.stdin = true;
      continue;
    }
    if (token === '--custom') {
      options.catalog = 'custom';
      continue;
    }
    if (token === '--all') {
      options.catalog = 'all';
      continue;
    }
    if (token === '--port') {
      options.port = Number.parseInt(argv[i + 1] || '', 10);
      i += 1;
      continue;
    }
    if (token === '--host') {
      options.host = String(argv[i + 1] || '').trim() || client.DEFAULT_HOST;
      i += 1;
      continue;
    }
    if (token === '--env') {
      options.envVar = String(argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    options.rest.push(token);
  }

  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error(`Invalid port: ${options.port}`);
  }

  return options;
}

function emitJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function emitOrJson(options, value, renderText) {
  if (options.json) {
    emitJson(value);
    return;
  }
  renderText(value);
}

function routerCandidateIds(route) {
  const raw = route.candidates || route.models || [];
  return raw.map((entry) => (typeof entry === 'string' ? entry : entry.model)).filter(Boolean);
}

function delegateLocalRouter(args) {
  const script = path.join(__dirname, 'local-router.js');
  const child = spawn(process.execPath, [script, ...args], {
    stdio: 'inherit',
    env: process.env
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

async function readSecretInput(options) {
  if (options.stdin) {
    return fs.readFileSync(0, 'utf8').trim();
  }
  if (options.envVar) {
    const value = process.env[options.envVar];
    if (!value || !String(value).trim()) {
      throw new Error(`Environment variable ${options.envVar} is empty or unset`);
    }
    return String(value).trim();
  }

  if (!process.stdin.isTTY) {
    return fs.readFileSync(0, 'utf8').trim();
  }

  throw new Error('No API key supplied. Use --stdin, --env VAR, or pipe the key on stdin.');
}

async function cmdList(options) {
  const probeResult = await client.probe(options.host, options.port);
  client.requireServer(probeResult);

  const payload = await client.fetchJson(
    `/api/provider-models?catalog=${encodeURIComponent(options.catalog)}`,
    {},
    options.host,
    options.port
  );

  const flat = (payload.data || []).flatMap((entry) => (
    (entry.models || []).map((model) => ({
      provider: entry.provider,
      id: model.id,
      upstream: model.model,
      contextLength: model.contextLength,
      outputTokens: model.outputTokens
    }))
  ));

  emitOrJson(options, { catalog: payload.catalog, models: flat, providers: payload.data }, (value) => {
    console.log(`Catalog: ${payload.catalog} (active source: ${payload.modelSource}, endpoint cache: ${payload.endpointCacheCount})`);
    for (const row of value.models) {
      console.log(`${row.provider}/${row.id}`);
    }
    console.log(`\n${value.models.length} model(s)`);
  });
}

async function cmdShow(modelName, options) {
  if (!modelName) {
    throw new Error('Model name required. Example: localrouter show zenmux-minimax-m3');
  }

  const probeResult = await client.probe(options.host, options.port);
  client.requireServer(probeResult);

  const show = await client.fetchJson('/api/show', {
    method: 'POST',
    body: { name: modelName }
  }, options.host, options.port);

  emitOrJson(options, show, (value) => {
    console.log(JSON.stringify(value, null, 2));
  });
}

async function cmdPs(options) {
  const probeResult = await client.probe(options.host, options.port);
  client.requireServer(probeResult);

  const payload = await client.fetchJson('/api/ps', {}, options.host, options.port);
  emitOrJson(options, payload, (value) => {
    const models = value.models || [];
    if (!models.length) {
      console.log('No running models');
      return;
    }
    for (const model of models) {
      console.log(model.name || model.model || JSON.stringify(model));
    }
  });
}

async function cmdKeysList(options) {
  const probeResult = await client.probe(options.host, options.port);
  client.requireServer(probeResult);

  const payload = await client.fetchJson('/api/provider-configs', {}, options.host, options.port);
  const rows = (payload.data || []).map((entry) => ({
    provider: entry.name,
    configured: entry.configured,
    source: entry.configuredSource,
    keyEnvVar: entry.keyEnvVar,
    defaultModel: entry.defaultModel || null
  }));

  emitOrJson(options, { providers: rows }, (value) => {
    for (const row of value.providers) {
      const mark = row.configured ? '✓' : '·';
      console.log(`${mark} ${row.provider.padEnd(20)} ${row.source.padEnd(8)} ${row.keyEnvVar}`);
    }
  });
}

async function cmdKeysSet(providerName, options) {
  if (!providerName) {
    throw new Error('Provider name required. Example: localrouter keys set zenmux --env ZENMUX_API_KEY');
  }

  const apiKey = await readSecretInput(options);
  const probeResult = await client.probe(options.host, options.port);
  client.requireServer(probeResult);

  const result = await client.fetchJson('/api/keys', {
    method: 'POST',
    body: { provider: providerName, apiKey }
  }, options.host, options.port);

  emitOrJson(options, result, () => {
    console.log(`Saved key for ${providerName} (${result.keyEnvVar})`);
  });
}

async function cmdKeysUnset(providerName, options) {
  if (!providerName) {
    throw new Error('Provider name required. Example: localrouter keys unset zenmux');
  }

  const probeResult = await client.probe(options.host, options.port);
  client.requireServer(probeResult);

  const result = await client.fetchJson(
    `/api/keys/${encodeURIComponent(providerName)}`,
    { method: 'DELETE' },
    options.host,
    options.port
  );

  emitOrJson(options, result, () => {
    console.log(`Removed key for ${providerName}`);
  });
}

async function cmdProviders(options) {
  return cmdKeysList(options);
}

async function cmdRouterList(options) {
  const probeResult = await client.probe(options.host, options.port);
  client.requireServer(probeResult);

  const payload = await client.fetchJson('/api/router-models', {}, options.host, options.port);
  const routes = (payload.data || []).map((route) => ({
    id: route.routeId || route.id,
    type: route.type,
    candidates: routerCandidateIds(route),
    minCodingScore: route.minCodingScore,
    costQualityTradeoff: route.costQualityTradeoff
  }));

  emitOrJson(options, { routers: routes }, (value) => {
    for (const route of value.routers) {
      console.log(`${route.id} (${route.type}) — ${route.candidates.length} candidate(s)`);
    }
  });
}

async function cmdRouterShow(routeId, options) {
  if (!routeId) {
    throw new Error('Route id required. Example: localrouter router show auto-local-main');
  }

  const probeResult = await client.probe(options.host, options.port);
  client.requireServer(probeResult);

  const payload = await client.fetchJson('/api/router-models', {}, options.host, options.port);
  const route = (payload.data || []).find((entry) => (
    entry.routeId === routeId || entry.id === routeId || entry.id === `local-router/${routeId}`
  ));

  if (!route) {
    throw new Error(`Router not found: ${routeId}`);
  }

  const candidateIds = routerCandidateIds(route);
  emitOrJson(options, { ...route, candidateIds }, (value) => {
    console.log(`${value.routeId || value.id} (${value.type})`);
    console.log(`Candidates (${value.candidateIds.length}):`);
    for (const candidate of value.candidateIds) {
      console.log(`  - ${candidate}`);
    }
  });
}

async function cmdRouterCheck(options) {
  const probeResult = await client.probe(options.host, options.port);
  client.requireServer(probeResult);

  const routers = await client.fetchJson('/api/router-models', {}, options.host, options.port);
  const fallbacks = await client.fetchJson('/api/fallback-models', {}, options.host, options.port);
  const configs = await client.fetchJson('/api/provider-configs', {}, options.host, options.port);
  const configured = new Set((configs.data || []).filter((p) => p.configured).map((p) => p.name));

  const report = {
    routers: [],
    fallbacks: (fallbacks.data || []).map((f) => f.routeId || f.id),
    issues: []
  };

  for (const route of routers.data || []) {
    const candidates = routerCandidateIds(route);
    const availability = await client.fetchJson(
      `/api/routing/availability?models=${encodeURIComponent(candidates.join(','))}`,
      {},
      options.host,
      options.port
    );

    const ready = (availability.data || []).filter((row) => row.status === 'ready').length;
    const entry = {
      id: route.routeId || route.id,
      type: route.type,
      candidates: candidates.length,
      ready,
      unavailable: (availability.data || []).filter((row) => row.status !== 'ready')
    };
    report.routers.push(entry);

    if (candidates.length === 0) {
      report.issues.push(`${entry.id}: no candidates configured`);
    }
    if (ready === 0 && candidates.length > 0) {
      report.issues.push(`${entry.id}: zero ready candidates (check provider keys)`);
    }
  }

  const missingProviders = (configs.data || [])
    .filter((p) => !p.configured)
    .map((p) => p.name);
  if (missingProviders.length) {
    report.issues.push(`Unconfigured providers: ${missingProviders.join(', ')}`);
  }

  if (!options.silent) {
    emitOrJson(options, report, (value) => {
      console.log('Router check');
      for (const route of value.routers) {
        console.log(`  ${route.id}: ${route.ready}/${route.candidates} ready (${route.type})`);
      }
      console.log(`Fallback routes: ${value.fallbacks.length}`);
      if (value.issues.length) {
        console.log('\nIssues:');
        for (const issue of value.issues) {
          console.log(`  - ${issue}`);
        }
      } else {
        console.log('\nNo issues detected.');
      }
    });
  }

  return report.issues.length ? 1 : 0;
}

async function cmdVerify(options) {
  const probeResult = await client.probe(options.host, options.port);
  if (!probeResult.running || probeResult.kind !== 'local-router') {
    const result = {
      ok: false,
      baseUrl: probeResult.baseUrl,
      error: 'Local Router is not running'
    };
    emitOrJson(options, result, () => console.error(result.error));
    return 2;
  }

  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  try {
    const version = await client.fetchJson('/api/version', {}, options.host, options.port);
    const versionLabel = typeof version === 'object' && version !== null
      ? (version.version || JSON.stringify(version))
      : String(version);
    add('version', true, versionLabel);
  } catch (error) {
    add('version', false, error.message);
  }

  try {
    const custom = await client.fetchJson('/api/provider-models?catalog=custom', {}, options.host, options.port);
    const count = (custom.data || []).reduce((sum, p) => sum + (p.models?.length || 0), 0);
    add('catalog-custom', count > 0, `${count} models`);
  } catch (error) {
    add('catalog-custom', false, error.message);
  }

  try {
    const all = await client.fetchJson('/api/provider-models?catalog=all', {}, options.host, options.port);
    const count = (all.data || []).reduce((sum, p) => sum + (p.models?.length || 0), 0);
    add('catalog-all', count > 0, `${count} models (cache ${all.endpointCacheCount})`);
  } catch (error) {
    add('catalog-all', false, error.message);
  }

  const routerExit = await cmdRouterCheck({ ...options, silent: true });
  add('router-check', routerExit === 0, routerExit === 0 ? 'ok' : 'issues found');

  const ok = checks.every((check) => check.ok);
  const result = { ok, baseUrl: probeResult.baseUrl, checks, configUrl: `${probeResult.baseUrl}/config` };
  emitOrJson(options, result, (value) => {
    console.log(`Verify ${value.ok ? 'PASSED' : 'FAILED'} — ${value.baseUrl}`);
    for (const check of value.checks) {
      console.log(`  [${check.ok ? 'ok' : 'fail'}] ${check.name}: ${check.detail}`);
    }
    console.log(`Config UI: ${value.configUrl}`);
  });

  return ok ? 0 : 1;
}

function cmdConfig(options) {
  const url = `${client.baseUrl(options.host, options.port)}/config`;
  if (options.open) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
  }
  emitOrJson(options, { url }, () => {
    console.log(url);
    console.log('Use the Config UI to manage keys, router models, and catalog source.');
    console.log('Planned: LiteLLM-inspired proxy admin panel (test chat, model matrix) at this URL.');
  });
  return 0;
}

function cmdVersion(options) {
  const payload = { name: 'localrouter', version: VERSION, localRouterCli: path.join(__dirname, 'local-router.js') };
  emitOrJson(options, payload, () => console.log(`localrouter version ${VERSION}`));
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    usage();
    return 0;
  }

  const command = argv[0];
  const options = parseGlobalOptions(argv.slice(1));
  const args = options.rest;
  const sub = args[0];

  try {
    if (command === 'version' || command === '-v' || command === '--version') {
      return cmdVersion(options);
    }

    if (command === 'serve') {
      delegateLocalRouter(['start', '--foreground', '--host', options.host, '--port', String(options.port)]);
      return 0;
    }

    if (command === 'start' || command === 'stop' || command === 'status') {
      delegateLocalRouter([command, '--host', options.host, '--port', String(options.port)]);
      return 0;
    }

    if (command === 'route') {
      delegateLocalRouter(['route', ...args]);
      return 0;
    }

    if (command === 'list') {
      await cmdList(options);
      return 0;
    }

    if (command === 'show') {
      await cmdShow(args[0], options);
      return 0;
    }

    if (command === 'ps') {
      await cmdPs(options);
      return 0;
    }

    if (command === 'keys') {
      if (sub === 'list') {
        await cmdKeysList(options);
        return 0;
      }
      if (sub === 'set') {
        await cmdKeysSet(args[1], options);
        return 0;
      }
      if (sub === 'unset') {
        await cmdKeysUnset(args[1], options);
        return 0;
      }
      throw new Error('Unknown keys subcommand. Use: list | set | unset');
    }

    if (command === 'providers') {
      await cmdProviders(options);
      return 0;
    }

    if (command === 'router') {
      if (sub === 'list') {
        await cmdRouterList(options);
        return 0;
      }
      if (sub === 'show') {
        await cmdRouterShow(args[1], options);
        return 0;
      }
      if (sub === 'check') {
        return await cmdRouterCheck(options);
      }
      throw new Error('Unknown router subcommand. Use: list | show | check');
    }

    if (command === 'verify') {
      return await cmdVerify(options);
    }

    if (command === 'config') {
      return cmdConfig(options);
    }

    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    if (options.json) {
      emitJson({ error: error.message || String(error), code: error.code || 'ERROR' });
    } else {
      console.error(error.message || String(error));
    }
    if (error.code === 'ENOTRUNNING') {
      return 2;
    }
    return 1;
  }
}

main().then((code) => {
  if (typeof code === 'number') {
    process.exitCode = code;
  }
});
