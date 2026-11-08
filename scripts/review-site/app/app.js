/* local-router work review — static explorer app.
   All repo text is data: every interpolation into HTML goes through esc(). */

'use strict';

let DATA = null;

/* ------------------------------ helpers ------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtTs(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDay(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}

function dayKey(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts).slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function eventChip(cycle) {
  return `<span class="chip event-${esc(cycle.kind || 'other')}">${esc(cycle.event)}</span>`;
}

function statusChip(status) {
  if (!status) return '';
  return `<span class="chip status status-${esc(status.toLowerCase())}">${esc(status)}</span>`;
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const query = new URLSearchParams(queryPart || '');
  return { segments, query };
}

function navTo(hash) {
  location.hash = hash;
}

/* --------------------------- markdown renderer --------------------------- */

function inlineMd(text) {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
    const safe = /^(https?:|#|\/)/i.test(href) ? href : '#';
    return `<a href="${esc(safe)}" ${/^https?:/i.test(safe) ? 'target="_blank" rel="noopener"' : ''}>${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  return s;
}

function mdToHtml(src) {
  const fences = [];
  let text = String(src ?? '').replace(/```[\w-]*\n([\s\S]*?)```/g, (m, code) => {
    fences.push(code);
    return `\u0000F${fences.length - 1}\u0000`;
  });

  const out = [];
  const lines = text.split('\n');
  let i = 0;
  const listStack = [];

  const closeLists = (depth = 0) => {
    while (listStack.length > depth) out.push(listStack.pop() === 'ol' ? '</ol>' : '</ul>');
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^\u0000F\d+\u0000$/.test(line.trim())) {
      closeLists();
      const code = fences[Number(line.trim().slice(2, -1))];
      out.push(`<pre><code>${esc(code)}</code></pre>`);
      i += 1;
      continue;
    }

    const fenceInline = line.match(/^(\s*)\u0000F(\d+)\u0000\s*$/);
    if (fenceInline) {
      closeLists();
      out.push(`<pre><code>${esc(fences[Number(fenceInline[2])])}</code></pre>`);
      i += 1;
      continue;
    }

    if (!line.trim()) { closeLists(); i += 1; continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeLists();
      const level = h[1].length;
      const id = h[2].toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
      out.push(`<h${level} id="${esc(id)}">${inlineMd(h[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) { closeLists(); out.push('<hr>'); i += 1; continue; }

    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      closeLists();
      const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i])); i += 1; }
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inlineMd(c)}</th>`).join('')}</tr></thead>`
        + `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }

    const bq = line.match(/^\s*>\s?(.*)$/);
    if (bq) {
      closeLists();
      const body = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
      out.push(`<blockquote>${body.map((l) => `<p>${inlineMd(l)}</p>`).join('')}</blockquote>`);
      continue;
    }

    const ul = line.match(/^(\s*)[-*+]\s+(.*)$/);
    const ol = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const kind = ul ? 'ul' : 'ol';
      const depth = Math.floor((ul || ol)[1].length / 2) + 1;
      if (listStack.length > depth) closeLists(depth);
      if (listStack.length < depth) { out.push(`<${kind}>`); listStack.push(kind); }
      out.push(`<li>${inlineMd((ul || ol)[2])}</li>`);
      i += 1;
      continue;
    }

    closeLists();
    out.push(`<p>${inlineMd(line)}</p>`);
    i += 1;
  }
  closeLists();
  return out.join('\n');
}

/* ------------------------------ overview ------------------------------ */

function viewOverview() {
  const { commits, cycles, stats, head } = DATA;
  const since = DATA.diffSince;

  // Commits + cycles per local day, last 45 days.
  const days = [];
  const byDay = new Map();
  const now = Date.now();
  for (let t = now - 44 * 864e5; t <= now; t += 864e5) {
    const key = dayKey(new Date(t).toISOString());
    byDay.set(key, { key, commits: 0, cycles: 0 });
    days.push(key);
  }
  for (const c of commits) {
    const e = byDay.get(dayKey(c.date));
    if (e) e.commits += 1;
  }
  for (const c of cycles) {
    const e = byDay.get(dayKey(c.ts || c.date));
    if (e) e.cycles += 1;
  }
  const maxV = Math.max(1, ...days.map((k) => byDay.get(k).commits));
  const bars = days.map((k) => {
    const e = byDay.get(k);
    const h1 = Math.round((e.commits / maxV) * 74) || 0;
    const h2 = Math.round((e.cycles / maxV) * 74) || 0;
    return `<div class="row" style="gap:1px;align-items:flex-end;flex:1;flex-wrap:nowrap">`
      + `<div class="bar" style="height:${Math.max(h1, e.commits ? 3 : 0)}px" data-tip="${esc(k)}: ${e.commits} commits"></div>`
      + `<div class="bar c2" style="height:${Math.max(h2, e.cycles ? 3 : 0)}px" data-tip="${esc(k)}: ${e.cycles} cycles"></div></div>`;
  }).join('');

  const recentCycles = cycles.slice(0, 6).map((c) => cycleCard(c, false)).join('');
  const recentCommits = commits.slice(0, 10).map((c) => `
    <div class="tl-item" data-nav="#/commits/${esc(c.sha)}">
      <span class="dot"></span>
      <span class="when">${esc(fmtTs(c.date))}</span>
      <span class="what"><span class="mono">${esc(c.short)}</span> ${esc(c.subject)}</span>
      <span class="cmp-stats"><span class="cmp-add">+${c.files.reduce((s, f) => s + (f.add || 0), 0)}</span>
      <span class="cmp-del">-${c.files.reduce((s, f) => s + (f.del || 0), 0)}</span></span>
    </div>`).join('');

  const attention = cycles.filter((c) => {
    const blockers = (c.fields.find((f) => /^blockers?$/i.test(f.key)) || {}).value || '';
    return (c.status && !/merged|done|complete/i.test(c.status)) || (blockers && !/^none/i.test(blockers));
  }).slice(0, 8).map((c) => {
    const blocker = (c.fields.find((f) => /^blockers?$/i.test(f.key)) || {}).value || '';
    return `<div class="tl-item" data-nav="#/cycles?open=${encodeURIComponent(c.id)}">
      <span class="dot" style="background:var(--warning)"></span>
      <span class="when">${esc(fmtTs(c.ts))}</span>
      <span class="what">${eventChip(c)} ${esc((c.fields.find((f) => f.key === 'objective') || {}).value || c.event)}${statusChip(c.status)}
      ${blocker ? `<div class="small muted">${esc(blocker.slice(0, 160))}</div>` : ''}</span>
    </div>`;
  }).join('') || '<div class="empty">No open blockers or unfinished cycles in the record.</div>';

  return `
  <div class="prose-width" style="max-width:1100px">
    <h1>Recent work at a glance</h1>
    <div class="muted">HEAD <code>${esc(head.short)}</code> ${esc(head.subject)} · ${esc(fmtTs(head.date))}</div>
    <div class="tiles">
      <div class="tile"><div class="n">${stats.commits}</div><div class="l">commits on record<br><span class="small">${commits.filter((c) => c.diff).length} with diffs since ${esc(since)}</span></div></div>
      <div class="tile"><div class="n">${stats.cycles}</div><div class="l">work cycles (comms)</div></div>
      <div class="tile"><div class="n">${stats.tasks}</div><div class="l">task records</div></div>
      <div class="tile"><div class="n">${stats.memories}</div><div class="l">memory files</div></div>
      <div class="tile"><div class="n">${stats.docs}</div><div class="l">documents</div></div>
    </div>

    <h2>Activity — last 45 days</h2>
    <div class="row small muted"><span class="chip" style="background:var(--c1);color:#fff">commits</span> <span class="chip" style="background:var(--c2);color:#fff">work cycles</span> (per day, local time)</div>
    <div class="bars">${bars}</div>
    <div class="row small muted" style="justify-content:space-between"><span>${esc(days[0])}</span><span>${esc(days[days.length - 1])}</span></div>

    <h2>Needs attention</h2>
    ${attention}

    <h2>Latest work cycles</h2>
    ${recentCycles}
    <div class="row"><a href="#/cycles">All ${stats.cycles} cycles →</a></div>

    <h2>Latest commits</h2>
    ${recentCommits}
    <div class="row"><a href="#/commits">Full commit history →</a></div>
  </div>`;
}

/* ------------------------------ timeline ------------------------------ */

let timelineFilter = new Set(['cycle', 'commit', 'memory']);

function viewTimeline() {
  const items = [];
  for (const c of DATA.cycles) {
    if (!timelineFilter.has('cycle')) continue;
    items.push({ ts: c.ts || c.date, kind: 'cycle', id: c.id, chip: eventChip(c), text: (c.fields.find((f) => f.key === 'objective') || {}).value || c.event, status: c.status, nav: `#/cycles?open=${encodeURIComponent(c.id)}` });
  }
  for (const c of DATA.commits) {
    if (!timelineFilter.has('commit')) continue;
    items.push({ ts: c.date, kind: 'commit', id: c.sha, chip: `<span class="chip">${esc(c.short)}</span>`, text: c.subject, nav: `#/commits/${esc(c.sha)}` });
  }
  for (const m of DATA.memories) {
    if (!timelineFilter.has('memory')) continue;
    const stamp = m.date ? `${m.date}T12:00:00` : '';
    items.push({ ts: stamp, kind: 'memory', id: m.file, chip: `<span class="chip">memory</span>`, text: `${m.name} — ${m.text.split('\n').filter(Boolean).length} notes`, nav: `#/records/memory?file=${encodeURIComponent(m.name)}` });
  }
  items.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  // Undated items (ts '') sort last within their day bucket key ''.
  const byDay = new Map();
  for (const item of items) {
    const key = item.ts ? dayKey(item.ts) : 'undated';
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(item);
  }

  const filterBtn = (kind, label) => `<button class="btn ${timelineFilter.has(kind) ? 'on' : ''}" data-tl="${kind}">${label}</button>`;
  const daysHtml = [...byDay.entries()].map(([key, dayItems]) => `
    <div class="tl-day"><span class="d">${esc(fmtDay(dayItems[0].ts))}</span><span class="rule"></span><span class="small muted">${dayItems.length} events</span></div>
    ${dayItems.map((item) => `
      <div class="tl-item kind-${esc(item.kind)}" data-nav="${esc(item.nav)}">
        <span class="dot"></span>
        <span class="when">${esc(fmtTs(item.ts))}</span>
        <span class="what">${item.chip} ${esc(item.text)}${statusChip(item.status || '')}</span>
      </div>`).join('')}`).join('');

  return `
  <div style="max-width:1050px">
    <h1>Timeline</h1>
    <div class="muted">Every work cycle, commit, and memory note in one chronology (local time).</div>
    <div class="row" style="margin:12px 0">
      ${filterBtn('cycle', 'Work cycles')}${filterBtn('commit', 'Commits')}${filterBtn('memory', 'Memories')}
    </div>
    ${daysHtml || '<div class="empty">No events match the current filter.</div>'}
  </div>`;
}

