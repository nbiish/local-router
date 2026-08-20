# TASK 2026-08-20 — /config inline script escape fix

## Read
- User: catalog stuck after cache clear.
- curl endpoints all healthy.
- Extracted page JS: SyntaxError.
- `.join('` + real newline, line 2130.

####

## Draft
- TS template literal interprets \n.
- source `.join('\n')` emits newline.
- JS string unterminates.
- whole 140KB script parse-dies.
- nothing initializes; loading forever.
- grep: exactly 2 occurrences.
- pre-existing in 3e74cfc, both hops.
- introduced by curation commit 073288e.

####

## Execute
- layout.ts 2684, 2736 → `\\n`.
- tsc clean.
- rebuild, serve :11436.

## Verify
- node --check all 3 blocks: OK.
- all 6 config pages main JS: OK.
- full test suite: PASS.

## Audit
- Two-char escape only, no logic change.
- No other unescaped backslashes.
- No secrets touched.
