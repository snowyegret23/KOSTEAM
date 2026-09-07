import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as constants from '../src/shared/constants.js';
import * as restoreValidation from '../src/shared/restore-validation.js';

import {
    MAX_CART_RESTORE_ITEMS,
    MAX_STEAM_ITEM_ID,
    getSteamAccountId,
    isValidAddItemsResponse,
    isValidCartItem,
    isValidTransactionId,
    validateCartRestorePayload
} from '../src/shared/restore-validation.js';

const makePayload = items => ({
    token: `e30.${Buffer.from(JSON.stringify({ sub: '76561198000000001' })).toString('base64url')}.signature`,
    countryCode: 'KR',
    items,
    sourceTag: 'main-cluster-topseller'
});

test('restore validation preserves duplicate cart items and their order', () => {
    const items = [
        { id: 42, type: 'package' },
        { id: 42, type: 'package' },
        { id: 9, type: 'bundle' }
    ];
    const result = validateCartRestorePayload(makePayload(items));

    assert.equal(result.valid, true);
    assert.deepEqual(result.value.items, items);
});

test('cart item IDs must be positive integers within the Steam ID range', () => {
    assert.equal(isValidCartItem({ id: 1, type: 'package' }), true);
    assert.equal(isValidCartItem({ id: MAX_STEAM_ITEM_ID, type: 'bundle' }), true);

    for (const id of [0, -1, 1.5, MAX_STEAM_ITEM_ID + 1, Number.MAX_SAFE_INTEGER + 1]) {
        assert.equal(isValidCartItem({ id, type: 'package' }), false, String(id));
    }
    assert.equal(isValidCartItem({ id: 1, type: 'application' }), false);
});

test('restore validation enforces the cart item count limit', () => {
    const maximumItems = Array.from(
        { length: MAX_CART_RESTORE_ITEMS },
        (_, index) => ({ id: index + 1, type: 'package' })
    );
    assert.equal(validateCartRestorePayload(makePayload(maximumItems)).valid, true);

    const tooManyItems = [...maximumItems, { id: MAX_CART_RESTORE_ITEMS + 1, type: 'package' }];
    const result = validateCartRestorePayload(makePayload(tooManyItems));
    assert.deepEqual(result, { valid: false, error: 'Invalid restore item count' });

    const splitPayload = {
        ...makePayload(maximumItems.slice(0, 60)),
        remainingItems: maximumItems.slice(0, 41)
    };
    assert.deepEqual(
        validateCartRestorePayload(splitPayload),
        { valid: false, error: 'Invalid remaining item count' }
    );
});

test('restore transaction IDs accept only UUID v4 values', () => {
    assert.equal(isValidTransactionId('123e4567-e89b-42d3-a456-426614174000'), true);
    assert.equal(isValidTransactionId('123e4567-e89b-12d3-a456-426614174000'), false);
    assert.equal(isValidTransactionId('not-a-transaction'), false);
});

test('cart API success requires confirmed positive line item IDs', () => {
    assert.equal(isValidAddItemsResponse({ response: { line_item_ids: ['123456789012345678'] } }), true);
    assert.equal(isValidAddItemsResponse({ response: { line_item_ids: [42] } }), true);

    for (const payload of [
        null,
        {},
        { response: {} },
        { response: { line_item_ids: [] } },
        { response: { line_item_ids: ['0'] } },
        { response: { line_item_ids: ['00'] } },
        { response: { line_item_ids: ['not-an-id'] } }
    ]) {
        assert.equal(isValidAddItemsResponse(payload), false);
    }
});

function createBackground(fetch, initial = {}) {
    const local = { [constants.CART_FEATURE_KEY]: true, ...initial };
    const session = {};
    let handler;
    let cacheReads = 0;
    const pick = (state, keys) => Object.fromEntries(keys.map(key => [key, structuredClone(state[key])]));
    const context = vm.createContext({
        ...constants, ...restoreValidation,
        URL, Uint8Array, TextEncoder, TextDecoder, crypto, FormData, AbortController,
        setTimeout, clearTimeout, atob, btoa, fetch,
        console: { log() {}, error() {} },
        api: { runtime: { id: 'test-extension', getURL: path => `chrome-extension://test-extension${path}` } },
        storageGet: async keys => { if (keys.includes(constants.CACHE_KEY)) cacheReads++; return pick(local, keys); },
        storageSet: async values => Object.assign(local, structuredClone(values)),
        storageSessionGet: async keys => pick(session, keys),
        storageSessionSet: async values => Object.assign(session, structuredClone(values)),
        storageSessionRemove: async keys => keys.forEach(key => { delete session[key]; }),
        permissionsGetAll: async () => ({}),
        alarmCreate: async () => {}, alarmClear: async () => {},
        onAlarm() {}, onInstalled() {}, onStartup() {},
        onMessage: callback => { handler = callback; }
    });
    const apiSource = readFileSync(new URL('../src/shared/api.js', import.meta.url), 'utf8');
    const timeout = apiSource.match(/export async function withRequestTimeout\([\s\S]*?\n\}/)[0];
    vm.runInContext(timeout.replace('export ', ''), context);
    const source = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');
    vm.runInContext(source.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, ''), context);
    return {
        local, session, cacheReads: () => cacheReads,
        send: message => new Promise(resolve => handler(message, {
            id: 'test-extension', url: 'https://store.steampowered.com/cart/', tab: { id: 1 }
        }, resolve))
    };
}