/* ------------------------------- cycles ------------------------------- */

function cycleFieldsGroup(cycle, patterns) {
  return cycle.fields.filter((f) => patterns.some((p) => p.test(f.key)));
}

function fieldHtml(fields) {
  return fields.map((f) => `<div class="field"><div class="k">${esc(f.key)}</div><div class="v">${inlineMd(f.value)}</div></div>`).join('');
}

function linkShas(text) {
  return text.replace(/\b([0-9a-f]{7,40})\b/g, (m) => {
    const known = DATA.commits.some((c) => c.sha.startsWith(m));
    return known ? `<a class="mono" href="#/commits/${esc(m)}">${esc(m)}</a>` : m;
  });
}

function cycleCard(cycle, open) {
  const objective = (cycle.fields.find((f) => f.key === 'objective') || {}).value || '';
  const groups = [
    ['What happened', cycleFieldsGroup(cycle, [/^objective$/, /^input$/, /^output$/, /^task$/, /^scope$/, /^method$/, /^change$/, /^merged$/, /^event$/, /^triage$/])],
    ['Findings & gotchas', cycleFieldsGroup(cycle, [/finding/i, /gotcha/i, /^note/i, /^issue/i, /^side-/i, /root cause/i])],
    ['Verification', cycleFieldsGroup(cycle, [/verification/i, /^verified/i, /^gates?$/, /^smoke/, /^test/i, /post-reboot/i, /suite/i, /live/i])],
    ['Blockers & status', cycleFieldsGroup(cycle, [/^blockers?$/i, /^status$/i, /^cleanup$/i])],
    ['Provenance & compat', cycleFieldsGroup(cycle, [/^provenance$/i, /^compat$/i, /parent/i])],
  ].filter(([, fields]) => fields.length);

  const shown = new Set(groups.flatMap(([, fields]) => fields.map((f) => f.key)));
  const rest = cycle.fields.filter((f) => !shown.has(f.key));

  return `
  <div class="card ${open ? 'open' : ''}" id="cycle-${esc(cycle.id)}" data-card>
    <div class="card-head" data-toggle>
      <span class="ts">${esc(fmtTs(cycle.ts))}</span>
      ${eventChip(cycle)}${statusChip(cycle.status)}
      <span class="obj">${esc(objective || cycle.event)}</span>
      <span class="small muted mono">${esc(cycle.ledger)}</span>
    </div>
    <div class="card-body">
      ${cycle.branch || cycle.worktree ? `<div class="small muted mono" style="margin-bottom:8px">${cycle.branch ? `branch: ${esc(cycle.branch)}` : ''}${cycle.branch && cycle.worktree ? ' · ' : ''}${cycle.worktree ? `wt: ${esc(cycle.worktree)}` : ''}</div>` : ''}
      ${groups.map(([title, fields]) => `<h3>${title}</h3><div class="field-grid">${fieldHtml(fields)}</div>`).join('')}
      ${rest.length ? `<details style="margin-top:10px"><summary class="muted">All other fields (${rest.length})</summary><div class="field-grid">${fieldHtml(rest)}</div></details>` : ''}
      ${cycle.notes.length ? `<h3>Notes</h3>${cycle.notes.map((n) => `<div class="small muted">${linkShas(inlineMd(n))}</div>`).join('')}` : ''}
      <div class="small muted" style="margin-top:10px">source: <span class="mono">.agents/comms/${esc(cycle.ledger)}</span></div>
    </div>
  </div>`;
}

