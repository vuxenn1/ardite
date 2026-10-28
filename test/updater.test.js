import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRelease } from '../updater.js';

const sha = 'a'.repeat(64);
const release = {
  tag_name: 'v1.5.0',
  html_url: 'https://github.com/vuxenn1/ardite/releases/tag/v1.5.0',
  assets: [
    { name: 'notes.txt', browser_download_url: 'https://example.com/notes.txt' },
    {
      name: 'Ardite-win64.zip',
      size: 35175407,
      digest: `sha256:${sha}`,
      browser_download_url: 'https://github.com/vuxenn1/ardite/releases/download/v1.5.0/Ardite-win64.zip',
    },
  ],
};

test('readRelease takes the version, page and package from a GitHub release', () => {
  assert.deepEqual(readRelease(release), {
    version: '1.5.0',
    url: 'https://github.com/vuxenn1/ardite/releases/tag/v1.5.0',
    asset: {
      url: 'https://github.com/vuxenn1/ardite/releases/download/v1.5.0/Ardite-win64.zip',
      size: 35175407,
      sha256: sha,
    },
  });
});

test('readRelease works without a checksum or a package', () => {
  const noDigest = { ...release, assets: [{ ...release.assets[1], digest: undefined }] };
  assert.equal(readRelease(noDigest).asset.sha256, null);
  const noPackage = { ...release, assets: [] };
  assert.equal(readRelease(noPackage).asset, null);
  assert.equal(readRelease(noPackage).version, '1.5.0');
});

test('readRelease refuses odd answers', () => {
  assert.equal(readRelease(null), null);
  assert.equal(readRelease({}), null);
  assert.equal(readRelease({ ...release, tag_name: 'nightly' }), null);
  assert.equal(readRelease({ ...release, html_url: 'javascript:alert(1)' }), null);
  // a package link that isn't https is ignored, unless it's this PC (local test feeds)
  const http = { ...release, assets: [{ ...release.assets[1], browser_download_url: 'http://example.com/x.zip' }] };
  assert.equal(readRelease(http).asset, null);
  const sneaky = { ...release, assets: [{ ...release.assets[1], browser_download_url: 'http://127.0.0.1.evil.com/x.zip' }] };
  assert.equal(readRelease(sneaky).asset, null);
  const local = { ...release, assets: [{ ...release.assets[1], browser_download_url: 'http://127.0.0.1:7960/x.zip' }] };
  assert.equal(readRelease(local).asset.url, 'http://127.0.0.1:7960/x.zip');
  // a malformed checksum is ignored rather than trusted
  const bad = { ...release, assets: [{ ...release.assets[1], digest: 'md5:abc' }] };
  assert.equal(readRelease(bad).asset.sha256, null);
});
