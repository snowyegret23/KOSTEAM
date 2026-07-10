import { isValidCartItem, MAX_CART_RESTORE_ITEMS } from './restore-validation.js';

function getValidItems(value) {
    return Array.isArray(value) && value.every(isValidCartItem) ? value : null;
}

export function getMissingCartItems(targetItems, currentItems) {
    if (!getValidItems(targetItems) || !getValidItems(currentItems)) return null;

    const currentCounts = new Map();
    for (const item of currentItems) {
        const key = `${item.type}:${item.id}`;
        currentCounts.set(key, (currentCounts.get(key) || 0) + 1);
    }

    const missing = [];
    for (const item of targetItems) {
        const key = `${item.type}:${item.id}`;
        const count = currentCounts.get(key) || 0;
        if (count > 0) {
            currentCounts.set(key, count - 1);
        } else {
            missing.push(item);
        }
    }
    return missing;
}

export function getCartRecoveryPlan(pending, currentItems, purchaseCompleted) {
    if (!pending || pending.autoRestore !== true ||
        !Number.isSafeInteger(pending.recoveryRevision) || pending.recoveryRevision < 0) return null;

    const removedItems = getValidItems(pending.removedItems);
    const originalRemovedItems = getValidItems(pending.originalRemovedItems) || removedItems;
    const remainingItems = getValidItems(pending.remainingItems || []);
    if (!removedItems || !originalRemovedItems || !remainingItems ||
        originalRemovedItems.length === 0 ||
        originalRemovedItems.length + remainingItems.length > MAX_CART_RESTORE_ITEMS) {
        return null;
    }

    if (pending.phase === 'recovery_in_progress') {
        const recoveryTargetItems = getValidItems(pending.recoveryTargetItems);
        if (!recoveryTargetItems || recoveryTargetItems.length === 0 ||
            recoveryTargetItems.length > MAX_CART_RESTORE_ITEMS) return null;
        return getMissingCartItems(recoveryTargetItems, currentItems);
    }

    if (purchaseCompleted) {
        return getMissingCartItems(originalRemovedItems, currentItems);
    }
    if (pending.phase === 'prepared') {
        return getMissingCartItems([...remainingItems, ...originalRemovedItems], currentItems);
    }

    if (pending.phase === 'recovery_requires_cart') {
        return [...removedItems];
    }

    if (pending.phase !== 'checkout_started_unknown') return null;

    // Removal was complete before checkout started, so each still-pending item
    // must be restored even when a selected item has the same package ID.
    return [...removedItems];
}