function viewCycles(query) {
  const events = [...new Set(DATA.cycles.map((c) => c.kind || (c.event || '').toLowerCase()))].filter(Boolean).sort();
  const statuses = [...new Set(DATA.cycles.map((c) => c.status).filter(Boolean))].sort();
  return `
  <div style="max-width:1100px">
    <h1>Work cycles</h1>
    <div class="muted">Every entry from the daily COMMS ledgers — objectives, findings, gotchas, verification, compat.</div>
    <div class="row" style="margin:12px 0">
      <input id="cyc-q" class="btn" style="min-width:240px;text-align:left" placeholder="Filter text…">
      <select id="cyc-event" class="btn"><option value="">All events</option>${events.map((e) => `<option>${esc(e)}</option>`).join('')}</select>
      <select id="cyc-status" class="btn"><option value="">All statuses</option>${statuses.map((s) => `<option>${esc(s)}</option>`).join('')}</select>
      <button class="btn" id="cyc-expand">Expand all</button>
      <button class="btn" id="cyc-collapse">Collapse all</button>
    </div>
    <div id="cyc-list">${DATA.cycles.map((c) => cycleCard(c, query.get('open') === c.id)).join('')}</div>
    <div class="empty" id="cyc-empty" hidden>No cycles match the filter.</div>
  </div>`;
}

