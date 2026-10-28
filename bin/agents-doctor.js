#!/usr/bin/env node
/**
 * agents-doctor.js — cross-platform readiness check for the harnesses the
 * Agents page manages (Claude Code and Codex CLI).
 *
 *   node bin/agents-doctor.js            readiness only (free)
 *   node bin/agents-doctor.js --verify   + one real round trip per harness
 *   node bin/agents-doctor.js --json     machine-readable output
 *   node bin/agents-doctor.js --port N   check a non-default loopback port
 *
 * Works on Windows, macOS, Linux, and WSL: it reads PATH, the managed env
 * file, and the managed Codex files, then talks to the running router.
 */
const path = require('path');

const root = path.resolve(__dirname, '..');

function loadBuildModules() {
  try {
    return {
      status: require(path.join(root, 'build', 'agent-harness-status.js')),
      persistence: require(path.join(root, 'build', 'config-persistence.js'))
    };
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const options = { json: false, verify: false, port: process.env.PORT || '11434' };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--json') options.json = true;
    else if (token === '--verify') options.verify = true;
    else if (token === '--port') options.port = argv[i + 1] || options.port;
    else if (token === '--help' || token === '-h') options.help = true;
  }
  return options;
}

async function probeServer(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
    const payload = await response.json().catch(() => ({}));
    return { ok: true, detail: `v${payload.version || 'unknown'}` };
  } catch (error) {
    return { ok: false, detail: error?.message || String(error) };
  }
}

function check(id, label, healthy, detail, { fatal = false } = {}) {
  return { id, label, healthy: Boolean(healthy), detail, fatal: Boolean(fatal) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node bin/agents-doctor.js [--verify] [--json] [--port N]');
    return 0;
  }

  const modules = loadBuildModules();
  if (!modules) {
    console.error('[agents-doctor] build/ is missing. Run `npm run build` (or `npm install`) first.');
    return 1;
  }

  const baseUrl = `http://127.0.0.1:${options.port}`;
  const config = modules.persistence.loadAgentProxyConfig();
  const status = modules.status.collectAgentHarnessStatus(config, { baseUrl });
  const server = await probeServer(baseUrl);

  const checks = [];
  checks.push(check('server', 'loopback server', server.ok, `${baseUrl} (${server.detail})`, { fatal: true }));
  checks.push(check('claude.env', 'Claude env (env.sh)', status.claude.env.applied, status.claude.env.envScriptPath, {
    fatal: Boolean(config.claudeCode?.enabled)
  }));
  checks.push(check('claude.cli', 'Claude Code CLI', status.claude.cli.found, status.claude.cli.path || 'not on PATH'));
  checks.push(check('claude.proxy', 'Claude interception', Boolean(config.claudeCode?.enabled), config.claudeCode?.enabled ? 'remapping slots' : 'off'));

  const codexConfig = status.codex.config;
  const codexWired = codexConfig.providerBlock === 'present' && codexConfig.profile === 'present';
  checks.push(check('codex.cli', 'Codex CLI', status.codex.cli.found, status.codex.cli.path || 'not on PATH'));
  checks.push(check('codex.proxy', 'Codex interception', Boolean(config.codex?.enabled), config.codex?.enabled ? `profile → ${config.codex.model}` : 'off'));
  checks.push(check(
    'codex.config',
    'Codex provider + profile',
    config.codex?.enabled ? codexWired : true,
    `${codexConfig.providerBlock} / ${codexConfig.profile}`,
    { fatal: Boolean(config.codex?.enabled) }
  ));

  const verifications = [];
  if (options.verify) {
    for (const harness of ['claude', 'codex']) {
      const result = await modules.status.verifyAgentHarness(harness, config, { baseUrl });
      verifications.push(result);
      checks.push(check(`${harness}.roundtrip`, `${harness} round trip`, result.ok, result.detail + (result.error ? ` — ${result.error}` : ''), {
        fatal: true
      }));
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ platform: process.platform, baseUrl, config, status, checks, verifications }, null, 2));
  } else {
    console.log(`Local Router agent doctor — ${process.platform} — ${baseUrl}`);
    for (const item of checks) {
      const verdict = item.healthy ? 'OK  ' : item.fatal ? 'FAIL' : 'WARN';
      console.log(`  ${verdict}  ${item.label.padEnd(24)} ${item.detail}`);
    }
    const failures = checks.filter((item) => !item.healthy && item.fatal);
    console.log('');
    console.log(failures.length === 0
      ? 'Verdict: harness wiring is coherent. Use --verify to spend one round trip per harness.'
      : `Verdict: ${failures.length} blocking problem(s). Fix the FAIL rows above.`);
    if (!status.claude.cli.found && !status.codex.cli.found) {
      console.log('Install:  npm install -g @anthropic-ai/claude-code @openai/codex');
      console.log('Shims:    npm run setup   (Windows: bin on User PATH; macOS/Linux/WSL: ~/.local/share/local-router/bin on PATH)');
    }
  }

  const failed = checks.some((item) => !item.healthy && item.fatal);
  return failed ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('[agents-doctor]', error?.message || error);
    process.exit(1);
  });
