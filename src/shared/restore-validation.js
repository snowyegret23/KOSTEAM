export const MAX_CART_RESTORE_ITEMS = 100;
export const MAX_STEAM_ITEM_ID = 0xffffffff;
export const MAX_TOKEN_LENGTH = 8192;
export const MAX_SOURCE_TAG_LENGTH = 128;

const ITEM_TYPES = new Set(['package', 'bundle']);
const SOURCE_TAG_PATTERN = /^[a-z0-9._:-]+$/i;
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;
const TRANSACTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidCartItem(item) {
    return !!item &&
        typeof item === 'object' &&
        Number.isSafeInteger(item.id) &&
        item.id > 0 &&
        item.id <= MAX_STEAM_ITEM_ID &&
        ITEM_TYPES.has(item.type);
}

export function isValidTransactionId(value) {
    return typeof value === 'string' && TRANSACTION_ID_PATTERN.test(value);
}

export function isValidAddItemsResponse(payload) {
    const response = payload?.response;
    if (!response || typeof response !== 'object' || Array.isArray(response)) return false;
    if (!Array.isArray(response.line_item_ids) || response.line_item_ids.length === 0 ||
        response.line_item_ids.length > MAX_CART_RESTORE_ITEMS) {
        return false;
    }

    return response.line_item_ids.every(value => {
        if (typeof value === 'string') return /^\d+$/.test(value) && value !== '0';
        return Number.isSafeInteger(value) && value > 0;
    });
}

export function validateCartRestorePayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return { valid: false, error: 'Invalid restore payload' };
    }

    const { token, items, countryCode } = payload;
    const remainingItems = payload.remainingItems ?? [];
    const sourceTag = payload.sourceTag || 'main-cluster-topseller';

    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH || token !== token.trim()) {
        return { valid: false, error: 'Invalid Steam token' };
    }
    if (typeof countryCode !== 'string' || !COUNTRY_CODE_PATTERN.test(countryCode)) {
        return { valid: false, error: 'Invalid Steam country code' };
    }
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_CART_RESTORE_ITEMS) {
        return { valid: false, error: 'Invalid restore item count' };
    }
    if (!Array.isArray(remainingItems) ||
        remainingItems.length > MAX_CART_RESTORE_ITEMS ||
        items.length + remainingItems.length > MAX_CART_RESTORE_ITEMS) {
        return { valid: false, error: 'Invalid remaining item count' };
    }
    if (typeof sourceTag !== 'string' || sourceTag.length > MAX_SOURCE_TAG_LENGTH || !SOURCE_TAG_PATTERN.test(sourceTag)) {
        return { valid: false, error: 'Invalid source tag' };
    }

    const normalizedItems = [];
    for (const item of items) {
        if (!isValidCartItem(item)) {
            return { valid: false, error: 'Invalid restore item' };
        }
        normalizedItems.push({ id: item.id, type: item.type });
    }

    const normalizedRemainingItems = [];
    for (const item of remainingItems) {
        if (!isValidCartItem(item)) {
            return { valid: false, error: 'Invalid remaining item' };
        }
        normalizedRemainingItems.push({ id: item.id, type: item.type });
    }

    return {
        valid: true,
        value: {
            token,
            items: normalizedItems,
            remainingItems: normalizedRemainingItems,
            countryCode,
            sourceTag
        }
    };
}
