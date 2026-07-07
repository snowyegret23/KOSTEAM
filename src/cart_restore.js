import { sendMessage, storageGet, storageSet } from './shared/api.js';
import {
    CART_PURCHASE_COMPLETE_KEY,
    CART_RESTORE_COMPLETE_KEY,
    MSG_RESTORE_CART,
    PENDING_CART_RESTORE_KEY
} from './shared/constants.js';

(async function () {
    const SNAPSHOT_STORAGE_KEY = 'kosteam_cart_snapshot';
    const FINAL_CHECK_INTERVAL_MS = 1000;
    const FINAL_CHECK_TIMEOUT_MS = 120000;

    const CHECKOUT_FINAL_PATTERNS = [
        /purchase\s+complete/i,
        /thank\s+you\s+for\s+your\s+purchase/i,
        /your\s+purchase\s+has\s+been\s+completed/i,
        /receipt/i,
        /구매\s*완료/,
        /구매가\s*완료/,
        /구매해\s*주셔서/,
        /주문이\s*완료/,
        /영수증/,
        /결제\s*완료/
    ];

    const CHECKOUT_ACTIVE_PATTERNS = [
        /payment\s+method/i,
        /review\s*\+\s*purchase/i,
        /complete\s+your\s+purchase/i,
        /결제\s*수단/,
        /결제\s*방법/,
        /주문을\s*완료/
    ];

    const CHECKOUT_RECEIPT_SELECTORS = [
        '#receipt_area',
        '#receipt_pipeline',
        '#checkout_logo_receipt'
    ];

    const CHECKOUT_ACTIVE_SELECTORS = [
        '#cart_area',
        '#checkout_pipeline',
        '#checkout_logo_default',
        '#review_tab',
        '#purchase_bottom'
    ];

    function isStorePage() {
        return window.location.hostname === 'store.steampowered.com';
    }

    function isCheckoutPage() {
        return window.location.hostname.endsWith('checkout.steampowered.com');
    }

    if (!isStorePage() && !isCheckoutPage()) return;

    let pending = null;
    let purchaseCompletedAt = null;
    try {
        const result = await storageGet([PENDING_CART_RESTORE_KEY, CART_PURCHASE_COMPLETE_KEY]);
        pending = result[PENDING_CART_RESTORE_KEY];
        purchaseCompletedAt = result[CART_PURCHASE_COMPLETE_KEY] || null;
    } catch (err) {
        console.debug('[KOSTEAM] Pending cart restore read error:', err);
        return;
    }

    if (!pending?.autoRestore || !Array.isArray(pending.removedItems) || pending.removedItems.length === 0) return;

    async function markRestoreComplete() {
        try {
            localStorage.removeItem(SNAPSHOT_STORAGE_KEY);
        } catch {
            // checkout.steampowered.com cannot clear the store origin snapshot.
        }

        await storageSet({
            [PENDING_CART_RESTORE_KEY]: null,
            [CART_RESTORE_COMPLETE_KEY]: new Date().toISOString(),
            [CART_PURCHASE_COMPLETE_KEY]: null
        });
    }

    async function markPurchaseComplete() {
        purchaseCompletedAt = new Date().toISOString();
        await storageSet({ [CART_PURCHASE_COMPLETE_KEY]: purchaseCompletedAt });
    }

    async function restorePendingCart() {
        if (!pending?.token) {
            console.debug('[KOSTEAM] Pending cart restore skipped: missing token');
            return false;
        }

        const response = await sendMessage({
            type: MSG_RESTORE_CART,
            token: pending.token,
            items: pending.removedItems,
            sourceTag: pending.sourceTag || 'main-cluster-topseller'
        });

        if (!response?.success) {
            console.debug('[KOSTEAM] Pending cart restore failed:', response?.error || 'unknown');
            return false;
        }

        await markRestoreComplete();
        return true;
    }

    function isElementVisible(element) {
        if (!element) return false;

        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
            return false;
        }

        return element.getClientRects().length > 0;
    }

    function hasVisibleElement(selectors) {
        return selectors.some(selector => isElementVisible(document.querySelector(selector)));
    }

    function checkoutLooksFinal() {
        if (hasVisibleElement(CHECKOUT_RECEIPT_SELECTORS)) return true;
        if (hasVisibleElement(CHECKOUT_ACTIVE_SELECTORS)) return false;

        const text = document.body?.innerText || '';
        if (!text) return false;

        const hasFinalSignal = CHECKOUT_FINAL_PATTERNS.some(pattern => pattern.test(text));
        if (!hasFinalSignal) return false;

        const hasActiveSignal = CHECKOUT_ACTIVE_PATTERNS.some(pattern => pattern.test(text));
        return !hasActiveSignal || /영수증|receipt/i.test(text);
    }

    async function runStoreRestore() {
        if (window.location.pathname.startsWith('/cart')) return;
        if (!purchaseCompletedAt) return;

        try {
            const restored = await restorePendingCart();
            if (restored) {
                console.log('[KOSTEAM] Restored pending cart items after returning to Steam Store.');
            }
        } catch (err) {
            console.debug('[KOSTEAM] Store pending cart restore error:', err);
        }
    }

    async function runCheckoutRestoreWhenFinal() {
        const startedAt = Date.now();

        const tick = async () => {
            if (Date.now() - startedAt > FINAL_CHECK_TIMEOUT_MS) return;

            if (!checkoutLooksFinal()) {
                setTimeout(tick, FINAL_CHECK_INTERVAL_MS);
                return;
            }

            try {
                await markPurchaseComplete();
                const restored = await restorePendingCart();
                if (restored) {
                    console.log('[KOSTEAM] Restored pending cart items after checkout completion.');
                }
            } catch (err) {
                console.debug('[KOSTEAM] Checkout pending cart restore error:', err);
            }
        };

        setTimeout(tick, FINAL_CHECK_INTERVAL_MS);
    }

    async function init() {
        if (isStorePage()) {
            await runStoreRestore();
            return;
        }

        if (isCheckoutPage()) {
            await runCheckoutRestoreWhenFinal();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
