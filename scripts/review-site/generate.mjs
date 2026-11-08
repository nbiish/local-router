#!/usr/bin/env node
// Review-site data generator: extracts the repo's work record (comms ledgers,
// git history, task records, memories, suggestions, research, docs) into
// build/review-site/data.json for the static review app. Read-only over the
// repo; writes only under build/ (gitignored).
//
//   node scripts/review-site/generate.mjs [--since YYYY-MM-DD]
//
// --since sets the window that receives full commit diffs (default 2026-11-01).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(ROOT, 'build', 'review-site');

const sinceIdx = process.argv.indexOf('--since');
const DIFF_SINCE = sinceIdx > -1 ? process.argv[sinceIdx + 1] : '2026-11-01';
const DIFF_MAX_CHARS = 120_000;

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function readDirSafe(dir) {
  try {
    return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true });
  } catch {
    return [];
  }
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

function collectCommits() {
  const raw = git([
    'log', '--date=iso-strict',
    '--pretty=format:%H%x1f%h%x1f%ad%x1f%an%x1f%s%x1f%b%x1e',
  ]);
  const commits = raw.split('\x1e').map((chunk) => chunk.trim()).filter(Boolean).map((chunk) => {
    const [sha, short, date, author, subject, body = ''] = chunk.split('\x1f');
    return { sha, short, date, author, subject, body: body.trim(), files: [] };
  });

  // Per-commit file stats in one pass.
  const numstat = git(['log', '--no-merges', '--pretty=format:%x1e%H', '--numstat']);
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  for (const block of numstat.split('\x1e')) {
    const lines = block.split('\n').filter(Boolean);
    if (!lines.length) continue;
    const commit = bySha.get(lines[0].trim());
    if (!commit) continue;
    for (const line of lines.slice(1)) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (m) commit.files.push({ path: m[3], add: m[1] === '-' ? null : Number(m[1]), del: m[2] === '-' ? null : Number(m[2]) });
    }
  }

  // Full diffs only for the recent window.
  for (const commit of commits) {
    if (commit.date.slice(0, 10) < DIFF_SINCE) continue;
    try {
      let diff = git(['show', '--format=', '--no-color', '--patch', commit.sha]);
      if (diff.length > DIFF_MAX_CHARS) diff = diff.slice(0, DIFF_MAX_CHARS) + '\n… [diff truncated by review-site generator]';
      commit.diff = diff;
    } catch {
      commit.diff = '';
    }
  }
  return commits;
}

// ---------------------------------------------------------------------------
// Comms ledgers -> cycles
// ---------------------------------------------------------------------------

