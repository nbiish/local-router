'use strict';

const DEFAULT_HOST = process.env.LOCAL_ROUTER_HOST || '127.0.0.1';
const DEFAULT_PORT = Number.parseInt(process.env.LOCAL_ROUTER_PORT || '11434', 10);

function baseUrl(host = DEFAULT_HOST, port = DEFAULT_PORT) {
  return `http://${host}:${port}`;
}

async function fetchJson(path, options = {}, host = DEFAULT_HOST, port = DEFAULT_PORT) {
  const url = `${baseUrl(host, port)}${path}`;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 15000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }

    if (!response.ok) {
      const message = payload?.error || payload?.message || `HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function probe(host = DEFAULT_HOST, port = DEFAULT_PORT) {
  try {
    await fetchJson('/api/provider-configs', { timeoutMs: 2000 }, host, port);
    return { running: true, kind: 'local-router', baseUrl: baseUrl(host, port) };
  } catch {
    try {
      await fetchJson('/api/version', { timeoutMs: 2000 }, host, port);
      return { running: true, kind: 'ollama-compatible', baseUrl: baseUrl(host, port) };
    } catch {
      return { running: false, kind: 'none', baseUrl: baseUrl(host, port) };
    }
  }
}

function requireServer(probeResult) {
  if (!probeResult.running) {
    const error = new Error(`Local Router is not running at ${probeResult.baseUrl}`);
    error.code = 'ENOTRUNNING';
    throw error;
  }
  if (probeResult.kind !== 'local-router') {
    const error = new Error(`Port is in use by ${probeResult.kind}, not Local Router`);
    error.code = 'EWRONGSERVER';
    throw error;
  }
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  baseUrl,
  fetchJson,
  probe,
  requireServer
};
