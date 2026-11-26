import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REQUIRED_PLATFORMS,
  manifestProblems,
  verifyReleaseManifest
} from '../scripts/verify-updater-manifest.mjs';

const TAG = 'v1.2.1';
const BASE = 'https://github.com/nbiish/local-router/releases/download/v1.2.1/';

function asset(name) {
  return { name, browser_download_url: BASE + name };
}

function completeRelease() {
  const mac = asset('Local.Router_universal.app.tar.gz');
  const windows = asset('Local.Router_1.2.1_x64-setup.exe');
  const linux = asset('Local.Router_1.2.1_amd64.AppImage');
  const signed = ({ browser_download_url }) => ({ url: browser_download_url, signature: 'c2lnbmF0dXJl' });
  return {
    assets: [mac, windows, linux],
    manifest: {
      version: '1.2.1',
      platforms: {
        'darwin-aarch64': signed(mac),
        'darwin-x86_64': signed(mac),
        'windows-x86_64': signed(windows),
        'linux-x86_64': signed(linux)
      }
    }
  };
}

function withRelease(mutate) {
  const release = completeRelease();
  mutate(release);
  return verifyReleaseManifest(TAG, release);
}

test('a complete manifest covering every required platform is accepted', () => {
  assert.deepEqual(verifyReleaseManifest(TAG, completeRelease()), []);
});

test('a version that disagrees with the tag is refused', () => {
  const problems = withRelease((release) => {
    release.manifest.version = '1.2.0';
  });
  assert.deepEqual(problems, ['version is "1.2.0", but the tag is v1.2.1']);
});

test('each missing platform is named, so a lost matrix job cannot ship a partial manifest', () => {
  for (const target of REQUIRED_PLATFORMS) {
    const problems = withRelease((release) => {
      delete release.manifest.platforms[target];
    });
    assert.equal(problems.length, 1, `${target} should be the only problem`);
    assert.match(problems[0], new RegExp(`platform "${target}" is missing`));
  }
});

test('the macOS-only shape of the v1.2.0 manifest is refused', () => {
  const problems = withRelease((release) => {
    const mac = release.manifest.platforms['darwin-aarch64'];
    release.manifest.platforms = { 'darwin-aarch64': mac };
  });
  assert.equal(problems.length, 3);
  assert.ok(problems.some((problem) => problem.includes('"windows-x86_64" is missing')));
  assert.ok(problems.some((problem) => problem.includes('"linux-x86_64" is missing')));
});

test('a platform pointing at an asset that is not on this release is refused', () => {
  const problems = withRelease((release) => {
    release.manifest.platforms['windows-x86_64'].url =
      'https://github.com/nbiish/local-router/releases/download/v1.2.0/Local.Router_1.2.0_x64-setup.exe';
  });
  assert.deepEqual(problems, ['platform "windows-x86_64" does not point at an asset of this release']);
});

test('a platform without a signature is refused', () => {
  const problems = withRelease((release) => {
    release.manifest.platforms['linux-x86_64'].signature = '  ';
  });
  assert.deepEqual(problems, ['platform "linux-x86_64" has no signature']);
});

test('a manifest without a platforms object is refused', () => {
  assert.deepEqual(withRelease((release) => {
    release.manifest.platforms = [];
  }), ['"platforms" is missing or not an object']);
  assert.deepEqual(manifestProblems(null, { tag: TAG }), ['latest.json is not a JSON object']);
});