function applyCycleFilter() {
  const q = ($('#cyc-q').value || '').toLowerCase();
  const ev = $('#cyc-event').value;
  const st = $('#cyc-status').value;
  let visible = 0;
  for (const card of $('#cyc-list').children) {
    const text = card.textContent.toLowerCase();
    const ok = (!q || text.includes(q))
      && (!ev || text.includes(ev.toLowerCase()))
      && (!st || text.includes(st.toLowerCase()));
    card.hidden = !ok;
    if (ok) visible += 1;
  }
  $('#cyc-empty').hidden = visible > 0;
}

/* ------------------------------- commits ------------------------------ */

function diffHtml(diff) {
  return `<div class="diff">${diff.split('\n').map((line) => {
    let cls = '';
    if (/^@@/.test(line)) cls = 'hunk';
    else if (/^\+\+\+|^---|^diff --git|^index |^new file|^deleted file|^rename /.test(line)) cls = 'meta';
    else if (line.startsWith('+')) cls = 'add';
    else if (line.startsWith('-')) cls = 'del';
    return `<span class="${cls}">${esc(line)}</span>`;
  }).join('')}</div>`;
}

function commitCard(c) {
  const add = c.files.reduce((s, f) => s + (f.add || 0), 0);
  const del = c.files.reduce((s, f) => s + (f.del || 0), 0);
  return `
  <div class="card" id="commit-${esc(c.sha)}" data-card>
    <div class="card-head" data-toggle>
      <span class="ts">${esc(fmtTs(c.date))}</span>
      <span class="mono">${esc(c.short)}</span>
      <span class="obj">${esc(c.subject)}</span>
      <span class="cmp-stats"><span class="cmp-add">+${add}</span> <span class="cmp-del">-${del}</span> · ${c.files.length} files</span>
    </div>
    <div class="card-body">
      ${c.body ? `<div style="margin-bottom:8px">${mdToHtml(c.body)}</div>` : ''}
      <div class="scroll-x"><table style="width:auto"><thead><tr><th>file</th><th>+</th><th>−</th></tr></thead><tbody>
        ${c.files.map((f) => `<tr><td class="mono small">${esc(f.path)}</td><td class="cmp-add mono">${f.add ?? '–'}</td><td class="cmp-del mono">${f.del ?? '–'}</td></tr>`).join('')}
      </tbody></table></div>
      <h3>Diff</h3>
      ${c.diff ? diffHtml(c.diff) : `<div class="empty small">Diff not bundled — this commit predates ${esc(DATA.diffSince)}. Regenerate with <code>--since</code> to include it.</div>`}
    </div>
  </div>`;
}

