import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readSource = name => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf-8');

test('dynamic page checks use observers without polling or whole-body text scans', () => {
    for (const name of ['content.js', 'community.js', 'search_bypass.js', 'cart_restore.js']) {
        const source = readSource(name);
        assert.match(source, /MutationObserver/, name);
        assert.doesNotMatch(source, /\bset(?:Timeout|Interval)\s*\(/, name);
        assert.doesNotMatch(source, /\binnerText\b/, name);
    }
});

test('store fallback restoration requires the matching checkout receipt marker', () => {
    const restore = readSource('cart_restore.js');
    assert.match(restore, /CART_PURCHASE_COMPLETE_KEY/);
    assert.match(restore, /purchaseMarker\?\.transactionId === pending\.transactionId/);
});

test('checkout completion uses strict receipt state and background-owned restoration', () => {
    const restore = readSource('cart_restore.js');
    const background = readSource('background.js');

    assert.match(restore, /isConfirmedCheckoutReceipt/);
    assert.doesNotMatch(restore, /CHECKOUT_RECEIPT_SELECTORS/);
    assert.doesNotMatch(restore, /#receipt_pipeline|#checkout_logo_receipt/);
    assert.match(restore, /async function completePurchaseAndRestore/);
    assert.match(
        background,
        /markCartPurchaseComplete\([\s\S]+?\.then\(async marked =>[\s\S]+?restorePendingCart\(/
    );
});

test('search and destructive cart controls use stable element relationships', () => {
    const search = readSource('search_bypass.js');
    const cart = readSource('cart.js');

    assert.match(search, /data-param="supportedlang"\]\[data-value="koreana"\]\.checked/);
    assert.match(cart, /getRemoveControlIndex/);
    assert.match(cart, /isContextualRemoveControl/);
    assert.match(cart, /aria-labelledby/);
    assert.match(cart, /linkedNames\.includes\(contextName\)/);
    assert.match(cart, /findReAddableRemoveButton/);
    assert.match(cart, /findReAddableRemoveButton\(item\);\s+if \(!removeButton\)[\s\S]+?removeButton\.click\(\)/);
    assert.match(cart, /isConnected/);
    assert.match(cart, /aria-hidden/);
    assert.doesNotMatch(cart, /_3YCgcpoCojlbS6DvkNsG2J|_3F0SnUeC_obtI4WyQtijAa|_17GFdSD2pc0BquZk5cejg8|_2rkDlHZ2yi-tFtDk4-CC4U/);
});
