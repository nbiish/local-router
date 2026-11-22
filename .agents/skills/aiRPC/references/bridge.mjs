#!/usr/bin/env node
// aiRPC bridge v1 — zero-dependency transport between the tldraw canvas and one waiting agent.
// Requires Node >= 22 (Promise.withResolvers).
//
//   node bridge.mjs serve   [--port 7331] [--session main] [--app DIR]
//   node bridge.mjs project (--manifest FILE | --from name=path)... [--session main] [--url URL]
//   node bridge.mjs wait    [--session main] [--by ISO] [--url URL]
//   node bridge.mjs ack     --file FILE [--session main] [--url URL]
//   node bridge.mjs stop    [--session main]
//   node bridge.mjs status  [--session main]
//
// Exit codes: 0 = success (wait: one event printed on stdout), 2 = --by deadline expired (wait),
// 1 = hard error. State: $AIRPC_HOME/<session>/{manifest.json,inbox.jsonl,log.jsonl,consumer.lock,
// serve.pid}. State survives restarts: stop the server, start it again, keep adding to the session.
// Security: binds 127.0.0.1 only, checks Host/Origin, writes only under $AIRPC_HOME, serves static
// files only from --app with path traversal rejected.
import { createServer } from 'node:http'
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'

const HOME = process.env.AIRPC_HOME || join(homedir(), '.airpc')
const DEFAULT_URL = 'http://127.0.0.1:7331'
const VERSION = 1
const LONGPOLL_MS = 25_000
const BODY_CAP = 4000
const FILE_CAP = 200_000
const FOLDER_CAP = 6

// ---------- args / primitives ----------

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { out._.push(a); continue }
    const k = a.slice(2)
    const v = argv[i + 1]
    const val = v !== undefined && !v.startsWith('--') ? (i++, v) : true
    out[k] = k in out ? [].concat(out[k], val) : val
  }
  return out
}

function die(msg) {
  process.stderr.write(`airpc: ${msg}\n`)
  process.exit(1)
}

function hashHex(s) {
  return createHash('sha256').update(s).digest('hex')
}

export function blockId(repo, path, anchor) {
  return `blk-${hashHex(`${repo}:${path}#${anchor}`).slice(0, 12)}`
}
export function bodyDigest(repo, path, body) {
  return hashHex(`${repo}\u0000${path}\u0000${body}`).slice(0, 12)
}

function sessionDir(session) { return join(HOME, session) }
function ensureSession(session) {
  mkdirSync(sessionDir(session), { recursive: true })
  return sessionDir(session)
}
function readJsonl(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line, i) => {
    try { return JSON.parse(line) } catch { die(`malformed JSON at ${file}:${i + 1} (fail closed)`) }
  })
}
function appendJsonl(file, obj) { appendFileSync(file, JSON.stringify(obj) + '\n') }
function now() { return new Date().toISOString() }

// ---------- payload validation (fail closed) ----------

