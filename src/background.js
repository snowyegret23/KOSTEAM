/**
 * KOSTEAM Background Service Worker
 * Handles data fetching, caching, and message routing
 */

import {
    api,
    storageGet,
    storageSet,
    storageSessionGet,
    storageSessionSet,
    storageSessionRemove,
    permissionsGetAll,
    alarmCreate,
    alarmClear,
    onAlarm,
    onMessage,
    onInstalled,
    onStartup
} from './shared/api.js';

import {
    VERSION_URL,
    DATA_URL,
    ALIAS_URL,
    CACHE_KEY,
    CACHE_ALIAS_KEY,
    CACHE_VERSION_KEY,
    LAST_UPDATE_CHECK_KEY,
    UPDATE_INTERVAL_MINUTES,
    MS_PER_MINUTE,
    CART_FEATURE_KEY,
    CART_DATA_PERMISSIONS,
    CART_RESTORE_SECRET_KEY,
    CART_RESTORE_EXPIRY_ALARM,
    CART_RESTORE_SECRET_TTL_MS,
    PENDING_CART_RESTORE_KEY,
    CART_PURCHASE_COMPLETE_KEY,
    DEFAULT_SETTINGS,
    MSG_GET_PATCH_INFO,
    MSG_REFRESH_DATA,
    MSG_CHECK_UPDATE_STATUS,
    MSG_RESTORE_CART,
    MSG_SAVE_CART_RESTORE,
    MSG_RESTORE_PENDING_CART,
    MSG_RECOVER_CART,
    MSG_MARK_CART_CHECKOUT_STARTED,
    MSG_MARK_CART_PURCHASE_COMPLETE,
    MSG_CLEAR_CART_RESTORE,
    MSG_SET_CART_FEATURE
} from './shared/constants.js';

import {
    isValidAddItemsResponse,
    isValidCartItem,
    isValidTransactionId,
    MAX_CART_RESTORE_ITEMS,
    validateCartRestorePayload
} from './shared/restore-validation.js';

const MAX_VERSION_BYTES = 64 * 1024;
const MAX_LOOKUP_BYTES = 5 * 1024 * 1024;
const MAX_ALIAS_BYTES = 256 * 1024;
const MAX_CART_API_RESPONSE_BYTES = 1024 * 1024;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const KNOWN_SOURCES = new Set(['steamapp', 'quasarplay', 'directg', 'stove']);

async function readJsonResponse(response, maxBytes) {
    const declaredHeader = response.headers.get('content-length');
    if (declaredHeader !== null) {
        const declaredLength = Number(declaredHeader);
        if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > maxBytes) {
            throw new Error('Invalid response size');
        }
    }

    let bytes;
    if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                total += value.byteLength;
                if (total > maxBytes) throw new Error('Response is too large');
                chunks.push(value);
            }
        } catch (err) {
            await reader.cancel().catch(() => {});
            throw err;
        }

        bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
    } else {
        bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > maxBytes) throw new Error('Response is too large');
    }

    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { value: JSON.parse(text), bytes };
}

async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateVersionInfo(version) {
    return isPlainObject(version) &&
        typeof version.generated_at === 'string' &&
        typeof version.alias_updated_at === 'string' &&
        Number.isSafeInteger(version.total) &&
        version.total >= 0 &&
        version.total <= 100000 &&
        HASH_PATTERN.test(version.lookup_sha256) &&
        HASH_PATTERN.test(version.alias_sha256) &&
        Number.isSafeInteger(version.lookup_size) &&
        version.lookup_size > 0 &&
        version.lookup_size <= MAX_LOOKUP_BYTES &&
        Number.isSafeInteger(version.alias_size) &&
        version.alias_size >= 0 &&
        version.alias_size <= MAX_ALIAS_BYTES;
}

function validateLookupData(data, version) {
    if (!isPlainObject(data) || !isPlainObject(data._meta)) return false;
    if (data._meta.generated_at !== version.generated_at || data._meta.total !== version.total) return false;

    const entries = Object.entries(data).filter(([key]) => key !== '_meta');
    if (entries.length !== version.total) return false;

    for (const [appId, info] of entries) {
        if (!/^\d+$/.test(appId) || !isPlainObject(info)) return false;
        if (info.type !== 'official' && info.type !== 'user') return false;
        if (!Array.isArray(info.sources) || info.sources.some(source => !KNOWN_SOURCES.has(source))) return false;
        if (!Array.isArray(info.links) || !Array.isArray(info.patch_descriptions) || !Array.isArray(info.patch_sources)) return false;
        if (info.links.length > 100 || info.patch_descriptions.length > 100 || info.patch_sources.length > 100) return false;
        if (info.links.some(value => typeof value !== 'string' || value.length > 2048)) return false;
        if (info.patch_descriptions.some(value => typeof value !== 'string' || value.length > 4096)) return false;
        if (info.patch_sources.some(value => !KNOWN_SOURCES.has(value))) return false;
        if (!isPlainObject(info.source_site_urls)) return false;
        const siteUrls = Object.entries(info.source_site_urls);
        if (siteUrls.length > KNOWN_SOURCES.size) return false;
        if (siteUrls.some(([source, url]) => !KNOWN_SOURCES.has(source) || typeof url !== 'string' || url.length > 2048)) return false;
    }
    return true;
}

function validateAliasData(alias) {
    if (!isPlainObject(alias) || Object.keys(alias).length > 100000) return false;
    return Object.entries(alias).every(([from, to]) => /^\d+$/.test(from) && typeof to === 'string' && /^\d+$/.test(to));
}

