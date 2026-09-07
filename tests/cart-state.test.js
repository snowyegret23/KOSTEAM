import test from 'node:test';
import assert from 'node:assert/strict';

import { keySetsEqual, parseCartPrice, waitForObservedCondition } from '../src/shared/cart_state.js';

test('prices preserve decimal commas, suffix currencies and the final discounted price', () => {
    for (const [text, value, currency] of [
        ['₩ 16,500₩ 13,200개인 소장용', 13200, '₩'],
        ['€19,99', 19.99, '€'],
        ['19,99€', 19.99, '€'],
        ['1.234,56 €', 1234.56, '€'],
        ['$1,234.56', 1234.56, '$'],
        ['£ 19.99', 19.99, '£'],
        ['₩ 520', 520, '₩']
    ]) assert.deepEqual(parseCartPrice(text), { value, currency }, text);
    assert.equal(parseCartPrice('가격 정보 없음'), null);
    assert.equal(parseCartPrice('₩ 12,34'), null);
});

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
