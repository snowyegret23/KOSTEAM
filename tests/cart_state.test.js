import test from 'node:test';
import assert from 'node:assert/strict';

import { keySetsEqual, waitForKeySet, waitForObservedCondition } from '../src/shared/cart_state.js';

test('keySetsEqual ignores ordering and rejects missing or extra keys', () => {
    assert.equal(keySetsEqual(['app:1', 'bundle:2'], ['bundle:2', 'app:1']), true);
    assert.equal(keySetsEqual(['app:1'], ['app:1', 'bundle:2']), false);
    assert.equal(keySetsEqual(['app:1', 'bundle:2'], ['app:1']), false);
});

test('waitForKeySet resolves when an observed mutation reaches the expected keys', async () => {
    let keys = ['app:1', 'bundle:2'];
    let notify;

    const resultPromise = waitForKeySet({
        expectedKeys: ['app:1'],
        getCurrentKeys: () => keys,
        observe: callback => {
            notify = callback;
            return () => {};
        },
        timeoutMs: 1000
    });

    keys = ['app:1'];
    notify();

    assert.equal(await resultPromise, true);
});

test('waitForObservedCondition resolves when an observed mutation satisfies the condition', async () => {
    let ready = false;
    let notify;

    const resultPromise = waitForObservedCondition({
        condition: () => ready,
        observe: callback => {
            notify = callback;
            return () => {};
        },
        timeoutMs: 1000
    });

    ready = true;
    notify();

    assert.equal(await resultPromise, true);
});

test('waitForObservedCondition waits until the condition remains stable', async () => {
    let ready = false;
    let notify;

    const resultPromise = waitForObservedCondition({
        condition: () => ready,
        observe: callback => {
            notify = callback;
            return () => {};
        },
        stableMs: 30,
        timeoutMs: 1000
    });

    ready = true;
    notify();
    ready = false;
    notify();

    await new Promise(resolve => setTimeout(resolve, 50));
    ready = true;
    notify();

    assert.equal(await resultPromise, true);
});

test('waitForKeySet waits until the expected keys remain stable', async () => {
    let keys = ['app:1', 'bundle:2'];
    let notify;

    const resultPromise = waitForKeySet({
        expectedKeys: ['app:1'],
        getCurrentKeys: () => keys,
        observe: callback => {
            notify = callback;
            return () => {};
        },
        stableMs: 30,
        timeoutMs: 1000
    });

    keys = ['app:1'];
    notify();
    keys = ['app:1', 'sub:3'];
    notify();

    await new Promise(resolve => setTimeout(resolve, 50));
    keys = ['app:1'];
    notify();

    assert.equal(await resultPromise, true);
});

test('waitForKeySet resolves false when the expected keys never appear', async () => {
    const result = await waitForKeySet({
        expectedKeys: ['app:1'],
        getCurrentKeys: () => ['bundle:2'],
        observe: () => () => {},
        timeoutMs: 30
    });

    assert.equal(result, false);
});