async function verifyRemotePayload(response, expectedSize, expectedHash, maxBytes) {
    const { value, bytes } = await readJsonResponse(response, maxBytes);
    if (bytes.byteLength !== expectedSize) throw new Error('Remote data size mismatch');
    if (await sha256Hex(bytes) !== expectedHash) throw new Error('Remote data hash mismatch');
    return value;
}

/**
 * Fetch remote version info
 * @returns {Promise<Object|null>} Version info or null on error
 */
async function getRemoteVersion() {
    try {
        const response = await fetch(VERSION_URL, { cache: 'no-store' });
        if (!response.ok) return null;
        const { value } = await readJsonResponse(response, MAX_VERSION_BYTES);
        return validateVersionInfo(value) ? value : null;
    } catch (err) {
        console.error('[KOSTEAM] Version fetch error:', err);
        return null;
    }
}

/**
 * Check for updates and fetch if new version available
 * @returns {Promise<Object|null>} Updated data or null
 */
async function checkForUpdates() {
    try {
        const remoteVersion = await getRemoteVersion();
        if (!remoteVersion) return null;

        const local = await storageGet([CACHE_VERSION_KEY]);
        const localVersion = local[CACHE_VERSION_KEY];

        if (checkNeedsUpdate(localVersion, remoteVersion)) {
            console.log('[KOSTEAM] New version detected, updating...');
            return await fetchData(remoteVersion);
        }

        return null;
    } catch (err) {
        console.error('[KOSTEAM] Update check failed:', err);
        return null;
    }
}

/**
 * Fetch and cache lookup and alias data
 * @param {Object} versionInfo - Version metadata
 * @returns {Promise<Object|null>} Fetched data or null on error
 */
async function fetchData(versionInfo) {
    try {
        const [dataRes, aliasRes] = await Promise.all([
            fetch(DATA_URL, { cache: 'no-store' }),
            fetch(ALIAS_URL, { cache: 'no-store' })
        ]);

        if (!dataRes.ok) throw new Error(`Data fetch failed: ${dataRes.status}`);
        if (!aliasRes.ok) throw new Error(`Alias fetch failed: ${aliasRes.status}`);

        const [data, alias] = await Promise.all([
            verifyRemotePayload(dataRes, versionInfo.lookup_size, versionInfo.lookup_sha256, MAX_LOOKUP_BYTES),
            verifyRemotePayload(aliasRes, versionInfo.alias_size, versionInfo.alias_sha256, MAX_ALIAS_BYTES)
        ]);

        if (!validateLookupData(data, versionInfo)) throw new Error('Invalid lookup schema');
        if (!validateAliasData(alias)) throw new Error('Invalid alias schema');

        await storageSet({
            [CACHE_KEY]: data,
            [CACHE_ALIAS_KEY]: alias,
            [CACHE_VERSION_KEY]: versionInfo
        });

        console.log(`[KOSTEAM] Updated: ${versionInfo.total} games`);
        return data;
    } catch (err) {
        console.error('[KOSTEAM] Data fetch failed:', err);
        return null;
    }
}

/**
 * Get cached data and alias mappings
 * Automatically checks for updates if enough time has passed (lazy update)
 * @returns {Promise<{data: Object, alias: Object}>}
 */
async function getData() {
    const result = await storageGet([CACHE_KEY, CACHE_ALIAS_KEY, LAST_UPDATE_CHECK_KEY]);

    // Check if we need to update (lazy update pattern)
    const lastCheck = result[LAST_UPDATE_CHECK_KEY] || 0;
    const now = Date.now();
    const updateInterval = UPDATE_INTERVAL_MINUTES * MS_PER_MINUTE;

    if (now - lastCheck > updateInterval) {
        // Don't wait for update - return current data immediately
        // Update happens in background
        checkForUpdates().then(() => {
            storageSet({ [LAST_UPDATE_CHECK_KEY]: now });
        }).catch(err => {
            console.error('[KOSTEAM] Background update failed:', err);
        });
    }

    return {
        data: result[CACHE_KEY] || {},
        alias: result[CACHE_ALIAS_KEY] || {}
    };
}

/**
 * Validate message format and required fields
 * @param {Object} message - Message object
 * @param {string[]} requiredFields - Required field names
 * @returns {{valid: boolean, error?: string}}
 */
function validateMessage(message, requiredFields = []) {
    if (!message || typeof message !== 'object') {
        return { valid: false, error: 'Invalid message format' };
    }
    if (typeof message.type !== 'string') {
        return { valid: false, error: 'Invalid message type' };
    }
    for (const field of requiredFields) {
        if (message[field] === undefined || message[field] === null) {
            return { valid: false, error: `Missing required field: ${field}` };
        }
    }
    return { valid: true };
}

/**
 * Validate appId format (should be numeric string or number)
 * @param {*} appId - App ID to validate
 * @returns {boolean}
 */
function isValidAppId(appId) {
    if (typeof appId === 'number') return Number.isInteger(appId) && appId > 0;
    if (typeof appId === 'string') return /^\d+$/.test(appId);
    return false;
}

/**
 * Check if update is needed by comparing versions
 * @param {Object|null} localVersion - Local version info
 * @param {Object} remoteVersion - Remote version info
 * @returns {boolean}
 */
function checkNeedsUpdate(localVersion, remoteVersion) {
    return !validateVersionInfo(localVersion) ||
        localVersion.generated_at !== remoteVersion.generated_at ||
        localVersion.alias_updated_at !== remoteVersion.alias_updated_at;
}

function encodeVarint(value) {
    const bytes = [];
    let val = value >>> 0;
    while (val >= 0x80) {
        bytes.push((val & 0x7f) | 0x80);
        val >>>= 7;
    }
    bytes.push(val);
    return Uint8Array.from(bytes);
}