function viewCommits(segments) {
  const wanted = segments[1] || '';
  return `
  <div style="max-width:1100px">
    <h1>Commits</h1>
    <div class="muted">${DATA.stats.commits} commits · diffs bundled for the window since ${esc(DATA.diffSince)}</div>
    <div class="row" style="margin:12px 0">
      <input id="cmp-q" class="btn" style="min-width:260px;text-align:left" placeholder="Filter by subject, file, or sha…">
      <button class="btn" id="cmp-diffs">With bundled diffs only</button>
      <button class="btn" id="cmp-expand">Expand all</button>
      <button class="btn" id="cmp-collapse">Collapse all</button>
    </div>
    <div id="cmp-list">${DATA.commits.map((c) => commitCard(c)).join('')}</div>
    <div class="empty" id="cmp-empty" hidden>No commits match the filter.</div>
  </div>`;
}

function applyCommitFilter() {
  const q = ($('#cmp-q').value || '').toLowerCase();
  const diffsOnly = $('#cmp-diffs').classList.contains('on');
  let visible = 0;
  for (const card of $('#cmp-list').children) {
    const c = DATA.commits.find((x) => `commit-${x.sha}` === card.id);
    const hay = `${c.subject} ${c.body} ${c.files.map((f) => f.path).join(' ')} ${c.sha}`.toLowerCase();
    const ok = (!q || hay.includes(q)) && (!diffsOnly || !!c.diff);
    card.hidden = !ok;
    if (ok) visible += 1;
  }
  $('#cmp-empty').hidden = visible > 0;
}

