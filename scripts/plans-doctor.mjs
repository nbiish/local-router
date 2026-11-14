#!/usr/bin/env node
/**
 * plans-doctor — the enforcement arm of `.agents/plans/llms.txt`.
 *
 * The plans contract is a set of claims the fleet relies on: frontmatter parses,
 * status is one of five values, every plan has a task record that exists, §5
 * boxes are the only in-place edit and carry three marks (`[ ]` open, `[~]`
 * partial, `[x]` done), sections appear in template order, and the artifacts the
 * contract cites ("Reference integrity") exist in this checkout.
 *
 * None of that was ever checked by code, so a dangling `task_record:` or a
 * reordered section stayed invisible until an agent acted on it. This script is
 * deterministic verification — no model, no network, no key material.
 *
 *   node scripts/plans-doctor          # human-readable
 *   node scripts/plans-doctor --json   # machine receipt
 *
 * Exit codes: 0 clean · 1 drift found · 2 usage error.
 *
 * Design notes:
 *  - Readers are line-based on purpose (the contract says so): parsers here
 *    must never require a YAML library, or they stop describing what
 *    ainish-rag / bin/context-packet.sh actually read.
 *  - Both plan naming schemes are live. Nothing filters on a filename suffix.
 *  - Findings are grouped by severity so a CI log shows the fixable class first.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const PLANS_DIR = '.agents/plans';
const TEMPLATE_PATH = '.agents/templates/plan.md';

/** Artifacts the contract cites as live. Missing one is a contract lie. */
const REQUIRED_ARTIFACTS = [
  { file: 'bin/context-packet.sh', why: 'session bootstrap reads status + unchecked §5 boxes' },
  { file: '.agents/templates/worktree-merge.md', why: 'the merge journal format AGENTS.md mandates' },
  { file: 'scripts/commit-identity-guard.sh', why: 'post-commit identity enforcement (AGENTS.md rule 4)' }
];

const KNOWN_STATUSES = ['designing', 'ready', 'implementing', 'done', 'abandoned'];

/**
 * Grandfathered plans that predate the frontmatter contract.
 *
 * The contract rule is "never rename or reuse a plan filename" — task records,
 * COMMS lines, and commits all point at these paths, so back-filling frontmatter
 * would mean rewriting a closed historical record to satisfy a rule written
 * after it. They are listed explicitly (never wildcarded) so a NEW plan with
 * missing frontmatter still fails: an exception you can enumerate is a fact, a
 * blanket skip is a hole.
 */
const GRANDFATHERED_WITHOUT_FRONTMATTER = new Map([
  ['2026-11-12-pi-hermes-ollama-default.plan.md',
    'authored 2026-11-12 as a plain record before the frontmatter rule; closed and referenced by task record'],
  ['2026-11-12-trajectory-traces.plan.md',
    'authored 2026-11-12 as an analysis-first record; closed and referenced by task record']
]);

const USAGE = `Usage: node scripts/plans-doctor [--json] [--root <dir>] [--help]

  --json          Emit a machine-readable receipt instead of prose
  --root <dir>    Checkout to inspect (default: current directory)
  --help          Show this help

Exit codes: 0 clean · 1 drift found · 2 usage error`;

function parseArgs(argv) {
  const options = { json: false, root: process.cwd(), help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--root') {
      const value = argv[i + 1];
      if (!value) throw new Error('--root requires a directory');
      options.root = path.resolve(value);
      i += 1;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

/** Frontmatter is the leading `---` fenced block. Returns {} when absent. */
function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { fields: {}, closed: false };
  const fields = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '---') return { fields, closed: true };
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (match) fields[match[1]] = match[2].trim();
  }
  return { fields, closed: false };
}

/** Section headings in document order: [{ level, number, title, line }]. */
function parseSections(text) {
  const sections = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const numbered = /^##\s+(\d+)\.\s*(.*)$/.exec(line);
    if (numbered) {
      sections.push({ level: 2, number: Number(numbered[1]), title: numbered[2].trim(), line: index + 1 });
    } else if (/^##\s+/.test(line)) {
      sections.push({ level: 2, number: null, title: line.replace(/^##\s+/, '').trim(), line: index + 1 });
    }
  });
  return sections;
}

/**
 * §5 todo boxes. The contract defines exactly three marks; anything else
 * (`[-]`, `[ ]` with trailing junk) is a mark no reader understands.
 */
function parseTodos(text) {
  const todos = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const match = /^-\s+\[(.?)\]\s*(.*)$/.exec(line);
    if (!match) return;
    const mark = match[1];
    const body = match[2];
    // A PARTIAL note belongs to the todo, appended after its (possibly
    // multi-line) body — so scan forward through continuation lines until the
    // next todo or blank-then-new-block, and take the first PARTIAL found.
    let partialNote = null;
    for (let i = index + 1; i < lines.length; i += 1) {
      const next = lines[i];
      if (/^-\s+\[/.test(next)) break;
      const note = /—\s*PARTIAL:\s*(.+)$/.exec(next.trim()) || /^\s*PARTIAL:\s*(.+)$/.exec(next);
      if (note) {
        partialNote = note[1].trim();
        break;
      }
    }
    todos.push({
      line: index + 1,
      mark,
      id: (/^\*\*([^*]+)\*\*/.exec(body) || [])[1] || '',
      text: body,
      partialNote
    });
  });
  return todos;
}

