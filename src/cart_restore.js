import { sendMessage, storageGet } from './shared/api.js';
import { isConfirmedCheckoutReceipt } from './shared/checkout-receipt.js';
import {
    CART_PURCHASE_COMPLETE_KEY,
    MSG_MARK_CART_PURCHASE_COMPLETE,
    MSG_RESTORE_PENDING_CART,
    PENDING_CART_RESTORE_KEY
} from './shared/constants.js';

(async function () {
    function isStorePage() {
        return window.location.hostname === 'store.steampowered.com';
    }

    function isCheckoutPage() {
        return window.location.hostname === 'checkout.steampowered.com' &&
            (window.location.pathname === '/checkout' || window.location.pathname.startsWith('/checkout/'));
    }

    if (!isStorePage() && !isCheckoutPage()) return;

    let pending = null;
    let purchaseMarker = null;
    try {
        const result = await storageGet([PENDING_CART_RESTORE_KEY, CART_PURCHASE_COMPLETE_KEY]);
        pending = result[PENDING_CART_RESTORE_KEY];
        purchaseMarker = result[CART_PURCHASE_COMPLETE_KEY] || null;
    } catch (err) {
        console.debug('[KOSTEAM] Pending cart restore read error:', err);
        return;
    }

    if (!pending?.autoRestore ||
        pending.phase !== 'checkout_started_unknown' ||
        !pending.transactionId ||
        !Array.isArray(pending.removedItems) ||
        pending.removedItems.length === 0) return;

    async function completePurchaseAndRestore() {
        const response = await sendMessage({
            type: MSG_MARK_CART_PURCHASE_COMPLETE,
            transactionId: pending.transactionId,
            recoveryRevision: pending.recoveryRevision
        });
        if (!response?.success) throw new Error(response?.error || 'Failed to complete cart restoration');
    }

    async function restorePendingCart() {
        const response = await sendMessage({
            type: MSG_RESTORE_PENDING_CART,
            transactionId: pending.transactionId,
            recoveryRevision: pending.recoveryRevision
        });

        if (!response?.success) {
            console.debug('[KOSTEAM] Pending cart restore failed:', response?.error || 'unknown');
            return false;
        }

        return true;
    }

    function isElementVisible(element) {
        if (!element || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;

        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        return element.getClientRects().length > 0;
    }

    function hasConfirmedReceipt() {
        const receiptArea = document.querySelector('#receipt_area');
        return isConfirmedCheckoutReceipt({
            receiptVisible: isElementVisible(receiptArea),
            pendingReceiptVisible: isElementVisible(document.querySelector('#pending_receipt_area')),
            cartVisible: isElementVisible(document.querySelector('#cart_area')),
            receiptErrorVisible: isElementVisible(receiptArea?.querySelector('#receipt_error_display')),
            purchaseSummaryVisible: isElementVisible(receiptArea?.querySelector('#purchase_summary_area')),
            confirmationCodeVisible: isElementVisible(receiptArea?.querySelector('#receipt_confirmation_code'))
        });
    }

    async function runStoreRestore() {
        const purchaseCompleted = purchaseMarker?.transactionId === pending.transactionId;
        if (window.location.pathname === '/cart' || window.location.pathname.startsWith('/cart/') || !purchaseCompleted) return;

        try {
            if (await restorePendingCart()) {
                console.log('[KOSTEAM] Restored pending cart items after returning to Steam Store.');
            }
        } catch (err) {
            console.debug('[KOSTEAM] Store pending cart restore error:', err);
        }
    }

    function runCheckoutRestoreWhenFinal() {
        let restoring = false;
        const observer = new MutationObserver(checkReceipt);

        async function checkReceipt() {
            if (restoring || !hasConfirmedReceipt()) return;
            restoring = true;
            observer.disconnect();

            try {
                await completePurchaseAndRestore();
                console.log('[KOSTEAM] Restored pending cart items after checkout completion.');
            } catch (err) {
                console.debug('[KOSTEAM] Checkout pending cart restore error:', err);
            }
        }

        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['aria-hidden', 'class', 'hidden', 'style'],
            childList: true,
            subtree: true
        });
        window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
        checkReceipt();
    }

    async function init() {
        if (isStorePage()) {
            await runStoreRestore();
        } else {
            runCheckoutRestoreWhenFinal();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
