import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { renderLayout } from '../build/ui/pages/layout.js';

const html = renderLayout('Test', '<p>body</p>', { defaultFallbackModelsText: '' });

test('main app exposes a check-for-updates control', () => {
  assert.match(html, /id="appUpdateStatus"/);
  assert.match(html, /function checkForAppUpdates/);
  assert.match(html, /function hydrateAppUpdateStatus/);
  assert.match(html, /hydrateAppUpdateStatus\(\)/);
  assert.match(html, /Check for updates/);
});

test('main app never exposes the git-pull apply endpoint', () => {
  assert.equal(html.includes('/api/apply-update'), false);
  assert.equal(html.includes("invoke('install_update')") || html.includes('invoke("install_update")'), true);
});

test('tray and app are registered against the same signed updater commands', () => {
  const updater = readFileSync('src-tauri/src/updater.rs', 'utf8');
  const lib = readFileSync('src-tauri/src/lib.rs', 'utf8');
  const tray = readFileSync('src-tauri/src/tray.rs', 'utf8');
  assert.match(updater, /#\[tauri::command\]/);
  assert.match(updater, /pub async fn check_updates/);
  assert.match(updater, /pub fn update_status/);
  assert.match(updater, /pub fn install_update/);
  assert.match(lib, /updater::check_updates/);
  assert.match(lib, /updater::update_status/);
  assert.match(lib, /updater::install_update/);
  assert.match(tray, /"updates"/);
  assert.match(tray, /Check for Updates/);
});
