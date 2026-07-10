/**
 * Cross-browser API abstraction layer
 * Supports both Chrome (chrome.*) and Firefox (browser.*) APIs
 */
export const api = (typeof browser !== 'undefined') ? browser : chrome;
const usesPromiseApi = typeof browser !== 'undefined';

function getLastError() {
    return api.runtime?.lastError;
}

function wrapAsync(invoke) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        const fail = (err) => {
            if (settled) return;
            settled = true;
            reject(err);
        };
        const callback = (result) => {
            const err = getLastError();
            if (err) {
                fail(new Error(err.message));
            } else {
                finish(result);
            }
        };

        try {
            const result = invoke(callback);
            if (result?.then) {
                result.then(finish, fail);
            }
        } catch (err) {
            fail(err);
        }
    });
}

function callAsync(target, method, args = []) {
    if (usesPromiseApi) {
        try {
            return Promise.resolve(target[method](...args));
        } catch (err) {
            return Promise.reject(err);
        }
    }

    return wrapAsync(callback => target[method](...args, callback));
}

/**
 * Safely send a message to the runtime
 * @param {Object} message - Message object to send
 * @returns {Promise<any>} Response from the message handler
 */
export function sendMessage(message) {
    return callAsync(api.runtime, 'sendMessage', [message]);
}

/**
 * Get items from local storage
 * @param {string|string[]} keys - Storage keys to retrieve
 * @returns {Promise<Object>} Storage items
 */
export function storageGet(keys) {
    return callAsync(api.storage.local, 'get', [keys]);
}

/**
 * Set items in local storage
 * @param {Object} items - Items to store
 * @returns {Promise<void>}
 */
export function storageSet(items) {
    return callAsync(api.storage.local, 'set', [items]);
}

export function storageSessionGet(keys) {
    return callAsync(api.storage.session, 'get', [keys]);
}

export function storageSessionSet(items) {
    return callAsync(api.storage.session, 'set', [items]);
}

export function storageSessionRemove(keys) {
    return callAsync(api.storage.session, 'remove', [keys]);
}

export function permissionsGetAll() {
    return callAsync(api.permissions, 'getAll');
}

export function permissionsRequest(permissions) {
    return callAsync(api.permissions, 'request', [permissions]);
}

export function alarmCreate(name, alarmInfo) {
    try {
        return Promise.resolve(api.alarms.create(name, alarmInfo));
    } catch (err) {
        return Promise.reject(err);
    }
}

export function alarmClear(name) {
    return callAsync(api.alarms, 'clear', [name]);
}

export function onAlarm(callback) {
    api.alarms.onAlarm.addListener(callback);
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
 * Add a listener for browser startup
 * @param {Function} callback - Callback function
 */
export function onStartup(callback) {
    if (api.runtime.onStartup) {
        api.runtime.onStartup.addListener(callback);
    }
}