function encodeLengthDelimited(fieldNumber, text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const lengthBytes = encodeVarint(data.length);
    return Uint8Array.from([fieldNumber, ...lengthBytes, ...data]);
}

/**
 * Build protobuf for adding item to cart
 * @param {number} itemId - Package ID or Bundle ID
 * @param {string} sourceTag - Source tag for tracking
 * @param {string} itemType - 'package' or 'bundle'
 * @param {string} countryCode - Steam account country code
 * @returns {Uint8Array}
 */
function buildInputProtobuf(itemId, sourceTag, itemType, countryCode) {
    const field1 = encodeLengthDelimited(0x0a, countryCode);
    const itemVarint = encodeVarint(itemId);
    // Package uses field number 1 (0x08), Bundle uses field number 2 (0x10)
    const fieldTag = itemType === 'bundle' ? 0x10 : 0x08;
    const itemSub = Uint8Array.from([fieldTag, ...itemVarint]);
    const field2 = Uint8Array.from([0x12, itemSub.length, ...itemSub]);

    const subParts = [
        encodeLengthDelimited(0x0a, 'store.steampowered.com'),
        encodeLengthDelimited(0x12, 'default'),
        encodeLengthDelimited(0x1a, 'default'),
        Uint8Array.from([0x22, 0x00]),
        encodeLengthDelimited(0x2a, sourceTag || 'main-cluster-topseller'),
        Uint8Array.from([0x30, 0x01]),
        encodeLengthDelimited(0x3a, countryCode),
        Uint8Array.from([0x48, 0x00]),
        Uint8Array.from([0x52, 0x00]),
        Uint8Array.from([0x58, 0x00]),
        Uint8Array.from([0x60, 0x00])
    ];
    const subLength = subParts.reduce((sum, part) => sum + part.length, 0);
    const subMessage = new Uint8Array(subLength);
    let offset = 0;
    for (const part of subParts) {
        subMessage.set(part, offset);
        offset += part.length;
    }

    const field3Header = Uint8Array.from([0x1a, ...encodeVarint(subMessage.length)]);
    const totalLength = field1.length + field2.length + field3Header.length + subMessage.length;
    const result = new Uint8Array(totalLength);
    let pos = 0;
    result.set(field1, pos); pos += field1.length;
    result.set(field2, pos); pos += field2.length;
    result.set(field3Header, pos); pos += field3Header.length;
    result.set(subMessage, pos);
    return result;
}

function toBase64(bytes) {
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

function buildFormData(base64Payload, accessToken) {
    const form = new FormData();
    form.append('input_protobuf_encoded', base64Payload);
    if (accessToken) form.append('access_token', accessToken);
    return form;
}

function isOwnSender(sender) {
    return !!sender && sender.id === api.runtime.id;
}

function getSenderUrl(sender) {
    try {
        return new URL(sender.url);
    } catch {
        return null;
    }
}

function isStoreCartSender(sender) {
    const url = getSenderUrl(sender);
    return isOwnSender(sender) &&
        url?.protocol === 'https:' &&
        url.hostname === 'store.steampowered.com' &&
        (url.pathname === '/cart' || url.pathname.startsWith('/cart/'));
}

function isPendingRestoreSender(sender) {
    const url = getSenderUrl(sender);
    if (!isOwnSender(sender) || url?.protocol !== 'https:') return false;
    return url.hostname === 'store.steampowered.com' ||
        (url.hostname === 'checkout.steampowered.com' &&
            (url.pathname === '/checkout' || url.pathname.startsWith('/checkout/')));
}

async function hasCartDataConsent() {
    try {
        const permissions = await permissionsGetAll();
        if (!Object.prototype.hasOwnProperty.call(permissions, 'data_collection')) return true;
        return Array.isArray(permissions.data_collection) &&
            CART_DATA_PERMISSIONS.every(permission => permissions.data_collection.includes(permission));
    } catch {
        return false;
    }
}

async function isCartFeatureEnabled() {
    const settings = await storageGet([CART_FEATURE_KEY]);
    return settings[CART_FEATURE_KEY] === true;
}

const CART_API_REQUEST_TIMEOUT_MS = 30000;
const CART_API_OPERATION_TIMEOUT_MS = 5 * MS_PER_MINUTE;
let cartRestoreQueue = Promise.resolve();
let activeCartRequestController = null;
let cartOperationCancelled = false;
let cartFeatureEpoch = 0;
let cartFeatureDisableRequested = false;

function withCartRestoreLock(task) {
    const run = cartRestoreQueue.then(task, task);
    cartRestoreQueue = run.then(() => undefined, () => undefined);
    return run;
}

function isCheckoutSender(sender) {
    const url = getSenderUrl(sender);
    return isOwnSender(sender) &&
        url?.protocol === 'https:' &&
        url.hostname === 'checkout.steampowered.com' &&
        (url.pathname === '/checkout' || url.pathname.startsWith('/checkout/'));
}

function isExtensionPageSender(sender) {
    const url = getSenderUrl(sender);
    try {
        return isOwnSender(sender) && url?.origin === new URL(api.runtime.getURL('/')).origin;
    } catch {
        return false;
    }
}

function getSenderTabId(sender) {
    const tabId = sender?.tab?.id;
    return Number.isInteger(tabId) && tabId >= 0 ? tabId : null;
}

function isActiveSecretOwnedByOtherTab(secret, transactionId, senderTabId) {
    return secret?.transactionId === transactionId &&
        Number.isFinite(secret.expiresAt) &&
        Date.now() < secret.expiresAt &&
        secret.ownerTabId !== senderTabId;
}

function cancelActiveCartOperation() {
    cartOperationCancelled = true;
    activeCartRequestController?.abort();
}

async function runCartApiOperation(task) {
    if (cartFeatureDisableRequested) {
        return { success: false, error: 'Cart feature disable is pending' };
    }
    cartOperationCancelled = false;
    try {
        return await task();
    } finally {
        activeCartRequestController = null;
        cartOperationCancelled = false;
    }
}

function removeFirstCartItem(items, target) {
    const index = items.findIndex(item => item?.id === target.id && item?.type === target.type);
    if (index < 0) return [...items];
    return [...items.slice(0, index), ...items.slice(index + 1)];
}

function sanitizePendingRestore(pending) {
    if (!pending || typeof pending !== 'object' || Array.isArray(pending)) return pending;
    if (!Object.prototype.hasOwnProperty.call(pending, 'token')) return pending;
    const sanitized = { ...pending };
    delete sanitized.token;
    return sanitized;
}

function normalizeRecoveryTarget(items) {
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_CART_RESTORE_ITEMS ||
        !items.every(isValidCartItem)) {
        return null;
    }
    return items.map(item => ({ id: item.id, type: item.type }));
}