function isSafeRelPath(p) {
  return typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.split('/').includes('..')
}
function isRepoName(r) {
  return typeof r === 'string' && /^[A-Za-z0-9._-]+$/.test(r)
}
function validateBlock(b) {
  if (!b || typeof b !== 'object') return 'block: not an object'
  for (const k of ['id', 'repo', 'path', 'anchor', 'title', 'kind', 'digest', 'body']) {
    if (typeof b[k] !== 'string') return `block: ${k} must be a string`
  }
  if (!isRepoName(b.repo)) return 'block: bad repo name'
  if (!isSafeRelPath(b.path)) return 'block: unsafe path'
  if (b.id !== blockId(b.repo, b.path, b.anchor)) return 'block: id mismatch'
  if (b.digest !== bodyDigest(b.repo, b.path, b.body)) return 'block: digest mismatch'
  if (!Number.isInteger(b.lane) || b.lane < 0) return 'block: lane must be a non-negative integer'
  if (b.links !== undefined && !Array.isArray(b.links)) return 'block: links must be an array'
  return null
}
function validateManifest(m, session) {
  if (!m || typeof m !== 'object') return 'manifest: not an object'
  if (m.v !== VERSION) return 'manifest: unsupported version'
  if (m.session !== session) return 'manifest: session mismatch'
  if (!Array.isArray(m.blocks)) return 'manifest: blocks must be an array'
  const ids = new Set()
  for (const b of m.blocks) {
    const err = validateBlock(b)
    if (err) return err
    if (ids.has(b.id)) return 'manifest: duplicate block id'
    ids.add(b.id)
  }
  for (const b of m.blocks) {
    for (const l of b.links ?? []) if (!ids.has(l)) return 'manifest: link to unknown block'
  }
  return null
}
function validateCall(c, session) {
  if (!c || typeof c !== 'object') return 'call: not an object'
  if (c.v !== VERSION || (c.kind !== 'call' && c.kind !== 'query')) return 'call: unsupported version or kind'
  if (c.session !== undefined && c.session !== session) return 'call: session mismatch'
  if (typeof c.prompt !== 'string' || c.prompt.length === 0) return 'call: prompt must be a non-empty string'
  if (c.kind === 'query') {
    // a query has no record seat: no path, no block binding, no digest
    if (c.path !== '' || c.block_id !== '' || c.digest !== '') return 'call: query must carry empty path/block_id/digest'
    if (typeof c.anchor !== 'string' || c.anchor.length === 0) return 'call: query needs a title in anchor'
    return null
  }
  for (const k of ['repo', 'block_id', 'path', 'anchor', 'digest']) {
    if (typeof c[k] !== 'string') return `call: ${k} must be a string`
  }
  if (!isRepoName(c.repo)) return 'call: bad repo name'
  if (!isSafeRelPath(c.path)) return 'call: unsafe path'
  if (c.block_id !== blockId(c.repo, c.path, c.anchor)) return 'call: block_id mismatch'
  return null
}
function validateAck(a, session, inbox) {
  if (!a || typeof a !== 'object') return 'ack: not an object'
  if (a.v !== VERSION || a.kind !== 'ack') return 'ack: unsupported version or kind'
  for (const k of ['call_id', 'status', 'summary']) {
    if (typeof a[k] !== 'string') return `ack: ${k} must be a string`
  }
  if (typeof a.block_id !== 'string') return 'ack: block_id must be a string'
  if (!['done', 'needs-you', 'stale', 'refused'].includes(a.status)) return 'ack: bad status'
  if (a.status === 'done' && a.block_id !== '' && typeof a.new_digest !== 'string') {
    return 'ack: done on a call requires new_digest'
  }
  if (a.note !== undefined && typeof a.note !== 'string') return 'ack: note must be a string'
  if (!inbox.some((e) => e.id === a.call_id && (e.kind === 'call' || e.kind === 'query'))) {
    return 'ack: unknown call_id'
  }
  return null
}

// ---------- projection scanner (project --from name=path) ----------
// Reference implementation of the projection rules (protocol.md §2): split at `# `..`### `
// headings, anchor = heading text (duplicates suffixed `~N` = Nth occurrence), body capped at
// 4000 chars. Deterministic: re-running yields identical ids and digests — that is what makes
// digest verification possible after an edit.

const LANE_BASE = {
  contract: 0, architecture: 1, docs: 2, wiki: 3, plan: 4, task: 5, comms: 6, memory: 7, suggestion: 8,
}
const FILES = [
  ['AGENTS.md', 'contract'], ['README.md', 'docs'], ['llms.txt', 'architecture'],
  ['.agents/llms.txt', 'architecture'],
]
const DIRS = [
  ['.agents/wiki', 'wiki'], ['.agents/plans', 'plan'], ['.agents/tasks', 'task'],
  ['.agents/comms', 'comms'], ['.agents/memories', 'memory'], ['.agents/suggestions', 'suggestion'],
]

