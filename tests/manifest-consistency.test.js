import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
    assert.equal(packageJson.engines.node, '>=20.18.1');
    assert.equal(packageJson.devDependencies['web-ext'], '10.5.0');
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