function isValidRecoveryRevision(value) {
    return Number.isSafeInteger(value) && value >= 0 && value < 1000000000;
}

async function invalidateRecoveryAttempt(pending) {
    const updated = {
        ...pending,
        recoveryRevision: pending.recoveryRevision + 1
    };
    await storageSet({ [PENDING_CART_RESTORE_KEY]: updated });
    return updated;
}

async function persistRestoreProgress(pending, completedItem) {
    const removedItems = removeFirstCartItem(
        Array.isArray(pending?.removedItems) ? pending.removedItems : [],
        completedItem
    );
    const updated = {
        ...sanitizePendingRestore(pending),
        removedItems
    };
    await storageSet({ [PENDING_CART_RESTORE_KEY]: updated });
    return updated;
}

async function addItemsToSteamCart(payload, options = {}) {
    const validation = validateCartRestorePayload(payload);
    if (!validation.valid) return { success: false, error: validation.error };

    const { token, items, sourceTag, countryCode } = validation.value;
    const operationDeadline = Math.min(
        Number.isFinite(options.deadline) ? options.deadline : Number.POSITIVE_INFINITY,
        Date.now() + CART_API_OPERATION_TIMEOUT_MS
    );

    let completedCount = 0;
    for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (cartOperationCancelled) {
            return { success: false, error: 'Cart operation cancelled', completedCount };
        }
        if (Date.now() >= operationDeadline) {
            return { success: false, error: options.deadlineError || 'Cart API operation timed out', completedCount };
        }

        const protobufBytes = buildInputProtobuf(item.id, sourceTag, item.type, countryCode);
        const base64Payload = toBase64(protobufBytes);
        const controller = new AbortController();
        activeCartRequestController = controller;
        const requestTimeout = Math.max(1, Math.min(
            CART_API_REQUEST_TIMEOUT_MS,
            operationDeadline - Date.now()
        ));
        const timeoutTimer = setTimeout(() => controller.abort(), requestTimeout);

        try {
            const response = await fetch('https://api.steampowered.com/IAccountCartService/AddItemsToCart/v1', {
                method: 'POST',
                body: buildFormData(base64Payload, token),
                credentials: 'omit',
                redirect: 'error',
                signal: controller.signal
            });

            if (!response.ok) return { success: false, error: `HTTP ${response.status}`, completedCount };

            const { value: parsed } = await readJsonResponse(response, MAX_CART_API_RESPONSE_BYTES);
            if (!isValidAddItemsResponse(parsed)) {
                return { success: false, error: 'Invalid Cart API response', completedCount };
            }
        } catch (err) {
            const error = err?.name === 'AbortError'
                ? (cartOperationCancelled ? 'Cart operation cancelled' : 'Cart API request timed out')
                : 'Cart API request failed';
            return { success: false, error, completedCount };
        } finally {
            clearTimeout(timeoutTimer);
            if (activeCartRequestController === controller) activeCartRequestController = null;
        }

        completedCount++;
        if (options.onItemAdded) {
            await options.onItemAdded(item, items.slice(index + 1));
        }
    }

    return { success: true, completedCount };
}

async function clearCartRestoreStateUnlocked() {
    await Promise.all([
        storageSessionRemove([CART_RESTORE_SECRET_KEY]),
        alarmClear(CART_RESTORE_EXPIRY_ALARM),
        storageSet({
            [PENDING_CART_RESTORE_KEY]: null,
            [CART_PURCHASE_COMPLETE_KEY]: null
        })
    ]);
    return { success: true };
}

async function discardCartRestoreSecretUnlocked() {
    await Promise.all([
        storageSessionRemove([CART_RESTORE_SECRET_KEY]),
        alarmClear(CART_RESTORE_EXPIRY_ALARM)
    ]);
    return { success: true };
}

function clearCartRestoreStateForMessage(message, senderTabId) {
    return withCartRestoreLock(async () => {
        const [localState, sessionState] = await Promise.all([
            storageGet([PENDING_CART_RESTORE_KEY]),
            storageSessionGet([CART_RESTORE_SECRET_KEY])
        ]);
        const pending = localState[PENDING_CART_RESTORE_KEY];
        if (!pending ||
            !isValidTransactionId(message.transactionId) ||
            !isValidRecoveryRevision(message.recoveryRevision) ||
            pending.transactionId !== message.transactionId ||
            pending.recoveryRevision !== message.recoveryRevision) {
            return { success: false, error: 'Restore transaction does not match' };
        }
        if (pending?.transactionId && isActiveSecretOwnedByOtherTab(
            sessionState[CART_RESTORE_SECRET_KEY],
            pending.transactionId,
            senderTabId
        )) {
            return { success: false, error: 'Restore transaction is active in another tab' };
        }
        return clearCartRestoreStateUnlocked();
    });
}