export function splitSections(text) {
  const lines = text.split('\n')
  const sections = []
  let current = null
  let preamble = ''
  for (const line of lines) {
    const m = /^(#{1,3}) +(.+?)\s*$/.exec(line)
    if (m) {
      if (current) sections.push(current)
      current = { anchor: m[2], body: line + '\n' }
    } else if (current) {
      current.body += line + '\n'
    } else {
      preamble += line + '\n'
    }
  }
  if (current) sections.push(current)
  // duplicate anchors: `text` then `text~2`, `text~3` (Nth occurrence)
  const seen = new Map()
  const out = []
  const p = preamble.trim()
  if (p) out.push({ anchor: '', body: p })
  for (const s of sections) {
    const n = (seen.get(s.anchor) ?? 0) + 1
    seen.set(s.anchor, n)
    out.push({ anchor: n === 1 ? s.anchor : `${s.anchor}~${n}`, body: s.body.replace(/\n+$/, '') })
  }
  return out.filter((s) => s.body.trim().length > 0)
}

export function scanRepo(name, root, repoIndex) {
  const abs = resolve(root)
  const blocks = []
  const add = (rel, kind) => {
    const file = join(abs, rel)
    if (!existsSync(file)) return
    let text
    try { text = readFileSync(file, 'utf8') } catch { return }
    if (text.length > FILE_CAP) return
    for (const { anchor, body } of splitSections(text)) {
      const capped = body.length > BODY_CAP ? body.slice(0, BODY_CAP) : body
      blocks.push({
        id: blockId(name, rel, anchor),
        repo: name,
        path: rel,
        anchor,
        title: anchor ? `${rel} › ${anchor}` : rel,
        kind,
        digest: bodyDigest(name, rel, capped),
        lane: LANE_BASE[kind] + repoIndex * 9,
        body: capped,
        links: [],
      })
    }
  }
  for (const [rel, kind] of FILES) add(rel, kind)
  for (const [dir, kind] of DIRS) {
    const absDir = join(abs, dir)
    if (!existsSync(absDir)) continue
    const names = readdirSync(absDir)
      .filter((n) => /\.(md|txt)$/.test(n))
      .sort() // names are date-prefixed: ascending sort, take from the end = newest first
      .slice(-FOLDER_CAP)
      .reverse()
    for (const n of names) add(`${dir}/${n}`, kind)
  }
  return blocks
}

// ---------- long-poll hub ----------

function hub() {
  const waiters = new Set()
  return {
    wake() { for (const w of waiters) w() },
    wait(ms) {
      const { promise, resolve } = Promise.withResolvers()
      const done = () => { clearTimeout(t); waiters.delete(done); resolve() }
      const t = setTimeout(done, ms)
      waiters.add(done)
      return promise
    },
  }
}

// ---------- serve ----------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json',
}

