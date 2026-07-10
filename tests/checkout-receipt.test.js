import test from 'node:test';
import assert from 'node:assert/strict';

import { isConfirmedCheckoutReceipt } from '../src/shared/checkout-receipt.js';

const completed = {
    receiptVisible: true,
    pendingReceiptVisible: false,
    cartVisible: false,
    receiptErrorVisible: false,
    purchaseSummaryVisible: true,
    confirmationCodeVisible: true
};

test('confirms the structural state captured by the Steam receipt fixture', () => {
    assert.equal(isConfirmedCheckoutReceipt(completed), true);
});

test('rejects the structural state captured before purchase', () => {
    assert.equal(isConfirmedCheckoutReceipt({
        ...completed,
        receiptVisible: false,
        cartVisible: true
    }), false);
});

test('rejects pending, error, and incomplete checkout states', () => {
    for (const override of [
        { pendingReceiptVisible: true },
        { receiptErrorVisible: true },
        { purchaseSummaryVisible: false },
        { confirmationCodeVisible: false }
    ]) {
        assert.equal(isConfirmedCheckoutReceipt({ ...completed, ...override }), false);
    }
});