function setCartFeatureEnabled(enabled) {
    return withCartRestoreLock(async () => {
        if (enabled) {
            if (!await hasCartDataConsent()) {
                return { success: false, error: 'Cart data permission is required' };
            }
            await storageSet({ [CART_FEATURE_KEY]: true });
            cartFeatureDisableRequested = false;
            return { success: true, preserved: false };
        }

        const localState = await storageGet([PENDING_CART_RESTORE_KEY]);
        const pending = sanitizePendingRestore(localState[PENDING_CART_RESTORE_KEY]);
        const preserveRecovery = pending?.autoRestore === true &&
            isValidTransactionId(pending.transactionId) &&
            Array.isArray(pending.originalRemovedItems);

        if (preserveRecovery) {
            await Promise.all([
                storageSet({ [CART_FEATURE_KEY]: false }),
                discardCartRestoreSecretUnlocked()
            ]);
        } else {
            await Promise.all([
                storageSet({ [CART_FEATURE_KEY]: false }),
                clearCartRestoreStateUnlocked()
            ]);
        }
        return { success: true, preserved: preserveRecovery };
    });
}

function saveCartRestoreTransaction(message, ownerTabId) {
    return withCartRestoreLock(async () => {
        if (ownerTabId === null) return { success: false, error: 'Cart tab identity is unavailable' };
        if (cartFeatureDisableRequested) return { success: false, error: 'Cart feature disable is pending' };
        const featureEpoch = cartFeatureEpoch;
        const featureEnabled = await isCartFeatureEnabled();
        if (!featureEnabled || featureEpoch !== cartFeatureEpoch || cartFeatureDisableRequested) {
            return { success: false, error: 'Cart feature is disabled' };
        }
        if (!await hasCartDataConsent()) return { success: false, error: 'Cart data permission is required' };

        const validation = validateCartRestorePayload(message);
        if (!validation.valid) return { success: false, error: validation.error };

        const [sessionState, localState] = await Promise.all([
            storageSessionGet([CART_RESTORE_SECRET_KEY]),
            storageGet([PENDING_CART_RESTORE_KEY])
        ]);
        if (sessionState[CART_RESTORE_SECRET_KEY] || localState[PENDING_CART_RESTORE_KEY]) {
            return { success: false, error: 'A cart restore transaction is already active' };
        }

        const transactionId = crypto.randomUUID();
        const savedAt = Date.now();
        const secret = {
            ...validation.value,
            transactionId,
            ownerTabId,
            expiresAt: savedAt + CART_RESTORE_SECRET_TTL_MS
        };

        await storageSessionSet({ [CART_RESTORE_SECRET_KEY]: secret });
        try {
            await storageSet({
                [PENDING_CART_RESTORE_KEY]: {
                    autoRestore: true,
                    phase: 'prepared',
                    removedItems: validation.value.items,
                    originalRemovedItems: validation.value.items,
                    remainingItems: validation.value.remainingItems,
                    transactionId,
                    recoveryRevision: 0
                },
                [CART_PURCHASE_COMPLETE_KEY]: null
            });
            await alarmCreate(CART_RESTORE_EXPIRY_ALARM, { when: secret.expiresAt });
        } catch (err) {
            await Promise.allSettled([
                storageSessionRemove([CART_RESTORE_SECRET_KEY]),
                alarmClear(CART_RESTORE_EXPIRY_ALARM),
                storageSet({
                    [PENDING_CART_RESTORE_KEY]: null,
                    [CART_PURCHASE_COMPLETE_KEY]: null
                })
            ]);
            throw err;
        }

        const stillEnabled = await isCartFeatureEnabled();
        if (!stillEnabled || featureEpoch !== cartFeatureEpoch || cartFeatureDisableRequested) {
            await clearCartRestoreStateUnlocked();
            return { success: false, error: 'Cart feature was disabled during transaction setup' };
        }

        return { success: true, transactionId, recoveryRevision: 0 };
    });
}

function restorePendingCart(transactionId, recoveryRevision, senderTabId) {
    return withCartRestoreLock(async () => runCartApiOperation(async () => {
        if (!isValidTransactionId(transactionId)) return { success: false, error: 'Invalid restore transaction' };
        if (!isValidRecoveryRevision(recoveryRevision)) return { success: false, error: 'Invalid recovery revision' };
        if (!await isCartFeatureEnabled()) return { success: false, error: 'Cart feature is disabled' };
        if (!await hasCartDataConsent()) return { success: false, error: 'Cart data permission is required' };

        const [sessionState, localState] = await Promise.all([
            storageSessionGet([CART_RESTORE_SECRET_KEY]),
            storageGet([PENDING_CART_RESTORE_KEY, CART_PURCHASE_COMPLETE_KEY])
        ]);
        const secret = sessionState[CART_RESTORE_SECRET_KEY];
        let pending = sanitizePendingRestore(localState[PENDING_CART_RESTORE_KEY]);
        const purchaseMarker = localState[CART_PURCHASE_COMPLETE_KEY];
        if (!secret ||
            secret.transactionId !== transactionId ||
            secret.ownerTabId !== senderTabId ||
            pending?.transactionId !== transactionId ||
            pending.phase !== 'checkout_started_unknown' ||
            pending.recoveryRevision !== recoveryRevision ||
            purchaseMarker?.transactionId !== transactionId) {
            return { success: false, error: 'Restore session is unavailable' };
        }
        if (!Number.isFinite(secret.expiresAt) || Date.now() >= secret.expiresAt) {
            await Promise.all([
                storageSessionRemove([CART_RESTORE_SECRET_KEY]),
                alarmClear(CART_RESTORE_EXPIRY_ALARM)
            ]);
            return { success: false, error: 'Restore session expired' };
        }

        const restorePayload = {
            ...secret,
            items: Array.isArray(pending.removedItems) ? pending.removedItems : []
        };
        if (restorePayload.items.length === 0) return clearCartRestoreStateUnlocked();
        pending = {
            ...pending,
            recoveryRevision: recoveryRevision + 1,
            phase: 'recovery_requires_cart'
        };
        await storageSet({ [PENDING_CART_RESTORE_KEY]: pending });
        let result;
        try {
            result = await addItemsToSteamCart(restorePayload, {
                deadline: secret.expiresAt,
                deadlineError: 'Restore session expired',
                onItemAdded: async (item, remainingItems) => {
                    pending = await persistRestoreProgress(pending, item);
                    if (remainingItems.length > 0) {
                        await storageSessionSet({
                            [CART_RESTORE_SECRET_KEY]: { ...secret, items: remainingItems }
                        });
                    } else {
                        await storageSessionRemove([CART_RESTORE_SECRET_KEY]);
                    }
                }
            });
        } catch (err) {
            pending = await invalidateRecoveryAttempt(pending);
            await discardCartRestoreSecretUnlocked();
            throw err;
        }

        if (result.success) return clearCartRestoreStateUnlocked();
        pending = await invalidateRecoveryAttempt(pending);
        await discardCartRestoreSecretUnlocked();
        return result;
    }));
}

