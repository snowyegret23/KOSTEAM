/**
 * KOSTEAM Background Service Worker
 * Handles data fetching, caching, and message routing
 */

import {
    storageGet,
    storageSet,
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
    DEFAULT_SETTINGS,
    MSG_GET_PATCH_INFO,
    MSG_REFRESH_DATA,
    MSG_CHECK_UPDATE_STATUS,
    MSG_RESTORE_CART
} from './shared/constants.js';

/**
 * Safely parse JSON response with error handling
 * @param {Response} response - Fetch response
 * @returns {Promise<Object|null>} Parsed JSON or null on error
 */
async function safeJsonParse(response) {
    try {
        return await response.json();
    } catch (err) {
        console.error('[KOSTEAM] JSON parse error:', err);
        return null;
    }
}

/**
 * Fetch remote version info
 * @returns {Promise<Object|null>} Version info or null on error
 */
async function getRemoteVersion() {
    try {
        const response = await fetch(VERSION_URL, { cache: 'no-store' });
        if (!response.ok) return null;
        return await safeJsonParse(response);
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
        const response = await fetch(VERSION_URL, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const remoteVersion = await safeJsonParse(response);
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
            fetch(ALIAS_URL, { cache: 'no-store' }).catch(() => ({ ok: false }))
        ]);

        if (!dataRes.ok) throw new Error(`Data fetch failed: ${dataRes.status}`);

        const data = await safeJsonParse(dataRes);
        if (!data) throw new Error('Invalid data JSON');

        const alias = aliasRes.ok ? await safeJsonParse(aliasRes) || {} : {};
        const version = versionInfo || data._meta || { generated_at: new Date().toISOString() };

        await storageSet({
            [CACHE_KEY]: data,
            [CACHE_ALIAS_KEY]: alias,
            [CACHE_VERSION_KEY]: version
        });

        console.log(`[KOSTEAM] Updated: ${Object.keys(data).length} games`);
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
    return !localVersion ||
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
    return Uint8Array.from([fieldNumber, data.length, ...data]);
}

/**
 * Build protobuf for adding item to cart
 * @param {number} itemId - Package ID or Bundle ID
 * @param {string} sourceTag - Source tag for tracking
 * @param {string} itemType - 'package' or 'bundle'
 * @returns {Uint8Array}
 */
function buildInputProtobuf(itemId, sourceTag, itemType = 'package') {
    const field1 = encodeLengthDelimited(0x0a, 'KR');
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
        encodeLengthDelimited(0x3a, 'KR'),
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

function buildMultipartBody(boundary, base64Payload) {
    return [
        `--${boundary}\r\n`,
        'Content-Disposition: form-data; name="input_protobuf_encoded"\r\n\r\n',
        base64Payload,
        `\r\n--${boundary}--\r\n`
    ].join('');
}

function buildFormData(base64Payload) {
    const form = new FormData();
    form.append('input_protobuf_encoded', base64Payload);
    return form;
}

// Message handler
onMessage((message, sender, sendResponse) => {
    // Basic message validation
    const baseValidation = validateMessage(message);
    if (!baseValidation.valid) {
        sendResponse({ success: false, error: baseValidation.error });
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

    if (message.type === MSG_RESTORE_CART) {
        const { token, packageIds, items, sourceTag } = message;
        // Support both legacy packageIds array and new items array format
        // items format: [{ id: number, type: 'package' | 'bundle' }, ...]
        const itemsToRestore = items || (packageIds ? packageIds.map(id => ({ id, type: 'package' })) : []);

        if (!token || !Array.isArray(itemsToRestore) || itemsToRestore.length === 0) {
            sendResponse({ success: false, error: 'Invalid restore payload' });
            return false;
        }

        (async () => {
            try {
                let usedOpaque = false;
                for (const item of itemsToRestore) {
                    const itemId = typeof item === 'object' ? Number(item.id) : Number(item);
                    const itemType = typeof item === 'object' ? (item.type || 'package') : 'package';
                    const protobufBytes = buildInputProtobuf(itemId, sourceTag, itemType);
                    const base64Payload = toBase64(protobufBytes);
                    const url = `https://api.steampowered.com/IAccountCartService/AddItemsToCart/v1?access_token=${encodeURIComponent(token)}`;

                    try {
                        const response = await fetch(url, {
                            method: 'POST',
                            body: buildFormData(base64Payload),
                            credentials: 'omit'
                        });

                        if (!response.ok) {
                            const text = await response.text();
                            sendResponse({
                                success: false,
                                error: `HTTP ${response.status}`,
                                detail: text.slice(0, 200)
                            });
                            return;
                        }

                        const text = await response.text();
                        if (text) {
                            try {
                                const parsed = JSON.parse(text);
                                const payload = parsed?.response || parsed;
                                if (payload?.error || (Array.isArray(payload?.errors) && payload.errors.length > 0)) {
                                    sendResponse({
                                        success: false,
                                        error: payload.error || 'API_ERROR',
                                        detail: JSON.stringify(payload.errors || payload.error).slice(0, 200)
                                    });
                                    return;
                                }
                            } catch {
                                // Non-JSON response; assume success.
                            }
                        }
                    } catch (err) {
                        try {
                            await fetch(url, {
                                method: 'POST',
                                mode: 'no-cors',
                                body: buildFormData(base64Payload),
                                credentials: 'omit'
                            });
                            usedOpaque = true;
                        } catch (fallbackErr) {
                            sendResponse({ success: false, error: fallbackErr.message });
                            return;
                        }
                    }
                }

                sendResponse({ success: true, opaque: usedOpaque });
            } catch (err) {
                console.error('[KOSTEAM] RESTORE_CART error:', err);
                sendResponse({ success: false, error: err.message });
            }
        })();
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

        checkForUpdates();
    } catch (err) {
        console.error('[KOSTEAM] Installation init error:', err);
    }
});

// Check for updates on browser startup (Chrome only)
onStartup(checkForUpdates);
