const api = (typeof browser !== 'undefined') ? browser : chrome;

const REMOTE_BASE_URL = 'https://raw.githubusercontent.com/snowyegret23/KOSTEAM/refs/heads/main/data';
const VERSION_URL = `${REMOTE_BASE_URL}/version.json`;
const DATA_URL = `${REMOTE_BASE_URL}/lookup.json`;
const ALIAS_URL = `${REMOTE_BASE_URL}/alias.json`;

const CACHE_KEY = 'kr_patch_data';
const CACHE_ALIAS_KEY = 'kr_patch_alias';
const CACHE_VERSION_KEY = 'kr_patch_version';

async function checkForUpdates() {
    try {
        const response = await fetch(VERSION_URL, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const remoteVersion = await response.json();

        const local = await api.storage.local.get([CACHE_VERSION_KEY]);
        const localVersion = local[CACHE_VERSION_KEY];

        if (!localVersion || 
            localVersion.generated_at !== remoteVersion.generated_at || 
            localVersion.alias_updated_at !== remoteVersion.alias_updated_at) {
            console.log('[KOSTEAM] New version detected, updating...');
            return await fetchData(remoteVersion);
        }
        return null;
    } catch (err) {
        console.error('[KOSTEAM] Version check failed:', err);
        return null;
    }
}

async function getRemoteVersion() {
    try {
        const response = await fetch(VERSION_URL, { cache: 'no-store' });
        if (!response.ok) return null;
        return await response.json();
    } catch (err) {
        return null;
    }
}

async function fetchData(versionInfo) {
    try {
        const [dataRes, aliasRes] = await Promise.all([
            fetch(DATA_URL),
            fetch(ALIAS_URL).catch(() => ({ ok: false, json: async () => ({}) }))
        ]);

        if (!dataRes.ok) throw new Error(`Fetch failed: ${dataRes.status}`);
        const data = await dataRes.json();
        const alias = aliasRes.ok ? await aliasRes.json() : {};

        const version = versionInfo || data._meta || { generated_at: new Date().toISOString() };

        await api.storage.local.set({
            [CACHE_KEY]: data,
            [CACHE_ALIAS_KEY]: alias,
            [CACHE_VERSION_KEY]: version
        });

        console.log(`[KOSTEAM] Updated: ${Object.keys(data).length} games`);
        return data;
    } catch (err) {
        console.error('[KOSTEAM] Data update failed:', err);
        return null;
    }
}

async function getData() {
    const result = await api.storage.local.get([CACHE_KEY, CACHE_ALIAS_KEY]);
    return {
        data: result[CACHE_KEY] || {},
        alias: result[CACHE_ALIAS_KEY] || {}
    };
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_PATCH_INFO') {
        getData().then(({ data, alias }) => {
            const appId = message.appId;
            const targetId = alias[appId] || appId;
            const info = data[targetId] || null;
            sendResponse({ success: true, info });
        });
        return true;
    }

    if (message.type === 'REFRESH_DATA') {
        (async () => {
            const remoteVersion = await getRemoteVersion();
            const data = await fetchData(remoteVersion);
            sendResponse({ success: !!data });
        })();
        return true;
    }

    if (message.type === 'CHECK_UPDATE_STATUS') {
        (async () => {
            const local = await api.storage.local.get([CACHE_VERSION_KEY]);
            const remoteVersion = await getRemoteVersion();

            if (!remoteVersion) {
                sendResponse({ success: false, error: 'Network error' });
                return;
            }
            const needsUpdate = !local.kr_patch_version ||
                local.kr_patch_version.generated_at !== remoteVersion.generated_at;

            sendResponse({
                success: true,
                needsUpdate,
                localVersion: local.kr_patch_version,
                remoteVersion
            });
        })();
        return true;
    }
});

const DEFAULT_SETTINGS = {
    source_steamapp: true,
    source_quasarplay: true,
    source_directg: true,
    source_stove: true,
    bypass_language_filter: true
};

api.runtime.onInstalled.addListener(async () => {
    const current = await api.storage.local.get(Object.keys(DEFAULT_SETTINGS));
    const toSet = {};
    for (const key in DEFAULT_SETTINGS) {
        if (current[key] === undefined) toSet[key] = DEFAULT_SETTINGS[key];
    }
    if (Object.keys(toSet).length > 0) await api.storage.local.set(toSet);
    
    checkForUpdates();
});

api.alarms.create('checkUpdates', { periodInMinutes: 360 });
api.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'checkUpdates') checkForUpdates();
});