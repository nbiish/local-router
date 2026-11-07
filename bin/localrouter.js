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
  localrouter verify [--json]          Headless smoke checks (server, keys, catalog, fallback routes)
  localrouter embedding [--dimensions N] [--json]
                                       Verify the retrieval route end to end: chain readiness, a
                                       real embedding request, and which provider answered
  localrouter embedding-env [--shell posix|powershell|cmd|fish] [--dimensions N] [--json]
                                       Print the env vars that point ainish-rag at this router
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
    if (token === '--dimensions' || token === '--dim') {
      const parsed = Number.parseInt(argv[i + 1] || '', 10);
      if (Number.isInteger(parsed) && parsed > 0) options.dimensions = parsed;
      i += 1;
      continue;
    }
    if (token === '--route') {
      options.routeId = String(argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (token === '--input') {
      options.input = String(argv[i + 1] || '');
      i += 1;
      continue;
    }
    if (token === '--shell') {
      const requested = String(argv[i + 1] || '').trim().toLowerCase();
      if (['powershell', 'cmd', 'posix', 'fish', 'sh', 'bash'].includes(requested)) {
        options.shell = requested === 'sh' || requested === 'bash' ? 'posix' : requested;
      }
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

  try {
    const fallbacks = await client.fetchJson('/api/fallback-models', {}, options.host, options.port);
    const count = (fallbacks.data || []).length;
    add('fallback-routes', count > 0, `${count} route(s)`);
  } catch (error) {
    add('fallback-routes', false, error.message);
  }

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

/**
 * `localrouter embedding` — verify the retrieval backend end to end.
 *
 * ainish-rag points at `local-router/fallback-embedding` and only ever sees a 200 or an error, so
 * a silent failover (or a silently degraded chain) is invisible to it. This probes the route the
 * way the tooling does and reports which provider actually answered, in an OpenAI-compatible
 * request that runs the same on PowerShell, a POSIX shell, WSL, macOS and Linux because it is
 * plain Node with no shell interpolation.
 */
async function cmdEmbedding(options) {
  const probeResult = await client.probe(options.host, options.port);
  if (!probeResult.running || probeResult.kind !== 'local-router') {
    emitOrJson(options, { ok: false, baseUrl: probeResult.baseUrl, error: 'Local Router is not running' },
      () => console.error('Local Router is not running'));
    return 2;
  }
  const baseUrl = probeResult.baseUrl;
  const routeId = options.routeId || 'local-router/fallback-embedding';
  const dims = Number.isFinite(options.dimensions) ? options.dimensions : undefined;

  const report = { ok: false, baseUrl, routeId, dimensions: dims || null, chain: [], probe: null, error: null };

  // 1. Chain composition + per-step readiness, so a degraded chain is visible before a query.
  try {
    const availability = await client.fetchJson(
      `/api/routing/availability?models=${encodeURIComponent(routeId)}`,
      {}, options.host, options.port
    );
    const row = (availability.data || [])[0];
    report.route = row || null;
  } catch (error) {
    report.error = `availability: ${error.message}`;
  }

  try {
    const routes = await client.fetchJson('/api/fallback-models', {}, options.host, options.port);
    const route = (routes.data || []).find((entry) => entry.routeId === 'fallback-embedding'
      || entry.id === 'local-router/fallback-embedding');
    if (route) {
      const disabled = new Set(route.disabledModels || []);
      for (const step of route.models || []) {
        const stepRow = await client.fetchJson(
          `/api/routing/availability?models=${encodeURIComponent(step)}`,
          {}, options.host, options.port
        ).catch(() => null);
        const status = (stepRow?.data || [])[0] || null;
        report.chain.push({
          step,
          enabled: !disabled.has(step),
          status: status?.status || 'unknown',
          provider: status?.provider || null
        });
      }
    }
  } catch (error) {
    report.error = report.error ? `${report.error}; chain: ${error.message}` : `chain: ${error.message}`;
  }

  // 2. A real embedding round trip at the caller's pinned width. `dimensions` matters: the index
  //    was built at one width, and a provider returning another is rejected on purpose.
  try {
    const startedAt = Date.now();
    const response = await client.fetchRaw('/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: routeId, input: options.input || 'local-router embedding probe', ...(dims ? { dimensions: dims } : {}) })
    }, options.host, options.port);
    const durationMs = Date.now() - startedAt;
    const body = await response.json().catch(() => null);
    report.probe = {
      status: response.status,
      durationMs,
      ok: response.ok,
      provider: response.headers.get('x-local-router-embedding-provider'),
      model: response.headers.get('x-local-router-embedding-model'),
      failedAttempts: response.headers.get('x-local-router-embedding-attempts'),
      width: body?.data?.[0]?.embedding?.length ?? null,
      vectors: Array.isArray(body?.data) ? body.data.length : null,
      error: response.ok ? null : (body?.error || body || null)
    };
    report.ok = response.ok;
  } catch (error) {
    report.error = report.error ? `${report.error}; probe: ${error.message}` : `probe: ${error.message}`;
  }

  emitOrJson(options, report, (value) => {
    console.log(`Embedding route ${value.routeId} — ${value.baseUrl}`);
    if (value.route) {
      console.log(`  route status: ${value.route.status} (${value.route.readySteps ?? '?'}/${value.route.steps ?? '?'} steps ready)`);
    }
    if (value.chain.length > 0) {
      console.log('  chain (tried in order):');
      for (const step of value.chain) {
        const mark = step.enabled ? ' ' : 'x';
        console.log(`    [${mark}] ${step.step}  ${step.status}`);
      }
    }
    const probe = value.probe;
    if (probe) {
      if (probe.ok) {
        console.log(`  probe: ${probe.status} in ${probe.durationMs}ms — ${probe.vectors} vector(s), width ${probe.width}`);
        console.log(`  answered by: ${probe.provider || 'unknown'} (${probe.model || '?'})`);
        if (probe.failedAttempts) console.log(`  failed before it: ${probe.failedAttempts}`);
      } else {
        console.log(`  probe FAILED: ${probe.status} — ${JSON.stringify(probe.error)}`);
      }
    }
    if (value.error) console.log(`  error: ${value.error}`);
    console.log(value.ok ? 'Embedding route is serving.' : 'Embedding route is NOT serving.');
  });

  return report.ok ? 0 : 1;
}

/**
 * Emit the environment that points ainish-rag at this router.
 *
 * Without an explicit `AINISH_EMBED_API_BASE`, ainish-rag auto-detects a provider key from the PQC
 * store and calls OpenRouter directly — which silently bypasses this router's failover and key
 * brokerage. The base must be set explicitly, and the correct syntax differs per shell and per OS,
 * so the caller asks for a dialect instead of hand-editing exports.
 */
function emitEmbeddingEnvReport(options) {
  const base = client.baseUrl(options.host, options.port);
  const dims = Number.isFinite(options.dimensions) ? options.dimensions : null;
  const values = {
    AINISH_EMBED_API_BASE: `${base}/v1`,
    AINISH_EMBED_MODEL: options.routeId || 'local-router/fallback-embedding',
    AINISH_EMBED_API_KEY: 'local-router',
    ...(dims ? { AINISH_EMBED_DIM: String(dims) } : {})
  };

  const dialect = options.shell || detectShellDialect();
  const lines = Object.entries(values).map(([key, value]) => {
    switch (dialect) {
      case 'powershell':
        return `$env:${key} = "${value}"`;
      case 'cmd':
        return `set ${key}=${value}`;
      case 'fish':
        return `set -gx ${key} ${value}`;
      default:
        return `export ${key}="${value}"`;
    }
  });

  return { baseUrl: base, routeId: values.AINISH_EMBED_MODEL, shell: dialect, env: values, lines };
}

function detectShellDialect() {
  if (process.platform === 'win32' && process.env.PSModulePath) return 'powershell';
  if (process.platform === 'win32') return 'cmd';
  const shell = path.basename(String(process.env.SHELL || 'sh')).toLowerCase();
  if (shell.includes('fish')) return 'fish';
  return 'posix';
}

function cmdConfig(options) {
  const url = `${client.baseUrl(options.host, options.port)}/config`;
  if (options.open) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
  }
  emitOrJson(options, { url }, () => {
    console.log(url);
    console.log('Use the Config UI to manage keys, fallback chains, and catalog source.');
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

        if (command === 'verify') {
      return await cmdVerify(options);
    }

    if (command === 'embedding') {
      return await cmdEmbedding(options);
    }

    if (command === 'embedding-env') {
      const report = emitEmbeddingEnvReport(options);
      emitOrJson(options, report, (value) => {
        console.log(`# Point ainish-rag at ${value.baseUrl} (${value.shell} syntax)`);
        console.log(`# Without AINISH_EMBED_API_BASE, ainish-rag auto-detects a provider key and`);
        console.log(`# calls that provider directly, bypassing this router's failover.`);
        for (const line of value.lines) console.log(line);
      });
      return 0;
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
