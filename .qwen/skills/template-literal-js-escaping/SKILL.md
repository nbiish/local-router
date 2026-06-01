---
name: template-literal-js-escaping
description: Debug silent JS failures from template literal backslash escaping when embedding JS strings in server-rendered HTML
source: auto-skill
extracted_at: '2026-05-30T01:22:57.937Z'
---

# Template Literal Escaping in Server-Rendered JavaScript

When a TypeScript server renders inline JavaScript inside a backtick template literal (`res.send(\`...\`)`), single-quote escape sequences behave counterintuitively — `\'` produces just `'`, not `\'`. This can silently break entire script blocks.

## The Symptom

- The page loads and HTML renders correctly
- But ALL JavaScript in the affected `<script>` block silently fails
- Async `fetch()` calls never complete — every section shows "Loading..."
- Inline `onclick` handlers do nothing
- Browser console is empty (no errors reach it because the script fails at parse time)
- Curling the page shows correct-looking JS that passes visual inspection

## Root Cause

In a JavaScript template literal (backtick-delimited), `\'` is an **unnecessary escape** — the backslash is consumed and the output is just `'`. To produce a literal backslash in the output, you need `\\`.

| Source (in template literal) | Rendered output | What you probably wanted |
|---|---|---|
| `\'` | `'` | `\'` (for escaped JS string quote) |
| `\\'` | `\'` | ✅ correct |
| `\\\'` | `\\'` | double backslash + quote |
| `"\\'"` | `"\'"` | double-quoted string with escaped quote |

**Concrete example of the bug:**

```typescript
// Source (inside backtick template literal):
', \'' + escapeHtml(m) + '\')">' +

// Rendered JavaScript (what the browser receives):
', '' + escapeHtml(m) + '')">' +
//   ^^ two adjacent string literals with no + operator → SyntaxError
```

The rendered `', ''` is parsed as: string `, ` ends at first `'`, then `'` starts a new empty string — but there's no `+` between them. **JavaScript forbids adjacent string literals without an operator.**

## Diagnosis

1. Curl the page and extract the `<script>` block
2. Pipe it through `node --check --input-type=module`:
   ```bash
   curl -s http://localhost:PORT/config \
     | sed -n '/<script>/,/<\/script>/p' \
     | sed '1s/<script>//; $s/<\/script>//' \
     | node --check --input-type=module
   ```
3. The error will pinpoint the exact line and column of the syntax error
4. Isolate the problematic line and test variants with `node --check <<'JS' ... JS`

## Fix

Replace `\'` with `\\'` in all template-literals that need to produce an escaped single quote in the generated JavaScript:

```typescript
// Before (broken):
', \'' + escapeHtml(m) + '\')">' +
', \'codingScore\', this.value)"></div>' +
'\'' + escapeHtml(id) + '\', \'up\')"'

// After (fixed):
', \\'' + escapeHtml(m) + '\\')">' +
', \\'codingScore\\', this.value)"></div>' +
'\\'' + escapeHtml(id) + '\\', \\'up\\')"'
```

## Auditing

Search the codebase for `\'` inside template literals used for HTML generation:

```bash
grep -n "\\\\'" src/index.ts | grep -v "^[0-9]*:.*//"
```

Every `\'` in a template-literal that should survive into the rendered JS output must become `\\'`. The only safe `\'` in a template literal is when you actually want a plain `'` character in the output (e.g., inside an HTML attribute value that doesn't need JS escaping).

## Why This Is Easy to Miss

- The TypeScript compiler (`tsc`) reports no errors — the template literal is syntactically valid
- The rendered HTML looks correct to the naked eye — `', '' +` vs `', \'' +` differ by one character
- The browser gives no feedback — the SyntaxError prevents script execution entirely, so no `console.error` runs
- It only manifests in the browser; server-side curl shows the API endpoints working fine
- Works in one environment but not another (e.g., main repo vs. worktree) if unrelated issues mask the problem

## Prevention

- Add a CI step that validates rendered JS: `node --check` on extracted `<script>` blocks from key pages
- Prefer `JSON.stringify()` over manual string escaping for embedding data values in generated JS
- Use a dedicated JS generation library instead of raw template literals for complex inline scripts