function recoverCartWithFreshToken(message, senderTabId) {
    return withCartRestoreLock(async () => runCartApiOperation(async () => {
        if (!await isCartFeatureEnabled()) return { success: false, error: 'Cart feature is disabled' };
        if (!await hasCartDataConsent()) return { success: false, error: 'Cart data permission is required' };

        const validation = validateCartRestorePayload(message);
        if (!validation.valid) return { success: false, error: validation.error };

        const [localState, sessionState] = await Promise.all([
            storageGet([PENDING_CART_RESTORE_KEY]),
            storageSessionGet([CART_RESTORE_SECRET_KEY])
        ]);
        let pending = sanitizePendingRestore(localState[PENDING_CART_RESTORE_KEY]);
        if (!isValidTransactionId(message.transactionId) ||
            !isValidRecoveryRevision(message.recoveryRevision) ||
            !pending ||
            pending.transactionId !== message.transactionId ||
            pending.recoveryRevision !== message.recoveryRevision) {
            return { success: false, error: 'Restore metadata is unavailable' };
        }
        if (isActiveSecretOwnedByOtherTab(
            sessionState[CART_RESTORE_SECRET_KEY],
            pending.transactionId,
            senderTabId
        )) {
            return { success: false, error: 'Restore transaction is active in another tab' };
        }

        const recoveryTarget = message.recoveryTargetItems === undefined
            ? null
            : normalizeRecoveryTarget(message.recoveryTargetItems);
        if (message.recoveryTargetItems !== undefined && !recoveryTarget) {
            return { success: false, error: 'Invalid recovery target' };
        }
        if (pending.phase !== 'prepared' && !recoveryTarget) {
            return { success: false, error: 'Recovery target is required' };
        }

        pending = {
            ...pending,
            recoveryRevision: message.recoveryRevision + 1,
            ...(recoveryTarget ? {
                phase: 'recovery_in_progress',
                recoveryTargetItems: recoveryTarget
            } : {})
        };
        await storageSet({ [PENDING_CART_RESTORE_KEY]: pending });

        await Promise.all([
            storageSessionRemove([CART_RESTORE_SECRET_KEY]),
            alarmClear(CART_RESTORE_EXPIRY_ALARM)
        ]);

        let result;
        try {
            result = await addItemsToSteamCart(validation.value, {
                onItemAdded: async item => {
                    pending = await persistRestoreProgress(pending, item);
                }
            });
        } catch (err) {
            pending = await invalidateRecoveryAttempt(pending);
            throw err;
        }
        if (result.success) return clearCartRestoreStateUnlocked();
        pending = await invalidateRecoveryAttempt(pending);
        return result;
    }));
}

function markCartCheckoutStarted(transactionId, recoveryRevision, senderTabId) {
    return withCartRestoreLock(async () => {
        const featureEpoch = cartFeatureEpoch;
        const featureEnabled = await isCartFeatureEnabled();
        if (!featureEnabled || featureEpoch !== cartFeatureEpoch || cartFeatureDisableRequested) {
            return { success: false, error: 'Cart feature is disabled' };
        }
        if (!isValidTransactionId(transactionId) || !isValidRecoveryRevision(recoveryRevision)) {
            return { success: false, error: 'Invalid restore transaction' };
        }
        const [localState, sessionState] = await Promise.all([
            storageGet([PENDING_CART_RESTORE_KEY]),
            storageSessionGet([CART_RESTORE_SECRET_KEY])
        ]);
        const pending = sanitizePendingRestore(localState[PENDING_CART_RESTORE_KEY]);
        if (!pending ||
            pending.transactionId !== transactionId ||
            pending.recoveryRevision !== recoveryRevision ||
            pending.phase !== 'prepared') {
            return { success: false, error: 'Restore metadata is unavailable' };
        }
        const secret = sessionState[CART_RESTORE_SECRET_KEY];
        if (!secret || secret.transactionId !== transactionId ||
            secret.ownerTabId !== senderTabId ||
            !Number.isFinite(secret.expiresAt) || Date.now() >= secret.expiresAt) {
            return { success: false, error: 'Restore transaction is not owned by this tab' };
        }
        if (featureEpoch !== cartFeatureEpoch || cartFeatureDisableRequested) {
            return { success: false, error: 'Cart feature was disabled before checkout' };
        }
        await storageSet({
            [PENDING_CART_RESTORE_KEY]: {
                ...pending,
                phase: 'checkout_started_unknown'
            }
        });
        if (featureEpoch !== cartFeatureEpoch || cartFeatureDisableRequested) {
            await storageSet({
                [PENDING_CART_RESTORE_KEY]: {
                    ...pending,
                    phase: 'prepared'
                }
            });
            return { success: false, error: 'Cart feature was disabled before checkout' };
        }
        return { success: true };
    });
}