function templateOrder(templateText) {
  return parseSections(templateText)
    .filter((section) => section.number != null)
    .map((section) => section.number);
}

function checkPlan(root, planPath, templateNumbers) {
  const findings = [];
  const rel = path.relative(root, planPath);
  const add = (severity, code, message) => findings.push({ severity, code, file: rel, message });

  let text;
  try {
    text = fs.readFileSync(planPath, 'utf8');
  } catch (error) {
    add('error', 'unreadable', `cannot read: ${error.message}`);
    return findings;
  }

  const { fields, closed } = parseFrontmatter(text);
  if (!closed) {
    const reason = GRANDFATHERED_WITHOUT_FRONTMATTER.get(path.basename(planPath));
    if (reason) {
      findings.push({
        severity: 'info',
        code: 'frontmatter-grandfathered',
        file: rel,
        message: `no frontmatter, grandfathered: ${reason}`
      });
    } else {
      add('error', 'frontmatter-unclosed', 'frontmatter block is missing or never closed with `---`');
    }
    return findings;
  }

  // --- frontmatter contract ------------------------------------------------
  const status = fields.status;
  if (status == null) {
    add('error', 'status-missing', 'frontmatter has no `status` key');
  } else if (!KNOWN_STATUSES.includes(status)) {
    add('error', 'status-unknown',
      `status "${status}" is not one of ${KNOWN_STATUSES.join('|')} — readers treat it as designing`);
  }

  // `task_record` must point at a file that exists. This is the pointer every
  // other artifact (COMMS lines, commits) uses to find the coordination record.
  const taskRecord = fields.task_record;
  if (!taskRecord) {
    add('warn', 'task-record-missing-key',
      'frontmatter has no `task_record` — nothing links this plan to a coordination record');
  } else {
    const resolved = path.resolve(root, taskRecord);
    if (!fs.existsSync(resolved)) {
      add('error', 'task-record-dangling', `task_record does not exist: ${taskRecord}`);
      const base = path.basename(taskRecord);
      const guess = ['TASK.' + base, base.replace(/^TASK\./, '')]
        .map((name) => path.join(path.dirname(taskRecord), name))
        .find((candidate) => fs.existsSync(path.resolve(root, candidate)));
      if (guess) add('hint', 'task-record-guess', `did you mean: ${guess}`);
    }
  }

  if (fields.plan_format && fields.plan_format !== 'ainish/plan/v1') {
    add('warn', 'plan-format-unknown', `plan_format "${fields.plan_format}" is not ainish/plan/v1`);
  }

  // --- section order -------------------------------------------------------
  // The contract: sections appear in template order, and an appendix (§8)
  // belongs at the END. A section out of order is a record no reader trusts.
  const sections = parseSections(text);
  const numbered = sections.filter((section) => section.number != null);
  const order = numbered.map((section) => section.number);
  const expected = [...templateNumbers];
  if (order.length > 0) {
    const inOrder = order.every((number, index) => (
      index === 0 ? true : number > order[index - 1]
    ));
    if (!inOrder) {
      add('error', 'section-order', `sections are out of order: ${order.join(', ')} (template: ${expected.join(', ')})`);
    }
    const extras = order.filter((number) => !expected.includes(number));
    if (extras.length > 0) {
      // An extra section is legitimate ONLY as an appendix after the last
      // template section — that is exactly what the contract permits for §8
      // implementation notes. Anything else is an edit in the wrong place.
      const lastTemplate = expected[expected.length - 1];
      const misplaced = numbered.filter((section) => extras.includes(section.number) && section.number < lastTemplate);
      if (misplaced.length > 0) {
        add('error', 'appendix-misplaced',
          `appendix section(s) ${misplaced.map((s) => s.number).join(', ')} appear before §${lastTemplate}`);
      }
    }
    const missing = expected.filter((number) => !order.includes(number));
    if (missing.length > 0 && status !== 'designing') {
      add('warn', 'section-missing', `missing section(s) ${missing.join(', ')} for status "${status}"`);
    }
  }

  // --- §5 todo marks -------------------------------------------------------
  const todos = parseTodos(text);
  const badMarks = todos.filter((todo) => ![' ', 'x', 'X', '~'].includes(todo.mark));
  for (const todo of badMarks) {
    add('warn', 'todo-mark-unknown',
      `L${todo.line}: box mark "[${todo.mark}]" is not one of [ ] / [~] / [x]`);
  }
  for (const todo of todos.filter((entry) => entry.mark === '~')) {
    if (!todo.partialNote) {
      add('warn', 'partial-without-note',
        `L${todo.line}: [~] is missing the "— PARTIAL: <what remains>" note the contract requires`);
    }
  }

  // --- done-with-open-todos (the T7 rule) ----------------------------------
  // `status: done` may carry an open `[ ]` ONLY when the todo is an operator
  // action and says so. Anything else open keeps the plan off done.
  if (status === 'done') {
    const open = todos.filter((todo) => todo.mark === ' ');
    const unexplained = open.filter((todo) => !/operator action/i.test(todo.text));
    if (unexplained.length > 0) {
      add('error', 'done-with-open-todos',
        `status is done but ${unexplained.length} todo(s) are open and not labelled "operator action": `
        + unexplained.map((todo) => todo.id || `L${todo.line}`).join(', '));
    }
  }

  return findings;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`plans-doctor: ${error.message}`);
    console.error(USAGE);
    process.exit(2);
  }
  if (options.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const root = options.root;
  const findings = [];

  // --- reference integrity -------------------------------------------------
  for (const artifact of REQUIRED_ARTIFACTS) {
    const full = path.join(root, artifact.file);
    if (!fs.existsSync(full)) {
      findings.push({
        severity: 'error',
        code: 'artifact-missing',
        file: artifact.file,
        message: `cited by the plans contract but absent (${artifact.why})`
      });
    } else {
      // Executable artifacts must actually be executable, or the hook that
      // invokes them fails silently (a `[ -x ]` guard turning a control off).
      if (/\.(sh)$/.test(artifact.file)) {
        try {
          fs.accessSync(full, fs.constants.X_OK);
        } catch {
          findings.push({
            severity: 'warn',
            code: 'artifact-not-executable',
            file: artifact.file,
            message: 'exists but is not executable — hook guards will skip it silently'
          });
        }
      }
    }
  }

  const templatePath = path.join(root, TEMPLATE_PATH);
  if (!fs.existsSync(templatePath)) {
    findings.push({
      severity: 'error', code: 'template-missing', file: TEMPLATE_PATH,
      message: 'the section-order check needs the plan template'
    });
  }

  const plansDir = path.join(root, PLANS_DIR);
  let planFiles = [];
  if (!fs.existsSync(plansDir)) {
    findings.push({
      severity: 'error', code: 'plans-dir-missing', file: PLANS_DIR, message: 'no plans directory'
    });
  } else {
    // Both naming schemes are live; `llms.txt` is the index, not a plan.
    planFiles = fs.readdirSync(plansDir)
      .filter((name) => name.endsWith('.md') && name !== 'llms.txt')
      .sort()
      .map((name) => path.join(plansDir, name));
  }

  let templateNumbers = [1, 2, 3, 4, 5, 6, 7];
  if (fs.existsSync(templatePath)) {
    templateNumbers = templateOrder(fs.readFileSync(templatePath, 'utf8'));
    if (templateNumbers.length === 0) templateNumbers = [1, 2, 3, 4, 5, 6, 7];
  }

  for (const planFile of planFiles) {
    findings.push(...checkPlan(root, planFile, templateNumbers));
  }

  const errors = findings.filter((entry) => entry.severity === 'error');
  const warnings = findings.filter((entry) => entry.severity === 'warn');
  const hints = findings.filter((entry) => entry.severity === 'hint');
  const infos = findings.filter((entry) => entry.severity === 'info');
  const ok = errors.length === 0;

  if (options.json) {
    const receipt = {
      schema: 'local-router/plans-doctor/v1',
      generatedAt: new Date().toISOString(),
      root,
      plansChecked: planFiles.length,
      templateSections: templateNumbers,
      ok,
      counts: {
        error: errors.length,
        warn: warnings.length,
        hint: hints.length,
        info: infos.length
      },
      findings
    };
    console.log(JSON.stringify(receipt, null, 2));
  } else {
    console.log(`plans-doctor — ${planFiles.length} plan(s) in ${PLANS_DIR}`);
    console.log(`template sections: §${templateNumbers.join(' §')}`);
    console.log('');
    if (findings.length === 0) {
      console.log('clean: frontmatter, task records, section order, todo marks, and cited artifacts all check out.');
    } else {
      for (const entry of [...errors, ...warnings, ...hints, ...infos]) {
        const label = entry.severity.padEnd(6);
        console.log(`${label} ${entry.code}`);
        console.log(`       ${entry.file}: ${entry.message}`);
      }
    }
    console.log('');
    console.log(`${errors.length} error(s), ${warnings.length} warning(s), ${hints.length} hint(s), ${infos.length} grandfathered`);
  }

  // exitCode, not exit(): process.exit() truncates buffered stdout when it is a
  // pipe, which silently swallowed this script's entire report on first run.
  process.exitCode = ok ? 0 : 1;
}

main();
