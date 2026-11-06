#!/usr/bin/env node
/**
 * English-only and text-integrity gate.
 *
 * The repository contract (`AGENTS.md` -> "Write in English") requires every governed artifact to
 * be English. This check enforces the parts of that contract a machine can decide, and it also
 * catches the corruption class that motivated it: a tool rewriting backticks to backslashes and
 * then interpreting them as escape sequences, which silently replaced characters with control
 * bytes (`\a` ate the `a` in `ainish-rag`, leaving a BEL byte and the word `inish-rag`).
 *
 * Checks, in order of severity:
 *
 *   1. Raw control bytes. Outside the escapes a text file legitimately needs (tab, newline, and a
 *      byte-order mark), a control byte in tracked prose is damage, not content.
 *   2. Non-Latin writing systems in natural-language lines. Code spans, URLs, and paths are
 *      stripped first, so identifiers and quoted commands never trigger this.
 *   3. Mixed-script tokens. A token that mixes Latin with Cyrillic or Greek letterforms is a
 *      homoglyph typo: it reads as English but cannot be searched or diffed.
 *   4. CJK/fullwidth punctuation, which marks typography from another writing system.
 *
 * Deliberate exceptions are listed in ALLOW with a reason. An allowance covers one file path and
 * one script, so adding a new Anishinaabemowin quotation still has to be declared explicitly.
 *
 * Usage:
 *   node scripts/check-english-only.mjs           # check tracked files, exit 1 on findings
 *   node scripts/check-english-only.mjs --staged  # check only staged changes (pre-commit use)
 *   node scripts/check-english-only.mjs --json    # machine-readable report
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const stagedOnly = args.has('--staged');

/** Writing systems that indicate a non-English language. Greek is handled separately below. */
const SCRIPTS = [
  ['Han', /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{2FA1F}]/u],
  ['Kana', /[\u3040-\u30FF]/],
  ['Hangul', /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/],
  ['Cyrillic', /[\u0400-\u04FF\u0500-\u052F]/],
  ['Arabic', /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/],
  ['Hebrew', /[\u0590-\u05FF]/],
  ['Devanagari', /[\u0900-\u097F]/],
  ['Bengali', /[\u0980-\u09FF]/],
  ['Gurmukhi', /[\u0A00-\u0A7F]/],
  ['Gujarati', /[\u0A80-\u0AFF]/],
  ['Tamil', /[\u0B80-\u0BFF]/],
  ['Telugu', /[\u0C00-\u0C7F]/],
  ['Sinhala', /[\u0D80-\u0DFF]/],
  ['Thai', /[\u0E00-\u0E7F]/],
  ['Lao', /[\u0E80-\u0EFF]/],
  ['Tibetan', /[\u0F00-\u0FFF]/],
  ['Myanmar', /[\u1000-\u109F]/],
  ['Ethiopic', /[\u1200-\u137F]/],
  ['CanadianSyllabics', /[\u1400-\u167F]/],
  ['Khmer', /[\u1780-\u17FF]/],
  ['Mongolian', /[\u1800-\u18AF]/],
  ['Armenian', /[\u0530-\u058F]/],
  ['Georgian', /[\u10A0-\u10FF]/],
];

/** CJK/fullwidth punctuation and symbols. ASCII punctuation is required in English text. */
const FULLWIDTH = /[\u3000-\u303F\uFF01-\uFF60\uFFE0-\uFFE6]/;

/**
 * Declared exceptions to check 2/4. Each entry needs a reason a reviewer can check.
 * `scripts` is a list of script names from SCRIPTS that this file may contain.
 */
const ALLOW = [
  {
    path: 'critical.md',
    scripts: ['CanadianSyllabics'],
    reason:
      "The steward's name is written in Anishinaabemowin syllabics immediately followed by its " +
      'Latin transliteration, which is the "quoted operator input with an English gloss" case the ' +
      'contract permits. This is a legal identity, not decoration.',
  },
  {
    path: '.agents/skills/pqc-secrets/scripts/pqc_secrets.py',
    scripts: ['Han'],
    reason:
      'The docstring quotes the literal mojibake produced by decoding UTF-16-LE bytes as UTF-8, ' +
      'which is the defect the function exists to prevent. Quoting it exactly is the point. The ' +
      'characters are deliberately not repeated in this reason string so the guard does not flag ' +
      'itself.',
  },
];

/** Files that are not natural-language prose; script checks do not apply, integrity checks do. */
const BINARY = /\.(png|jpe?g|gif|webp|ico|icns|bmp|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|xz|7z|exe|dll|so|dylib|node|wasm|pdf|pkcs|der|pem|keystore|sqlite|db|class|jar|pyc|o|a|rlib|lock)$/i;

