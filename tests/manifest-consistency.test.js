import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const linterRequire = createRequire(require.resolve('addons-linter'));
const imageSize = linterRequire('image-size');

const readJson = relativePath => JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf-8'));
const packageJson = readJson('../package.json');
const manifests = [
    ['chrome', readJson('../src/manifests/manifest.chrome.json')],
    ['firefox', readJson('../src/manifests/manifest.firefox.json')]
];
const expectedHostPermissions = new Set([
    'https://api.steampowered.com/*',
    'https://raw.githubusercontent.com/snowyegret23/KOSTEAM/*'
]);

test('package metadata uses the supported module and runtime versions', () => {
    assert.equal(packageJson.version, '1.6.4');
    assert.equal(packageJson.type, 'module');
    assert.equal(packageJson.engines.node, '^20.19.0 || ^22.12.0 || >=24.0.0');
    assert.equal(packageJson.devDependencies['web-ext'], '10.6.0');
});

test('Firefox tooling resolves the replacement image parser', () => {
    assert.equal(linterRequire('image-size/package.json').name, '@kosteam/image-size-adapter');
    const lock = readJson('../package-lock.json');
    assert.equal(Object.values(lock.packages).some(entry => (
        entry.resolved?.startsWith('https://registry.npmjs.org/image-size/')
    )), false);
    for (const size of [16, 32, 48, 128]) {
        const data = readFileSync(new URL(`../src/static/icons/icon${size}.png`, import.meta.url));
        assert.deepEqual(imageSize(data), { width: size, height: size, type: 'png' });
    }
});

test('replacement parser preserves metadata for Firefox image formats', () => {
    const headers = [
        ['gif', '47494638396110002000'],
        ['jpg', 'ffd8ffe000044a46ffc0000b080020001003011100'],
        ['webp', '524946461600000057454250565038580a000000000000000f00001f0000']
    ];
    for (const [type, hex] of headers) {
        assert.deepEqual(imageSize(Buffer.from(hex, 'hex')), { width: 16, height: 32, type });
    }
    for (const svg of ['<svg width="16" height="32"/>', '<svg viewBox="0 0 16 32"/>']) {
        assert.deepEqual(imageSize(Buffer.from(svg)), { width: 16, height: 32, type: 'svg' });
    }
    assert.deepEqual(imageSize(Buffer.from('<svg width="1in" height="2.54cm"/>')), {
        width: 96, height: 96, type: 'svg'
    });
    assert.throws(() => imageSize(Buffer.from('not an image')), /Invalid or unsupported image/);
    assert.throws(() => imageSize(Buffer.from('89504e470d0a1a0a', 'hex')), /Invalid or unsupported image/);
});

test('replacement parser rejects zero-length image boxes without hanging', () => {
    // GHSA-w3rx-r6r6-pgpr (ICNS) and GHSA-5p2g-fcmc-qvqq (HEIF/JXL).
    const payloads = [
        '69636e73000000106973333200000000',
        '00000010667479706176696600000000000000246d65746100000000' +
            '0000000869707270000000146970636f0000000069737065' + '00'.repeat(16),
        '0000000c4a584c200d0a870a000000006a786c7000000000'
    ];
    const result = spawnSync(process.execPath, ['--input-type=commonjs', '-e', `
        const assert = require('node:assert/strict');
        const imageSize = require(${JSON.stringify(linterRequire.resolve('image-size'))});
        for (const hex of ${JSON.stringify(payloads)}) {
            assert.throws(() => imageSize(Buffer.from(hex, 'hex')), /Invalid or unsupported image/);
        }
    `], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
});

test('browser manifests match package version and hardened shared policy', () => {
    for (const [browser, manifest] of manifests) {
        assert.equal(manifest.version, packageJson.version, browser);
        assert.equal(manifest.manifest_version, 3, browser);
        assert.equal(Object.hasOwn(manifest.background, 'type'), false, browser);
        assert.equal(
            manifest.content_security_policy.extension_pages,
            "script-src 'self'; object-src 'none'",
            browser
        );
        assert.deepEqual(new Set(manifest.permissions), new Set(['storage', 'alarms']), browser);
        assert.deepEqual(new Set(manifest.host_permissions), expectedHostPermissions, browser);
        assert.equal(Object.hasOwn(manifest, 'optional_permissions'), false, browser);
    }
});

test('browser-specific compatibility metadata remains explicit', () => {
    const chrome = manifests.find(([browser]) => browser === 'chrome')[1];
    const firefox = manifests.find(([browser]) => browser === 'firefox')[1];

    assert.equal(chrome.minimum_chrome_version, '102');
    assert.equal(firefox.browser_specific_settings.gecko.strict_min_version, '140.0');
    assert.equal(firefox.browser_specific_settings.gecko_android.strict_min_version, '142.0');
    assert.deepEqual(
        firefox.browser_specific_settings.gecko.data_collection_permissions,
        {
            required: ['none'],
            optional: ['authenticationInfo', 'locationInfo', 'websiteContent', 'websiteActivity']
        }
    );
});

test('cart restoration keeps path-limited checkout and store fallback access', () => {
    for (const [browser, manifest] of manifests) {
        const restoreScript = manifest.content_scripts.find(entry => (
            entry.js?.includes('cart_restore.js')
        ));
        assert.ok(restoreScript, browser);
        assert.deepEqual(new Set(restoreScript.matches), new Set([
            'https://store.steampowered.com/*',
            'https://checkout.steampowered.com/checkout*'
        ]), browser);
        assert.equal(
            manifest.host_permissions.includes('https://checkout.steampowered.com/*'),
            false,
            browser
        );
    }
});
