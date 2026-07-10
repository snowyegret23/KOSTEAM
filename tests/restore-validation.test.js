import test from 'node:test';
import assert from 'node:assert/strict';

import {
    MAX_CART_RESTORE_ITEMS,
    MAX_STEAM_ITEM_ID,
    isValidAddItemsResponse,
    isValidCartItem,
    isValidTransactionId,
    validateCartRestorePayload
} from '../src/shared/restore-validation.js';

const makePayload = items => ({
    token: 'trusted-token',
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
        { response: { line_item_ids: ['not-an-id'] } }
    ]) {
        assert.equal(isValidAddItemsResponse(payload), false);
    }
});