/** Tracked files that are known binary despite their extension. */
const BINARY_PATHS = new Set(['bin/pqc-secrets.linux-x64', 'bin/pqc-secrets.darwin-arm64']);

/**
 * Control bytes a text file may legitimately contain. CR is deliberately absent: lines are split
 * on CRLF/CR/LF below, so any CR still present inside a line is the lone-CR damage left by a
 * collapsed `\r` escape (a real `\r` line ending was already consumed by the split).
 */
const ALLOWED_CONTROL = new Set([0x09, 0x0a]);

function listFiles() {
  if (stagedOnly) {
    return execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
  }
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

function isBinary(rel, buf) {
  if (BINARY.test(rel) || BINARY_PATHS.has(rel)) return true;
  // A NUL byte in the first 8 KiB is the standard text/binary heuristic.
  return buf.subarray(0, 8192).includes(0);
}

/** Replace code spans, URLs, and paths so script checks only judge natural language. */
function stripNonProse(line) {
  return line
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\\\\wsl[^\s)]*/g, ' ')
    .replace(/\b[A-Za-z]:\\[^\s)]*/g, ' ');
}

function allowFor(rel) {
  return ALLOW.find((a) => a.path === rel);
}

/** True when `token` is a single Greek letter used as a math/crypto symbol (gamma, xi, sigma, …). */
function isMathGreekSymbol(token) {
  return token.length === 1 && /[\u0391-\u03C9]/.test(token);
}

const findings = [];
function report(kind, file, line, detail, snippet) {
  findings.push({ kind, file, line, detail, snippet: snippet.slice(0, 160) });
}

for (const rel of listFiles()) {
  let buf;
  try {
    buf = fs.readFileSync(rel);
  } catch {
    continue; // deleted in the working tree
  }
  if (isBinary(rel, buf)) continue;

  const text = buf.toString('utf8');
  const lines = text.split(/\r?\n/);
  const allow = allowFor(rel);
  const allowedScripts = new Set(allow?.scripts ?? []);
  let inFence = false;

  lines.forEach((line, index) => {
    const lineNo = index + 1;

    // 1. Control bytes.
    for (const ch of line) {
      const cp = ch.codePointAt(0);
      if (cp < 0x20 && !ALLOWED_CONTROL.has(cp)) {
        report('control-byte', rel, lineNo, `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`, line);
        break;
      }
      if (cp === 0x7f) {
        report('control-byte', rel, lineNo, 'U+007F DEL', line);
        break;
      }
    }

    // Track fenced code blocks; they are data, not prose.
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    const prose = stripNonProse(line);
    if (!prose.trim()) return;

    // 2. Non-Latin scripts.
    for (const [name, re] of SCRIPTS) {
      if (!re.test(prose)) continue;
      if (allowedScripts.has(name)) continue;
      report('non-latin-script', rel, lineNo, name, line);
      break;
    }

    // 3. Mixed-script tokens (Latin + Cyrillic/Greek letters inside one word).
    for (const token of prose.match(/[A-Za-z\u00C0-\u024F\u0400-\u04FF\u0370-\u03FF]+/g) ?? []) {
      const hasLatin = /[A-Za-z]/.test(token);
      const hasCyrillic = /[\u0400-\u04FF]/.test(token);
      const hasGreek = /[\u0370-\u03FF]/.test(token);
      if (hasLatin && (hasCyrillic || hasGreek)) {
        report('mixed-script-token', rel, lineNo, token, line);
        break;
      }
      // A lone Greek letter is math/crypto notation (γ=0.98, ξ, Σ); a Greek *word* is not.
      if (hasGreek && !hasLatin && !isMathGreekSymbol(token)) {
        report('non-latin-script', rel, lineNo, 'Greek word', line);
        break;
      }
    }

    // 4. Fullwidth/CJK punctuation.
    if (FULLWIDTH.test(prose)) {
      const bad = prose.match(FULLWIDTH)[0];
      report('fullwidth-punctuation', rel, lineNo, `U+${bad.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`, line);
    }
  });
}

if (asJson) {
  console.log(JSON.stringify({ findings, count: findings.length }, null, 2));
} else if (findings.length === 0) {
  console.log('check-english-only: OK — no non-English text or text-integrity damage detected.');
} else {
  const byKind = new Map();
  for (const f of findings) {
    if (!byKind.has(f.kind)) byKind.set(f.kind, []);
    byKind.get(f.kind).push(f);
  }
  for (const [kind, list] of byKind) {
    console.error(`\n${kind} (${list.length})`);
    for (const f of list) {
      console.error(`  ${f.file}:${f.line}  ${f.detail}`);
      console.error(`    ${f.snippet.trim()}`);
    }
  }
  console.error(`\ncheck-english-only: ${findings.length} finding(s). See AGENTS.md "Write in English".`);
}

process.exit(findings.length === 0 ? 0 : 1);