const FIELD_RE = /^\s*(?:-\s*)?([A-Za-z][^:\n]{0,49}?):\s*(\S.*)$/;
const ENTRY_HEADER_RE = /^(?:###\s*)?\[(\d{4}-\d{2}-\d{2}T[^\]\s]+)\]\s*(.*)$/;
const OLD_ID_RE = /^-\s*id:\s*(\S.*)$/;

function deriveEvent(start, meta, headerParts) {
  if (headerParts.length > 1) return headerParts[0];
  const words = start.header.replace(/\(.*$/, '').trim().split(/\s+/);
  const cand = (words[0].includes('/') || /^local-router$/i.test(words[0])) ? words[1] : words[0] || '';
  // Old-format ids ("mac-checkout-1", "main-checkin-2", "mac-update-final") encode the event.
  const idm = cand.match(/^(?:main|mac|win|wsl|agent)-([a-z]+(?:-[a-z]+)*?)-(?:\d+|final)$/i);
  if (idm) return idm[1];
  if (start.old) return meta.event || cand || start.header;
  return cand && !cand.includes(' ') ? cand : (meta.event || start.header);
}

function parseLedger(text, file) {
  // The PROTOCOL block is instructions, not work history — and it contains
  // an example entry header that would parse as a real entry.
  const body = text.replace(/<PROTOCOL>[\s\S]*?<\/PROTOCOL>/g, '');
  const lines = body.split('\n');

  const starts = [];
  lines.forEach((line, i) => {
    const h = line.match(ENTRY_HEADER_RE);
    if (h) return starts.push({ i, ts: h[1], header: h[2].trim(), old: false });
    const o = line.match(OLD_ID_RE);
    if (o) return starts.push({ i, ts: null, header: o[1].trim(), old: true });
    return undefined;
  });

  const cycles = [];
  starts.forEach((start, n) => {
    const end = n + 1 < starts.length ? starts[n + 1].i : lines.length;
    const block = lines.slice(start.i, end);
    const fields = [];
    const notes = [];
    let pending = null; // field awaiting YAML block-scalar continuation lines
    for (const line of block.slice(1)) {
      const f = line.match(FIELD_RE);
      if (pending) {
        if (f) pending = null;
        else if (!line.trim()) { pending.value += '\n'; continue; }
        else if (/^\s+\S/.test(line)) { pending.value += `${pending.value.endsWith('\n') ? '' : '\n'}${line.trim()}`; continue; }
        else pending = null;
      }
      if (!line.trim()) continue;
      if (f && !line.trim().startsWith('- id:')) {
        const field = { key: f[1].trim(), value: f[2].trim() };
        fields.push(field);
        if (/^[>|][+-]?$/.test(field.value)) { field.value = ''; pending = field; }
      } else {
        notes.push(line.trim());
      }
    }
    const meta = {};
    for (const f of fields) if (!(f.key in meta)) meta[f.key] = f.value;

    let event = start.header;
    const headerParts = start.header.split('|').map((s) => s.trim());
    if (headerParts.length > 1) {
      for (const part of headerParts.slice(1)) {
        const kv = part.match(/^([\w-]+):\s*(.*)$/);
        if (kv) meta[kv[1]] = kv[2];
      }
    }
    event = deriveEvent(start, meta, headerParts);

    const ts = start.ts || meta.start || '';
    cycles.push({
      id: `${file}#${cycles.length}#${ts}`,
      ts,
      date: ts.slice(0, 10) || file.slice(0, 10),
      event: event || '(entry)',
      kind: (event || '').toLowerCase().replace(/\s+/g, '-').replace(/^feature$/, 'feat'),
      ledger: file,
      fields,
      notes,
      status: meta.status || '',
      branch: meta.branch || '',
      worktree: meta.wt || meta.worktree || '',
    });
  });
  return cycles;
}

function collectCycles() {
  const cycles = [];
  for (const entry of readDirSafe('.agents/comms')) {
    if (!entry.isFile() || !entry.name.endsWith('-team.txt')) continue; // durable ledger only, not *.live.txt
    cycles.push(...parseLedger(readText(path.join('.agents/comms', entry.name)), entry.name));
  }
  cycles.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return cycles;
}

// ---------------------------------------------------------------------------
// Records: tasks, memories, suggestions, research
// ---------------------------------------------------------------------------

function collectTextRecords(dir, kind) {
  const out = [];
  for (const entry of readDirSafe(dir)) {
    if (!entry.isFile()) continue;
    const rel = path.join(dir, entry.name);
    let text = '';
    try {
      const stat = fs.statSync(path.join(ROOT, rel));
      if (stat.size > 512 * 1024) continue;
      text = readText(rel);
    } catch {
      continue;
    }
    const firstHeading = text.match(/^#\s*(.+)$/m);
    const mtime = fs.statSync(path.join(ROOT, rel)).mtime.toISOString().slice(0, 10);
    out.push({
      kind,
      file: rel,
      name: entry.name,
      date: (entry.name.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || mtime,
      title: firstHeading ? firstHeading[1].trim() : entry.name,
      text,
    });
  }
  out.sort((a, b) => (a.name < b.name ? 1 : -1));
  return out;
}

// ---------------------------------------------------------------------------
// Docs
// ---------------------------------------------------------------------------

const DOC_GROUPS = [
  { group: 'Overview', files: ['README.md', 'llms.txt'] },
  { group: 'Design', files: ['ROUTER.md', 'PROVIDER_ENDPOINTS.md', 'ROUTER-RESEARCH.md'] },
  { group: 'Operations', files: ['RELEASING.md', 'SETUP.md'] },
  { group: 'Standards', files: ['critical.md', 'AGENTS.md'] },
];

function collectDocs() {
  const docs = [];
  for (const g of DOC_GROUPS) {
    for (const file of g.files) {
      try {
        docs.push({ path: file, group: g.group, title: file, text: readText(file) });
      } catch { /* absent on this revision */ }
    }
  }
  for (const entry of readDirSafe('docs')) {
    if (entry.isDirectory()) {
      for (const sub of readDirSafe(path.join('docs', entry.name))) {
        if (!sub.isFile()) continue;
        const rel = path.join('docs', entry.name, sub.name);
        docs.push({ path: rel, group: `docs/${entry.name}`, title: sub.name, text: readText(rel) });
      }
    } else if (entry.isFile()) {
      const rel = path.join('docs', entry.name);
      docs.push({ path: rel, group: 'docs', title: entry.name, text: readText(rel) });
    }
  }
  return docs;
}

// ---------------------------------------------------------------------------

const commits = collectCommits();
const cycles = collectCycles();
const tasks = collectTextRecords('.agents/tasks', 'task');
const memories = collectTextRecords('.agents/memories', 'memory');
const suggestions = collectTextRecords('.agents/suggestions', 'suggestion');
const research = collectTextRecords('.agents/research', 'research');
const docs = collectDocs();

const head = commits[0] || {};
const data = {
  generatedAt: new Date().toISOString(),
  diffSince: DIFF_SINCE,
  head: { sha: head.sha || '', short: head.short || '', subject: head.subject || '', date: head.date || '' },
  stats: {
    commits: commits.length,
    cycles: cycles.length,
    tasks: tasks.length,
    memories: memories.length,
    suggestions: suggestions.length,
    research: research.length,
    docs: docs.length,
  },
  commits,
  cycles,
  tasks,
  memories,
  suggestions,
  research,
  docs,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const file of ['index.html', 'style.css', 'app.js']) {
  fs.copyFileSync(path.join(ROOT, 'scripts', 'review-site', 'app', file), path.join(OUT_DIR, file));
}
fs.writeFileSync(path.join(OUT_DIR, 'data.json'), JSON.stringify(data));

const bytes = fs.statSync(path.join(OUT_DIR, 'data.json')).size;
console.log(`review-site: ${commits.length} commits (${commits.filter((c) => c.diff).length} with diffs since ${DIFF_SINCE}), ${cycles.length} cycles, ${tasks.length} tasks, ${memories.length} memories, ${docs.length} docs -> build/review-site/data.json (${(bytes / 1024).toFixed(0)} KiB)`);