function markCartPurchaseComplete(transactionId, recoveryRevision, senderTabId) {
    return withCartRestoreLock(async () => {
        if (!isValidTransactionId(transactionId) || !isValidRecoveryRevision(recoveryRevision)) {
            return { success: false, error: 'Invalid restore transaction' };
        }
        const [localState, sessionState] = await Promise.all([
            storageGet([PENDING_CART_RESTORE_KEY]),
            storageSessionGet([CART_RESTORE_SECRET_KEY])
        ]);
        const pending = sanitizePendingRestore(localState[PENDING_CART_RESTORE_KEY]);
        const secret = sessionState[CART_RESTORE_SECRET_KEY];
        if (!pending ||
            pending.transactionId !== transactionId ||
            pending.recoveryRevision !== recoveryRevision ||
            pending.phase !== 'checkout_started_unknown') {
            return { success: false, error: 'Restore metadata is unavailable' };
        }
        if (!secret ||
            secret.transactionId !== transactionId ||
            secret.ownerTabId !== senderTabId ||
            !Number.isFinite(secret.expiresAt) || Date.now() >= secret.expiresAt) {
            return { success: false, error: 'Restore transaction is not owned by this checkout tab' };
        }

        const marker = {
            transactionId,
            completedAt: new Date().toISOString()
        };
        await storageSet({ [CART_PURCHASE_COMPLETE_KEY]: marker });
        return { success: true, marker };
    });
}

function restoreCartDirectly(message) {
    return withCartRestoreLock(async () => runCartApiOperation(async () => {
        if (!await isCartFeatureEnabled()) return { success: false, error: 'Cart feature is disabled' };
        if (!await hasCartDataConsent()) return { success: false, error: 'Cart data permission is required' };
        const [localState, sessionState] = await Promise.all([
            storageGet([PENDING_CART_RESTORE_KEY]),
            storageSessionGet([CART_RESTORE_SECRET_KEY])
        ]);
        if (localState[PENDING_CART_RESTORE_KEY] || sessionState[CART_RESTORE_SECRET_KEY]) {
            return { success: false, error: 'A cart restore transaction is already active' };
        }
        return addItemsToSteamCart(message);
    }));
}

function expireCartRestoreSecret() {
    return withCartRestoreLock(async () => {
        const [sessionState, localState] = await Promise.all([
            storageSessionGet([CART_RESTORE_SECRET_KEY]),
            storageGet([PENDING_CART_RESTORE_KEY])
        ]);
        const secret = sessionState[CART_RESTORE_SECRET_KEY];
        const pending = localState[PENDING_CART_RESTORE_KEY];
        const sanitized = sanitizePendingRestore(pending);
        if (pending && sanitized !== pending) {
            await storageSet({ [PENDING_CART_RESTORE_KEY]: sanitized });
        }

        if (!secret) {
            await alarmClear(CART_RESTORE_EXPIRY_ALARM);
            return;
        }
        if (Number.isFinite(secret.expiresAt) && Date.now() < secret.expiresAt) {
            await alarmCreate(CART_RESTORE_EXPIRY_ALARM, { when: secret.expiresAt });
            return;
        }
        await Promise.all([
            storageSessionRemove([CART_RESTORE_SECRET_KEY]),
            alarmClear(CART_RESTORE_EXPIRY_ALARM)
        ]);
    });
}

onAlarm(alarm => {
    if (alarm?.name !== CART_RESTORE_EXPIRY_ALARM) return;
    expireCartRestoreSecret().catch(err => {
        console.error('[KOSTEAM] Restore expiry cleanup error:', err);
    });
});

