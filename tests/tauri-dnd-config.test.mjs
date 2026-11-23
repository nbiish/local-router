/**
 * tests/tauri-dnd-config.test.mjs — regression guard for the desktop app's
 * HTML5 drag-and-drop reorder.
 *
 * The config UI's model reorder (fallback chain candidate list) is plain HTML5
 * DnD (draggable=true + ondragstart/over/drop/end in src/ui/pages/layout.ts).
 * Tauri v2 windows default to dragDropEnabled=true, which installs wry's native
 * drag-destination handler; it consumes every drag event as a FILE drop and
 * never delegates to WebKit's HTML5 DnD machinery (verified in wry-0.55.1
 * src/wkwebview/drag_drop.rs: when the handler returns true, the super —
 * WebKit's own drag handling — is never invoked; tauri-utils-2.9.3
 * src/config.rs:2301 confirms the default is true). The result: reordering
 * models works in the browser but not inside the app window.
 *
 * The fix is `"dragDropEnabled": false` in the window config; this test keeps it
 * from silently regressing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

test('tauri window config keeps dragDropEnabled false for HTML5 DnD', () => {
  const raw = readFileSync(join(repoRoot, 'src-tauri', 'tauri.conf.json'), 'utf8');
  const config = JSON.parse(raw);
  const windows = config?.app?.windows;
  assert.ok(Array.isArray(windows) && windows.length > 0, 'expected app.windows');
  for (const win of windows) {
    assert.equal(win.dragDropEnabled, false,
      `window "${win.label}" must set "dragDropEnabled": false or DOM drag reorder breaks in the app webview`);
  }
});
