import test from 'node:test';
import assert from 'node:assert/strict';

import { keySetsEqual, waitForObservedCondition } from '../src/shared/cart_state.js';

test('cart key comparison preserves duplicate multiplicity', () => {
    assert.equal(keySetsEqual(['package:1', 'package:1'], ['package:1', 'package:1']), true);
    assert.equal(keySetsEqual(['package:1'], ['package:1', 'package:1']), false);
});

test('observed conditions check an already-ready DOM state immediately', async () => {
    const element = { isConnected: true };
    let disconnected = false;
    let observeCalls = 0;

    const result = await waitForObservedCondition({
        condition: () => element.isConnected,
        observe: () => {
            observeCalls++;
            return () => { disconnected = true; };
        },
        timeoutMs: 50
    });

    assert.equal(result, true);
    assert.equal(observeCalls, 1);
    assert.equal(disconnected, true);
});

test('observed conditions fail at the timeout boundary and disconnect', async () => {
    let notifyMutation;
    let disconnected = false;
    let conditionCalls = 0;

    const result = await waitForObservedCondition({
        condition: () => {
            conditionCalls++;
            return false;
        },
        observe: callback => {
            notifyMutation = callback;
            return () => { disconnected = true; };
        },
        timeoutMs: 10
    });

    assert.equal(result, false);
    assert.equal(disconnected, true);
    assert.equal(conditionCalls, 1);

    notifyMutation();
    assert.equal(conditionCalls, 1);
});