test('recovery rejects another account after restart and accepts the original account with JSON API responses', async () => {
    let requests = 0;
    const background = createBackground(async (url, options) => {
        requests++;
        assert.equal(new URL(url).searchParams.get('format'), 'json');
        assert.equal(options.method, 'POST');
        return Response.json({ response: { line_item_ids: ['4179612753'] } });
    });
    const payload = makePayload([{ id: 42, type: 'package' }]);
    const saved = await background.send({ type: constants.MSG_SAVE_CART_RESTORE, ...payload });
    assert.equal(saved.success, true);
    delete background.session[constants.CART_RESTORE_SECRET_KEY];
    const recovery = { type: constants.MSG_RECOVER_CART, ...payload, ...saved };
    const wrong = await background.send({ ...recovery,
        token: `e30.${Buffer.from(JSON.stringify({ sub: '76561198000000002' })).toString('base64url')}.signature`
    });
    assert.equal(wrong.success, false);
    assert.match(wrong.error, /account/);
    assert.equal(requests, 0);
    assert.equal((await background.send(recovery)).success, true);
    assert.equal(requests, 1);
    assert.equal(background.local[constants.PENDING_CART_RESTORE_KEY], null);
});

test('concurrent cold lookups wait for one verified download and reuse the in-memory cache', async () => {
    const published = JSON.parse(readFileSync(new URL('../data/lookup.json', import.meta.url), 'utf8'));
    const appId = Object.keys(published).find(key => key !== '_meta');
    const lookup = JSON.stringify({ _meta: { generated_at: 'fixture', total: 1 }, [appId]: published[appId] });
    const alias = '{}';
    const digest = text => createHash('sha256').update(text).digest('hex');
    const version = {
        generated_at: 'fixture', alias_updated_at: 'fixture', total: 1,
        lookup_size: Buffer.byteLength(lookup), lookup_sha256: digest(lookup),
        alias_size: Buffer.byteLength(alias), alias_sha256: digest(alias)
    };
    let requests = 0;
    const background = createBackground(async url => {
        requests++;
        if (url === constants.VERSION_URL) return Response.json(version);
        return new Response(url === constants.DATA_URL ? lookup : alias);
    });
    const responses = await Promise.all(Array.from({ length: 20 }, () => background.send({
        type: constants.MSG_GET_PATCH_INFO, appId
    })));
    assert.ok(responses.every(response => response.success && response.info));
    assert.equal(requests, 3);
    assert.equal(background.cacheReads(), 1);
    assert.equal((await background.send({ type: constants.MSG_GET_PATCH_INFO, appId })).success, true);
    assert.equal(requests, 3);
    assert.equal(background.cacheReads(), 1);
});

test('unavailable cold data returns a lookup failure rather than a successful absent-patch result', async () => {
    const background = createBackground(async () => new Response(null, { status: 503 }));
    const result = await background.send({ type: constants.MSG_GET_PATCH_INFO, appId: '42' });
    assert.equal(result.success, false);
    assert.match(result.error, /unavailable/);
});

test('recovery account identity is derived from the token and rejects unknown accounts', () => {
    const payload = makePayload([{ id: 42, type: 'package' }]);
    const accountId = '76561198000000001';
    assert.equal(getSteamAccountId(payload.token), accountId);
    assert.equal(validateCartRestorePayload({ ...payload, accountId: '76561198000000002' }).value.accountId, accountId);
    for (const token of ['opaque-token', 'e30.invalid.signature', 'e30.e30.signature']) {
        assert.equal(getSteamAccountId(token), null);
        assert.equal(validateCartRestorePayload({ ...payload, token }).valid, false);
    }
});
