import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { isValidSourceUrl } from '../src/shared/url-validator.js';

const readJson = relativePath => JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf-8'));
const version = readJson('../data/version.json');
const lookup = readJson('../data/lookup.json');
const alias = readJson('../data/alias.json');

function canonicalBytes(value) {
    return Buffer.from(JSON.stringify(value, null, 2), 'utf-8');
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

test('published data metadata matches canonical lookup and alias bytes', () => {
    const lookupBytes = canonicalBytes(lookup);
    const aliasBytes = canonicalBytes(alias);

    assert.equal(lookupBytes.byteLength, version.lookup_size);
    assert.equal(sha256(lookupBytes), version.lookup_sha256);
    assert.equal(aliasBytes.byteLength, version.alias_size);
    assert.equal(sha256(aliasBytes), version.alias_sha256);
    assert.equal(lookup._meta.generated_at, version.generated_at);
    assert.equal(lookup._meta.total, version.total);
    assert.equal(Object.keys(lookup).length - 1, version.total);
});

test('every rendered source URL satisfies its exact HTTPS allowlist', () => {
    for (const [appId, info] of Object.entries(lookup)) {
        if (appId === '_meta') continue;
        for (const [source, url] of Object.entries(info.source_site_urls || {})) {
            assert.equal(isValidSourceUrl(source, url), true, `${appId} ${source}: ${url}`);
        }
    }
});