function openAndScroll(id) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.dataset.card !== undefined) el.classList.add('open');
  el.scrollIntoView({ block: 'center' });
}

/* ------------------------------- records ------------------------------ */

function viewRecords(segments, query) {
  const kind = segments[1] || 'task';
  const plural = { task: 'tasks', memory: 'memories', suggestion: 'suggestions', research: 'research' };
  const items = DATA[plural[kind] || 'tasks'];
  const wanted = query.get('file');
  const current = items.find((it) => it.name === wanted) || items[0];

  const tabs = [['task', 'Tasks'], ['memory', 'Memories'], ['suggestion', 'Suggestions'], ['research', 'Research']]
    .map(([k, label]) => `<a class="btn ${k === kind ? 'on' : ''}" href="#/records/${k}">${label}</a>`).join('');

  const list = items.map((it) => `
    <div class="item ${current && it.name === current.name ? 'active' : ''}" data-nav="#/records/${esc(kind)}?file=${encodeURIComponent(it.name)}">
      <span>${esc(it.title)}</span><span class="m">${esc(it.date)}</span>
    </div>`).join('');

  let detail = '<div class="empty">Nothing here.</div>';
  if (current) {
    const isJson = current.name.endsWith('.json');
    detail = `
      <div class="doc prose-width">
        <h1>${esc(current.title)}</h1>
        <div class="muted small mono">${esc(current.file)}</div>
        ${isJson ? `<pre><code>${esc(prettyJson(current.text))}</code></pre>` : mdToHtml(current.text)}
      </div>`;
  }

  return `
  <div>
    <h1>Records</h1>
    <div class="row" style="margin:10px 0 14px">${tabs}</div>
    <div class="split">
      <div class="list">${list}</div>
      <div>${detail}</div>
    </div>
  </div>`;
}

function prettyJson(text) {
  try {
    const parsed = JSON.parse(text);
    const out = JSON.stringify(parsed, null, 2);
    return out.length > 200_000 ? `${out.slice(0, 200_000)}\n… [truncated]` : out;
  } catch {
    return text;
  }
}

/* -------------------------------- docs -------------------------------- */

function viewDocs(query) {
  const wanted = query.get('path');
  const current = DATA.docs.find((d) => d.path === wanted) || DATA.docs[0];

  const groups = new Map();
  for (const d of DATA.docs) {
    if (!groups.has(d.group)) groups.set(d.group, []);
    groups.get(d.group).push(d);
  }
  const list = [...groups.entries()].map(([group, docs]) => `
    <div class="nav-group">${esc(group)}</div>
    ${docs.map((d) => `<div class="item ${current && d.path === current.path ? 'active' : ''}" data-nav="#/docs?path=${encodeURIComponent(d.path)}">${esc(d.title)}</div>`).join('')}`).join('');

  const toc = [];
  current.text.replace(/^(#{2,3})\s+(.+)$/gm, (m, hashes, title) => {
    const id = title.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
    toc.push(`<a href="#${esc(id)}" data-anchor="${esc(id)}" style="padding-left:${hashes.length === 2 ? 10 : 22}px">${esc(title)}</a>`);
    return m;
  });

  return `
  <div>
    <h1>Docs</h1>
    <div class="split" style="grid-template-columns:280px 1fr 190px">
      <div class="list">${list}</div>
      <div class="doc" id="doc-body">${mdToHtml(current.text)}</div>
      <div class="toc"><div class="nav-group">On this page</div>${toc.join('')}</div>
    </div>
  </div>`;
}

/* ------------------------------- search ------------------------------- */

let SEARCH_INDEX = null;