async function serve(args) {
  const port = Number(args.port ?? 7331)
  const session = String(args.session ?? 'main')
  const allowedOrigins = new Set([].concat(args['allow-origin'] ?? []).map(String))
  const dir = ensureSession(session)
  const appDir = args.app ? resolve(String(args.app)) : null
  if (appDir && (!existsSync(appDir) || !statSync(appDir).isDirectory())) die(`serve: --app ${appDir} is not a directory`)
  const inboxHub = hub()
  const eventHub = hub()

  const readInbox = () => readJsonl(join(dir, 'inbox.jsonl'))
  const readLog = () => readJsonl(join(dir, 'log.jsonl'))

  const pidFile = join(dir, 'serve.pid')
  if (existsSync(pidFile)) {
    try {
      const prev = JSON.parse(readFileSync(pidFile, 'utf8'))
      process.kill(prev.pid, 0)
      die(`serve: session "${session}" already running (pid ${prev.pid}); stop it first`)
    } catch { /* stale pid file */ }
  }
  writeFileSync(pidFile, JSON.stringify({ pid: process.pid, port, app: appDir, started: now() }))

  let shuttingDown = false
  const shutdown = (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    try { rmSync(pidFile) } catch { /* already gone */ }
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1000).unref()
    if (signal) process.stderr.write(`airpc: session "${session}" stopped (${signal})\n`)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  const server = createServer(async (req, res) => {
    const host = req.headers.host ?? ''
    const origin = req.headers.origin
    const self = `127.0.0.1:${port}`
    const selfAlt = `localhost:${port}`
    if (host !== self && host !== selfAlt) {
      res.writeHead(403, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'host not allowed' }))
    }
    if (origin !== undefined && origin !== `http://${self}` && origin !== `http://${selfAlt}` && !allowedOrigins.has(origin)) {
      res.writeHead(403, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'origin not allowed' }))
    }
    const url = new URL(req.url, `http://${self}`)
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(obj))
    }
    const body = () => new Promise((resolveBody) => {
      let data = ''
      req.on('data', (c) => { data += c })
      req.on('end', () => resolveBody(data))
    })

    try {
      if (req.method === 'GET' && url.pathname === '/state') {
        return json(200, {
          session,
          manifest: existsSync(join(dir, 'manifest.json'))
            ? JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) : null,
          inbox: readInbox(),
          events: readLog(),
        })
      }
      if (req.method === 'GET' && (url.pathname === '/events' || url.pathname === '/rpc/wait')) {
        const after = Number(url.searchParams.get('after') ?? 0)
        const isEvents = url.pathname === '/events'
        const read = isEvents ? readLog : readInbox
        const deadline = Date.now() + LONGPOLL_MS
        for (;;) {
          let rows = read().map((r, i) => ({ ...r, seq: i + 1 })).filter((r) => r.seq > after)
          if (!isEvents) {
            // wait surfaces unacked calls/queries and end events; acked ones are settled
            const acked = new Set(readLog().filter((e) => e.kind === 'ack').map((e) => e.call_id))
            rows = rows.filter((r) => (r.kind !== 'call' && r.kind !== 'query') || !acked.has(r.id))
          }
          if (rows.length) return json(200, rows)
          if (Date.now() >= deadline) return json(200, [])
          await (isEvents ? eventHub : inboxHub).wait(Math.min(2000, deadline - Date.now()))
        }
      }
      if (req.method === 'POST' && url.pathname === '/rpc') {
        let call
        try { call = JSON.parse(await body()) } catch { return json(400, { error: 'malformed JSON' }) }
        call.v ??= VERSION
        call.kind ??= 'call'
        call.session = session
        call.id ??= `call-${randomUUID()}`
        call.ts ??= now()
        const err = validateCall(call, session)
        if (err) return json(400, { error: err })
        const seq = readInbox().length + 1
        appendJsonl(join(dir, 'inbox.jsonl'), call)
        inboxHub.wake()
        return json(202, { ok: true, id: call.id, seq })
      }
      if (req.method === 'POST' && url.pathname === '/project') {
        let manifest
        try { manifest = JSON.parse(await body()) } catch { return json(400, { error: 'malformed JSON' }) }
        const err = validateManifest(manifest, session)
        if (err) return json(400, { error: err })
        writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
        appendJsonl(join(dir, 'log.jsonl'), { v: VERSION, kind: 'project', ts: now(), blocks: manifest.blocks.length })
        eventHub.wake()
        return json(202, { ok: true, blocks: manifest.blocks.length })
      }
      if (req.method === 'POST' && url.pathname === '/ack') {
        let ack
        try { ack = JSON.parse(await body()) } catch { return json(400, { error: 'malformed JSON' }) }
        const err = validateAck(ack, session, readInbox())
        if (err) return json(400, { error: err })
        appendJsonl(join(dir, 'log.jsonl'), ack)
        eventHub.wake()
        return json(202, { ok: true, seq: readLog().length })
      }
      if (req.method === 'POST' && url.pathname === '/end') {
        let reason = 'unspecified'
        try { reason = JSON.parse(await body()).reason ?? reason } catch { /* bare /end is fine */ }
        const ev = { v: VERSION, kind: 'end', session, reason, ts: now() }
        appendJsonl(join(dir, 'inbox.jsonl'), ev)
        appendJsonl(join(dir, 'log.jsonl'), ev)
        inboxHub.wake(); eventHub.wake()
        return json(202, { ok: true })
      }
      if (req.method === 'POST' && url.pathname === '/shutdown') {
        json(202, { ok: true })
        setTimeout(() => shutdown('shutdown endpoint'), 50)
        return
      }
      // static app (only with --app; path traversal rejected)
      if (req.method === 'GET' && appDir) {
        const rel = decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname.slice(1))
        if (rel.split('/').includes('..') || rel.includes('\0')) return json(404, { error: 'not found' })
        const file = resolve(appDir, rel)
        if (!file.startsWith(appDir)) return json(404, { error: 'not found' })
        if (existsSync(file) && statSync(file).isFile()) {
          res.writeHead(200, { 'content-type': MIME[rel.slice(rel.lastIndexOf('.'))] ?? 'application/octet-stream' })
          return res.end(readFileSync(file))
        }
        return json(404, { error: 'not found' })
      }
      return json(404, { error: 'unknown route' })
    } catch (e) {
      return json(500, { error: String(e?.message ?? e) })
    }
  })
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`airpc: serving session "${session}" on http://127.0.0.1:${port}${appDir ? ` (app: ${appDir})` : ''}\n`)
  })
}

