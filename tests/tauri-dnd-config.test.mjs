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
 * Source of truth: since da07db2 the main window is built in Rust
 * (src-tauri/src/window.rs, build_main_window), where the equivalent of
 * `"dragDropEnabled": false` is the builder call `.disable_drag_drop_handler()`.
 * This test reads that call off the builder chain and additionally keeps any
 * future `app.windows` entry in tauri.conf.json from re-enabling the handler.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (...parts) => readFileSync(join(repoRoot, ...parts), 'utf8');

test('build_main_window disables the native drag-drop handler before .build()', () => {
  const src = read('src-tauri', 'src', 'window.rs');
  const fnStart = src.indexOf('pub fn build_main_window');
  assert.notEqual(fnStart, -1, 'expected pub fn build_main_window in src-tauri/src/window.rs');

  const fnEnd = src.indexOf('\n}\n', fnStart);
  const body = src.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
  const buildIdx = body.indexOf('.build()');
  assert.notEqual(buildIdx, -1, 'expected the builder chain in build_main_window to end in .build()');

  const chain = body.slice(0, buildIdx);
  assert.ok(chain.includes('.disable_drag_drop_handler()'),
    'build_main_window must call .disable_drag_drop_handler() before .build(), '
    + 'or DOM drag reorder breaks in the app webview (Tauri v2 default installs the native file-drop handler)');
});

test('the app setup actually builds the main window through window.rs', () => {
  const lib = read('src-tauri', 'src', 'lib.rs');
  assert.ok(/window::build_main_window\(/.test(lib),
    'src-tauri/src/lib.rs must call window::build_main_window — otherwise the guarded builder is dead code');
});

test('tauri.conf.json never declares a window with the drag-drop handler enabled', () => {
  const config = JSON.parse(read('src-tauri', 'tauri.conf.json'));
  const windows = config?.app?.windows;
  if (windows === undefined) return; // windows are built in Rust (window.rs)
  assert.ok(Array.isArray(windows) && windows.length > 0, 'app.windows, when present, must be a non-empty array');
  for (const win of windows) {
    assert.equal(win.dragDropEnabled, false,
      `window "${win.label}" must set "dragDropEnabled": false or DOM drag reorder breaks in the app webview`);
  }
});