function buildSearchIndex() {
  const idx = [];
  for (const c of DATA.cycles) {
    idx.push({ kind: 'cycle', title: `${c.event} — ${(c.fields.find((f) => f.key === 'objective') || {}).value || ''}`.trim(), text: c.fields.map((f) => `${f.key}: ${f.value}`).join('\n'), nav: `#/cycles?open=${encodeURIComponent(c.id)}`, meta: fmtTs(c.ts) });
  }
  for (const c of DATA.commits) {
    idx.push({ kind: 'commit', title: `${c.short} ${c.subject}`, text: `${c.body}\n${c.files.map((f) => f.path).join('\n')}`, nav: `#/commits/${esc(c.sha)}`, meta: fmtTs(c.date) });
  }
  for (const rec of [...DATA.tasks, ...DATA.memories, ...DATA.suggestions, ...DATA.research]) {
    idx.push({ kind: rec.kind, title: rec.title, text: rec.text, nav: `#/records/${rec.kind}?file=${encodeURIComponent(rec.name)}`, meta: rec.date });
  }
  for (const d of DATA.docs) {
    idx.push({ kind: 'doc', title: d.path, text: d.text, nav: `#/docs?path=${encodeURIComponent(d.path)}`, meta: d.group });
  }
  SEARCH_INDEX = idx;
}