// Message handler
onMessage((message, sender, sendResponse) => {
    // Basic message validation
    const baseValidation = validateMessage(message);
    if (!baseValidation.valid) {
        sendResponse({ success: false, error: baseValidation.error });
        return false;
    }
    if (!isOwnSender(sender)) {
        sendResponse({ success: false, error: 'Untrusted message sender' });
        return false;
    }

    if (message.type === MSG_GET_PATCH_INFO) {
        // Validate appId
        if (!isValidAppId(message.appId)) {
            sendResponse({ success: false, error: 'Invalid appId format' });
            return false;
        }

        getData().then(({ data, alias }) => {
            const appId = String(message.appId);
            const targetId = alias[appId] || appId;
            const info = data[targetId] || null;
            sendResponse({ success: true, info });
        }).catch(err => {
            console.error('[KOSTEAM] GET_PATCH_INFO error:', err);
            sendResponse({ success: false, error: err.message });
        });
        return true;
    }

    if (message.type === MSG_REFRESH_DATA) {
        (async () => {
            try {
                const remoteVersion = await getRemoteVersion();
                if (!remoteVersion) throw new Error('Remote version is unavailable');
                const data = await fetchData(remoteVersion);
                sendResponse({ success: !!data });
            } catch (err) {
                console.error('[KOSTEAM] REFRESH_DATA error:', err);
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    if (message.type === MSG_CHECK_UPDATE_STATUS) {
        (async () => {
            try {
                const local = await storageGet([CACHE_VERSION_KEY]);
                const remoteVersion = await getRemoteVersion();

                if (!remoteVersion) {
                    sendResponse({ success: false, error: 'Network error' });
                    return;
                }

                const localVersion = local[CACHE_VERSION_KEY];
                const needsUpdate = checkNeedsUpdate(localVersion, remoteVersion);

                sendResponse({
                    success: true,
                    needsUpdate,
                    localVersion,
                    remoteVersion
                });
            } catch (err) {
                console.error('[KOSTEAM] CHECK_UPDATE_STATUS error:', err);
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    if (message.type === MSG_SAVE_CART_RESTORE) {
        if (!isStoreCartSender(sender)) {
            sendResponse({ success: false, error: 'Untrusted cart sender' });
            return false;
        }

        saveCartRestoreTransaction(message, getSenderTabId(sender))
            .then(sendResponse)
            .catch(err => {
                console.error('[KOSTEAM] SAVE_CART_RESTORE error:', err);
                sendResponse({ success: false, error: err.message });
            });
        return true;
    }

    if (message.type === MSG_RESTORE_PENDING_CART) {
        if (!isPendingRestoreSender(sender)) {
            sendResponse({ success: false, error: 'Untrusted restore sender' });
            return false;
        }

        restorePendingCart(
            message.transactionId,
            message.recoveryRevision,
            getSenderTabId(sender)
        )
            .then(sendResponse)
            .catch(err => {
                console.error('[KOSTEAM] RESTORE_PENDING_CART error:', err);
                sendResponse({ success: false, error: err.message });
            });
        return true;
    }

    if (message.type === MSG_RECOVER_CART) {
        if (!isStoreCartSender(sender)) {
            sendResponse({ success: false, error: 'Untrusted cart recovery sender' });
            return false;
        }

        recoverCartWithFreshToken(message, getSenderTabId(sender))
            .then(sendResponse)
            .catch(err => {
                console.error('[KOSTEAM] RECOVER_CART error:', err);
                sendResponse({ success: false, error: err.message });
            });
        return true;
    }

    if (message.type === MSG_MARK_CART_CHECKOUT_STARTED) {
        if (!isStoreCartSender(sender)) {
            sendResponse({ success: false, error: 'Untrusted cart sender' });
            return false;
        }

        markCartCheckoutStarted(
            message.transactionId,
            message.recoveryRevision,
            getSenderTabId(sender)
        )
            .then(sendResponse)
            .catch(err => {
                console.error('[KOSTEAM] MARK_CART_CHECKOUT_STARTED error:', err);
                sendResponse({ success: false, error: err.message });
            });
        return true;
    }

    if (message.type === MSG_MARK_CART_PURCHASE_COMPLETE) {
        if (!isCheckoutSender(sender)) {
            sendResponse({ success: false, error: 'Untrusted checkout sender' });
            return false;
        }

        markCartPurchaseComplete(
            message.transactionId,
            message.recoveryRevision,
            getSenderTabId(sender)
        )
            .then(async marked => {
                if (!marked?.success) return marked;
                const restored = await restorePendingCart(
                    message.transactionId,
                    message.recoveryRevision,
                    getSenderTabId(sender)
                );
                return { ...restored, marker: marked.marker };
            })
            .then(sendResponse)
            .catch(err => {
                console.error('[KOSTEAM] MARK_CART_PURCHASE_COMPLETE error:', err);
                sendResponse({ success: false, error: err.message });
            });
        return true;
    }

    if (message.type === MSG_RESTORE_CART) {
        if (!isStoreCartSender(sender)) {
            sendResponse({ success: false, error: 'Untrusted cart sender' });
            return false;
        }

        restoreCartDirectly(message)
            .then(sendResponse)
            .catch(err => {
                console.error('[KOSTEAM] RESTORE_CART error:', err);
                sendResponse({ success: false, error: err.message });
            });
        return true;
    }

    if (message.type === MSG_CLEAR_CART_RESTORE) {
        if (!isStoreCartSender(sender)) {
            sendResponse({ success: false, error: 'Untrusted cart sender' });
            return false;
        }
        clearCartRestoreStateForMessage(message, getSenderTabId(sender))
            .then(sendResponse)
            .catch(err => {
                console.error('[KOSTEAM] CLEAR_CART_RESTORE error:', err);
                sendResponse({ success: false, error: err.message });
            });
        return true;
    }

    if (message.type === MSG_SET_CART_FEATURE) {
        if (!isExtensionPageSender(sender) || typeof message.enabled !== 'boolean') {
            sendResponse({ success: false, error: 'Untrusted cart feature change' });
            return false;
        }
        if (!message.enabled) {
            cartFeatureDisableRequested = true;
            cartFeatureEpoch++;
            cancelActiveCartOperation();
        }
        setCartFeatureEnabled(message.enabled)
            .then(sendResponse)
            .catch(err => {
                console.error('[KOSTEAM] SET_CART_FEATURE error:', err);
                sendResponse({ success: false, error: err.message });
            });
        return true;
    }

    return false;
});

// Initialize settings on installation
onInstalled(async () => {
    try {
        const current = await storageGet(Object.keys(DEFAULT_SETTINGS));
        const toSet = {};

        for (const key in DEFAULT_SETTINGS) {
            if (current[key] === undefined) {
                toSet[key] = DEFAULT_SETTINGS[key];
            }
        }

        if (Object.keys(toSet).length > 0) {
            await storageSet(toSet);
        }

        await Promise.all([
            checkForUpdates(),
            expireCartRestoreSecret()
        ]);
    } catch (err) {
        console.error('[KOSTEAM] Installation init error:', err);
    }
});

// Check for updates and discard stale restore metadata on browser startup.
onStartup(() => Promise.all([
    checkForUpdates(),
    expireCartRestoreSecret()
]));
