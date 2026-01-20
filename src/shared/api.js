/**
 * Cross-browser API abstraction layer
 * Supports both Chrome (chrome.*) and Firefox (browser.*) APIs
 */
export const api = (typeof browser !== 'undefined') ? browser : chrome;

/**
 * Safely send a message to the runtime
 * @param {Object} message - Message object to send
 * @returns {Promise<any>} Response from the message handler
 */
export function sendMessage(message) {
    return new Promise((resolve, reject) => {
        api.runtime.sendMessage(message, (response) => {
            if (api.runtime.lastError) {
                reject(new Error(api.runtime.lastError.message));
            } else {
                resolve(response);
            }
        });
    });
}

/**
 * Get items from local storage
 * @param {string|string[]} keys - Storage keys to retrieve
 * @returns {Promise<Object>} Storage items
 */
export function storageGet(keys) {
    return new Promise((resolve, reject) => {
        api.storage.local.get(keys, (result) => {
            if (api.runtime.lastError) {
                reject(new Error(api.runtime.lastError.message));
            } else {
                resolve(result);
            }
        });
    });
}

/**
 * Set items in local storage
 * @param {Object} items - Items to store
 * @returns {Promise<void>}
 */
export function storageSet(items) {
    return new Promise((resolve, reject) => {
        api.storage.local.set(items, () => {
            if (api.runtime.lastError) {
                reject(new Error(api.runtime.lastError.message));
            } else {
                resolve();
            }
        });
    });
}

/**
 * Add a listener for storage changes
 * @param {Function} callback - Callback function (changes, namespace) => void
 */
export function onStorageChanged(callback) {
    api.storage.onChanged.addListener(callback);
}

/**
 * Add a listener for messages
 * @param {Function} callback - Callback function (message, sender, sendResponse) => boolean
 */
export function onMessage(callback) {
    api.runtime.onMessage.addListener(callback);
}

/**
 * Add a listener for extension installation
 * @param {Function} callback - Callback function
 */
export function onInstalled(callback) {
    api.runtime.onInstalled.addListener(callback);
}

/**
 * Add a listener for browser startup (Chrome only, noop on Firefox)
 * @param {Function} callback - Callback function
 */
export function onStartup(callback) {
    if (api.runtime.onStartup) {
        api.runtime.onStartup.addListener(callback);
    }
}

/**
 * Open a new tab
 * @param {string} url - URL to open
 */
export function openTab(url) {
    api.tabs.create({ url });
}
