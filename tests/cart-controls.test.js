import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getRemoveControlIndex,
    isContextualRemoveControl
} from '../src/shared/cart-controls.js';

test('recognizes a contextual remove control even when no Add control exists', () => {
    const remove = {
        id: 'remove-id',
        labelledBy: 'remove-id product-id',
        title: null
    };

    assert.equal(isContextualRemoveControl(remove, id => id === 'product-id'), true);
    assert.equal(isContextualRemoveControl(remove, id => id === 'other-product'), false);
    assert.equal(isContextualRemoveControl({ ...remove, title: 'localized add hint' }), false);
});

test('identifies the untitled remove control through shared accessibility context', () => {
    assert.equal(getRemoveControlIndex([
        { id: 'add-id', labelledBy: 'add-id product-id', title: 'localized add hint' },
        { id: 'remove-id', labelledBy: 'remove-id product-id', title: null }
    ]), 1);
});

test('does not depend on control order or localized text', () => {
    assert.equal(getRemoveControlIndex([
        { id: 'remove-id', labelledBy: 'product-id remove-id', title: '' },
        { id: 'add-id', labelledBy: 'product-id add-id', title: '任意の言語' }
    ]), 0);
});

test('fails closed when the accessibility relationship is incomplete', () => {
    assert.equal(getRemoveControlIndex([
        { id: 'add-id', labelledBy: 'add-id first-product', title: 'add' },
        { id: 'remove-id', labelledBy: 'remove-id second-product', title: null }
    ]), -1);
    assert.equal(getRemoveControlIndex([
        { id: 'add-id', labelledBy: 'product-id', title: 'add' },
        { id: 'remove-id', labelledBy: 'remove-id product-id', title: null }
    ]), -1);
    assert.equal(getRemoveControlIndex([
        { id: 'add-id', labelledBy: 'add-id product-id', title: 'add' },
        { id: 'remove-id', labelledBy: 'remove-id product-id', title: null }
    ], contextId => contextId === 'different-product'), -1);
});

test('fails closed when the title marker or group size is ambiguous', () => {
    assert.equal(getRemoveControlIndex([
        { id: 'first-id', labelledBy: 'first-id product-id', title: null },
        { id: 'second-id', labelledBy: 'second-id product-id', title: null }
    ]), -1);
    assert.equal(getRemoveControlIndex([
        { id: 'first-id', labelledBy: 'first-id product-id', title: 'first' },
        { id: 'second-id', labelledBy: 'second-id product-id', title: 'second' }
    ]), -1);
    assert.equal(getRemoveControlIndex([
        { id: 'only-id', labelledBy: 'only-id product-id', title: null }
    ]), -1);
});