function viewSearch(query) {
  const q = (query.get('q') || '').trim();
  if (!q) return '<h1>Search</h1><div class="empty">Type a query in the box above and press Enter.</div>';
  const needle = q.toLowerCase();
  const hits = SEARCH_INDEX.map((entry) => {
    const inTitle = entry.title.toLowerCase().includes(needle);
    const pos = entry.text.toLowerCase().indexOf(needle);
    return { entry, inTitle, pos, score: (inTitle ? 2 : 0) + (pos > -1 ? 1 : 0) };
  }).filter((h) => h.score > 0).sort((a, b) => b.score - a.score);

  const shown = hits.slice(0, 60);
  const results = shown.map(({ entry, pos }) => {
    let ctx = '';
    if (pos > -1) {
      const start = Math.max(0, pos - 70);
      const slice = entry.text.slice(start, pos + q.length + 90).replace(/\s+/g, ' ');
      ctx = `${start > 0 ? '…' : ''}${esc(slice).replace(new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`)}…`;
    }
    return `<div class="result" data-nav="${esc(entry.nav)}">
      <div class="row"><span class="chip">${esc(entry.kind)}</span><b>${esc(entry.title)}</b><span class="spacer"></span><span class="small muted">${esc(entry.meta)}</span></div>
      <div class="ctx">${ctx}</div>
    </div>`;
  }).join('');

  return `<h1>Search: “${esc(q)}”</h1>
    <div class="muted">${hits.length} matches${hits.length > shown.length ? ` — showing first ${shown.length}` : ''}</div>
    ${results || '<div class="empty">No matches.</div>'}`;
}

/* ------------------------------- shell -------------------------------- */

const NAV = [
  ['Overview', '#/overview', 'overview', () => ''],
  ['Timeline', '#/timeline', 'timeline', () => ''],
  ['Work cycles', '#/cycles', 'cycles', () => DATA.stats.cycles],
  ['Commits', '#/commits', 'commits', () => DATA.stats.commits],
  { group: 'Records' },
  ['Tasks', '#/records/task', 'task', () => DATA.stats.tasks],
  ['Memories', '#/records/memory', 'memory', () => DATA.stats.memories],
  ['Suggestions', '#/records/suggestion', 'suggestion', () => DATA.stats.suggestions],
  ['Research', '#/records/research', 'research', () => DATA.stats.research],
  { group: 'Library' },
  ['Docs', '#/docs', 'docs', () => DATA.stats.docs],
  ['Search', '#/search', 'search', () => ''],
];

function renderNav(active) {
  $('#nav').innerHTML = NAV.map((item) => {
    if (item.group) return `<div class="nav-group">${esc(item.group)}</div>`;
    const [label, href, key, count] = item;
    const n = count();
    return `<a class="nav-item ${active === key ? 'active' : ''}" href="${href}">${esc(label)}${n ? `<span class="count">${n}</span>` : ''}</a>`;
  }).join('');
}

function render() {
  const { segments, query } = parseHash();
  const view = segments[0] || 'overview';
  const root = $('#view');

  renderNav(view === 'records' ? (segments[1] || 'task') : view);

  if (view === 'timeline') root.innerHTML = viewTimeline();
  else if (view === 'cycles') root.innerHTML = viewCycles(query);
  else if (view === 'commits') root.innerHTML = viewCommits(segments);
  else if (view === 'records') root.innerHTML = viewRecords(segments, query);
  else if (view === 'docs') root.innerHTML = viewDocs(query);
  else if (view === 'search') root.innerHTML = viewSearch(query);
  else root.innerHTML = viewOverview();

  if (view === 'cycles') {
    $('#cyc-q').addEventListener('input', applyCycleFilter);
    $('#cyc-event').addEventListener('change', applyCycleFilter);
    $('#cyc-status').addEventListener('change', applyCycleFilter);
    $('#cyc-expand').addEventListener('click', () => $('#cyc-list').querySelectorAll('.card').forEach((c) => c.classList.add('open')));
    $('#cyc-collapse').addEventListener('click', () => $('#cyc-list').querySelectorAll('.card').forEach((c) => c.classList.remove('open')));
    applyCycleFilter();
    const open = query.get('open');
    if (open) openAndScroll(`cycle-${open}`);
  }
  if (view === 'commits') {
    $('#cmp-q').addEventListener('input', applyCommitFilter);
    $('#cmp-diffs').addEventListener('click', (e) => { e.currentTarget.classList.toggle('on'); applyCommitFilter(); });
    $('#cmp-expand').addEventListener('click', () => $('#cmp-list').querySelectorAll('.card').forEach((c) => c.classList.add('open')));
    $('#cmp-collapse').addEventListener('click', () => $('#cmp-list').querySelectorAll('.card').forEach((c) => c.classList.remove('open')));
    applyCommitFilter();
    if (segments[1]) openAndScroll(`commit-${segments[1]}`);
  }
  if (view === 'docs') {
    root.querySelectorAll('.toc a[data-anchor]').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const el = document.getElementById(a.dataset.anchor);
        if (el) el.scrollIntoView({ block: 'start' });
      });
    });
    const docBody = $('#doc-body');
    if (docBody && !query.get('path')) {
      const first = DATA.docs[0];
      history.replaceState(null, '', `#/docs?path=${encodeURIComponent(first.path)}`);
    }
  }
  if (view === 'search') {
    $('#search-input').value = query.get('q') || '';
  }
  root.scrollTop = 0;
}

function bindShell() {
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#search-input').value.trim();
    navTo(`#/search?q=${encodeURIComponent(q)}`);
  });
  document.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      toggle.closest('[data-card]').classList.toggle('open');
      return;
    }
    const tl = e.target.closest('[data-tl]');
    if (tl) {
      const kind = tl.dataset.tl;
      if (timelineFilter.has(kind)) timelineFilter.delete(kind);
      else timelineFilter.add(kind);
      render();
      return;
    }
    const nav = e.target.closest('[data-nav]');
    if (nav) navTo(nav.dataset.nav);
  });
  window.addEventListener('hashchange', render);
}

async function main() {
  DATA = await (await fetch('data.json')).json();
  buildSearchIndex();
  $('#gen-stamp').innerHTML = `generated<br>${esc(new Date(DATA.generatedAt).toLocaleString())}`;
  $('#head-meta').innerHTML = `<code>${esc(DATA.head.short)}</code> ${esc(DATA.head.subject)}`;
  bindShell();
  if (!location.hash) location.hash = '#/overview';
  render();
}

main().catch((err) => {
  $('#view').innerHTML = `<div class="empty">Failed to load data.json: ${esc(err.message)}</div>`;
});