// ---------- CLI clients (project / wait / ack / stop / status) ----------

async function post(url, pathName, payload) {
  const res = await fetch(new URL(pathName, url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const out = await res.json().catch(() => ({}))
  if (!res.ok) die(`${pathName} failed: HTTP ${res.status} ${out.error ?? ''}`)
  return out
}

async function project(args) {
  const session = String(args.session ?? 'main')
  const url = String(args.url ?? DEFAULT_URL)
  let manifest
  if (args.manifest) {
    manifest = JSON.parse(readFileSync(String(args.manifest), 'utf8'))
    manifest.session = session
  } else if (args.from) {
    const froms = [].concat(args.from)
    const blocks = []
    for (let i = 0; i < froms.length; i++) {
      const raw = String(froms[i])
      const eq = raw.indexOf('=')
      const name = eq > 0 ? raw.slice(0, eq) : ''
      const root = eq > 0 ? raw.slice(eq + 1) : ''
      if (!isRepoName(name) || !root) die(`project: --from name=path, got "${raw}"`)
      const abs = resolve(root)
      if (!existsSync(abs) || !statSync(abs).isDirectory()) die(`project: ${abs} is not a directory`)
      blocks.push(...scanRepo(name, abs, i))
    }
    manifest = { v: VERSION, session, generated: now(), blocks }
  } else {
    die('project: --manifest FILE or --from name=path is required')
  }
  const out = await post(url, '/project', manifest)
  process.stdout.write(JSON.stringify(out) + '\n')
}

async function ack(args) {
  const session = String(args.session ?? 'main')
  const url = String(args.url ?? DEFAULT_URL)
  if (!args.file) die('ack: --file FILE is required')
  const a = JSON.parse(readFileSync(String(args.file), 'utf8'))
  const out = await post(url, '/ack', a)
  process.stdout.write(JSON.stringify(out) + '\n')
}

async function waitCmd(args) {
  const session = String(args.session ?? 'main')
  const url = String(args.url ?? DEFAULT_URL)
  const deadlineMs = args.by ? Date.parse(String(args.by)) : Infinity
  if (Number.isNaN(deadlineMs)) die('wait: --by is not a valid ISO time')

  // single consumer: claim consumer.lock for this session (in $AIRPC_HOME, not the repo)
  const dir = ensureSession(session)
  const lock = join(dir, 'consumer.lock')
  try {
    const fd = openSync(lock, 'wx')
    writeFileSync(fd, String(process.pid))
    closeSync(fd)
  } catch {
    die(`session "${session}" already has a wait consumer (consumer.lock)`)
  }
  const release = () => { try { rmSync(lock) } catch { /* already gone */ } }
  process.on('exit', release)
  process.on('SIGINT', () => process.exit(1))
  process.on('SIGTERM', () => process.exit(1))

  let after = 0
  for (;;) {
    const remaining = deadlineMs - Date.now()
    if (remaining <= 0) {
      process.stderr.write(`airpc: --by deadline expired with no response for session "${session}"\n`)
      release()
      process.exit(2)
    }
    const pathName = `/rpc/wait?after=${after}`
    let rows = []
    try {
      const res = await fetch(new URL(pathName, url), { signal: AbortSignal.timeout(Math.min(LONGPOLL_MS + 5000, Math.max(1, remaining))) })
      rows = await res.json()
    } catch (e) {
      if (Date.now() >= deadlineMs) {
        process.stderr.write(`airpc: --by deadline expired with no response for session "${session}"\n`)
        release()
        process.exit(2)
      }
      if (remaining > 5000) {
        const { promise, resolve } = Promise.withResolvers()
        setTimeout(resolve, 1000)
        await promise
        continue
      }
      die(`wait: bridge unreachable at ${url}: ${e?.message ?? e}`)
    }
    for (const row of rows) {
      after = Math.max(after, row.seq ?? after)
      if (row.kind === 'call' || row.kind === 'query' || row.kind === 'end') {
        process.stdout.write(JSON.stringify(row) + '\n')
        release()
        return
      }
    }
  }
}

function stopCmd(args) {
  const session = String(args.session ?? 'main')
  const pidFile = join(sessionDir(session), 'serve.pid')
  if (!existsSync(pidFile)) {
    process.stdout.write(`airpc: session "${session}" is not running\n`)
    return
  }
  let rec
  try { rec = JSON.parse(readFileSync(pidFile, 'utf8')) } catch { die('stop: malformed serve.pid') }
  try { process.kill(rec.pid, 0) } catch {
    rmSync(pidFile, { force: true })
    process.stdout.write(`airpc: session "${session}" is not running (stale pid file removed)\n`)
    return
  }
  // never signal a pid that is not this bridge (fail closed)
  let cmdline = ''
  try { cmdline = execSync(`ps -p ${rec.pid} -o command=`, { encoding: 'utf8' }) } catch { die('stop: cannot inspect pid') }
  if (!cmdline.includes('bridge.mjs')) die(`stop: pid ${rec.pid} is not an aiRPC bridge; refusing to signal`)
  process.kill(rec.pid, 'SIGTERM')
  for (let i = 0; i < 50; i++) {
    try { process.kill(rec.pid, 0) } catch {
      rmSync(pidFile, { force: true })
      process.stdout.write(`airpc: session "${session}" stopped (pid ${rec.pid})\n`)
      return
    }
    execSync('sleep 0.1')
  }
  process.kill(rec.pid, 'SIGKILL')
  rmSync(pidFile, { force: true })
  process.stdout.write(`airpc: session "${session}" killed (pid ${rec.pid} ignored SIGTERM)\n`)
}

function statusCmd(args) {
  const session = String(args.session ?? 'main')
  const pidFile = join(sessionDir(session), 'serve.pid')
  let running = false, rec = null
  if (existsSync(pidFile)) {
    try {
      rec = JSON.parse(readFileSync(pidFile, 'utf8'))
      process.kill(rec.pid, 0)
      running = true
    } catch { /* stale */ }
  }
  const dir = sessionDir(session)
  process.stdout.write(JSON.stringify({
    session, running, pid: rec?.pid ?? null, port: rec?.port ?? null, app: rec?.app ?? null,
    state_dir: dir,
    inbox: readJsonl(join(dir, 'inbox.jsonl')).length,
    events: readJsonl(join(dir, 'log.jsonl')).length,
    manifest: existsSync(join(dir, 'manifest.json')),
  }) + '\n')
}

// ---------- entry ----------
import { pathToFileURL } from 'node:url'

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , command, ...rest] = process.argv
  const args = parseArgs(rest)
  if (command === 'serve') await serve(args)
  else if (command === 'project') await project(args)
  else if (command === 'ack') await ack(args)
  else if (command === 'wait') await waitCmd(args)
  else if (command === 'stop') stopCmd(args)
  else if (command === 'status') statusCmd(args)
  else die('usage: bridge.mjs serve|project|wait|ack|stop|status [--session ID] [--url URL] [--port N] [--app DIR] [--manifest F] [--file F] [--from name=path] [--by ISO]')
}
