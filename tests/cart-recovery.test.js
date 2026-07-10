import test from 'node:test';
import assert from 'node:assert/strict';

import { getCartRecoveryPlan } from '../src/shared/cart-recovery.js';

const pkg = id => ({ id, type: 'package' });

test('prepared recovery preserves duplicate multiplicity without restoring present items twice', () => {
    const plan = getCartRecoveryPlan({
        autoRestore: true,
        recoveryRevision: 0,
        phase: 'prepared',
        originalRemovedItems: [pkg(10)],
        removedItems: [pkg(10)],
        remainingItems: [pkg(10)]
    }, [pkg(10)], false);

    assert.deepEqual(plan, [pkg(10)]);
});

test('purchase-confirmed recovery only fills the missing original removed multiset', () => {
    const plan = getCartRecoveryPlan({
        autoRestore: true,
        recoveryRevision: 0,
        phase: 'checkout_started_unknown',
        originalRemovedItems: [pkg(10), pkg(10)],
        removedItems: [pkg(10), pkg(10)],
        remainingItems: [pkg(20)]
    }, [pkg(10)], true);

    assert.deepEqual(plan, [pkg(10)]);
});

test('checkout-started unknown state restores pending removed duplicates directly', () => {
    const plan = getCartRecoveryPlan({
        autoRestore: true,
        recoveryRevision: 0,
        phase: 'checkout_started_unknown',
        originalRemovedItems: [pkg(10)],
        removedItems: [pkg(10)],
        remainingItems: [pkg(10)]
    }, [pkg(10)], false);

    assert.deepEqual(plan, [pkg(10)]);
});

test('checkout-started progress treats an empty pending list as authoritative', () => {
    const plan = getCartRecoveryPlan({
        autoRestore: true,
        recoveryRevision: 1,
        phase: 'checkout_started_unknown',
        originalRemovedItems: [pkg(10)],
        removedItems: [],
        remainingItems: [pkg(20)]
    }, [pkg(20)], false);

    assert.deepEqual(plan, []);
});

test('failed direct restore retries the exact remaining removed multiplicity', () => {
    const plan = getCartRecoveryPlan({
        autoRestore: true,
        recoveryRevision: 2,
        phase: 'recovery_requires_cart',
        originalRemovedItems: [pkg(10), pkg(10)],
        removedItems: [pkg(10), pkg(10)],
        remainingItems: [pkg(10)]
    }, [pkg(10)], false);

    assert.deepEqual(plan, [pkg(10), pkg(10)]);
});

test('in-progress recovery resumes from its exact target multiset', () => {
    const plan = getCartRecoveryPlan({
        autoRestore: true,
        recoveryRevision: 2,
        phase: 'recovery_in_progress',
        originalRemovedItems: [pkg(10), pkg(10)],
        removedItems: [pkg(10)],
        remainingItems: [pkg(20)],
        recoveryTargetItems: [pkg(10), pkg(10), pkg(20)]
    }, [pkg(10), pkg(20)], false);

    assert.deepEqual(plan, [pkg(10)]);
});

test('invalid recovery metadata fails closed', () => {
    assert.equal(getCartRecoveryPlan({ autoRestore: true, recoveryRevision: 0, removedItems: [] }, [], false), null);
    assert.equal(getCartRecoveryPlan({
        autoRestore: true,
        recoveryRevision: 0,
        removedItems: [pkg(10)]
    }, [], false), null);
});
