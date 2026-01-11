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

        const local = await chrome.storage.local.get([CACHE_VERSION_KEY]);
        const localVersion = local[CACHE_VERSION_KEY];

        if (!localVersion || localVersion.generated_at !== remoteVersion.generated_at || localVersion.alias_updated_at !== remoteVersion.alias_updated_at) {
            console.log('[KR Patch] New version or alias available, downloading...');
            return await fetchData(remoteVersion);
        }

        console.log('[KR Patch] Data is up to date');
        return null;
    } catch (err) {
        console.error('[KR Patch] Version check failed:', err);
        return null;
    }
}

async function getRemoteVersion() {
    try {
        const response = await fetch(VERSION_URL, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (err) {
        console.error('[KR Patch] Remote version fetch failed:', err);
        return null;
    }
}

async function fetchData(versionInfo) {
    try {
        const [dataRes, aliasRes] = await Promise.all([
            fetch(DATA_URL),
            fetch(ALIAS_URL).catch(() => ({ ok: false }))
        ]);

        if (!dataRes.ok) throw new Error(`HTTP ${dataRes.status}`);
        const data = await dataRes.json();

        let alias = {};
        if (aliasRes.ok) {
            alias = await aliasRes.json();
        }

        const version = versionInfo || data._meta || { generated_at: new Date().toISOString() };

        await chrome.storage.local.set({
            [CACHE_KEY]: data,
            [CACHE_ALIAS_KEY]: alias,
            [CACHE_VERSION_KEY]: version
        });

        console.log('[KR Patch] Data updated:', Object.keys(data).length - 1, 'games,', Object.keys(alias).length, 'aliases');
        return data;
    } catch (err) {
        console.error('[KR Patch] Fetch failed:', err);
        return null;
    }
}

async function getData() {
    const result = await chrome.storage.local.get([CACHE_KEY, CACHE_ALIAS_KEY]);
    return {
        data: result[CACHE_KEY] || {},
        alias: result[CACHE_ALIAS_KEY] || {}
    };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_PATCH_INFO') {
        getData().then(({ data, alias }) => {
            const appId = message.appId;
            const targetId = alias[appId] || appId;
            const info = data[targetId] || null;
            sendResponse({ success: true, info });
        }).catch(err => {
            sendResponse({ success: false, error: err.message });
        });
        return true;
    }

    if (message.type === 'REFRESH_DATA') {
        fetchData().then(data => {
            sendResponse({ success: !!data });
        });
        return true;
    }

    if (message.type === 'GET_VERSION') {
        chrome.storage.local.get([CACHE_VERSION_KEY]).then(result => {
            sendResponse({ 
                success: true, 
                version: result[CACHE_VERSION_KEY]
            });
        });
        return true;
    }

    if (message.type === 'CHECK_UPDATE_STATUS') {
        (async () => {
            const local = await chrome.storage.local.get([CACHE_VERSION_KEY]);
            const localVersion = local[CACHE_VERSION_KEY];
            const remoteVersion = await getRemoteVersion();

            if (!remoteVersion) {
                sendResponse({ success: false, error: 'Failed to fetch remote version' });
                return;
            }

            const needsUpdate = !localVersion || 
                localVersion.generated_at !== remoteVersion.generated_at || 
                localVersion.alias_updated_at !== remoteVersion.alias_updated_at;

            sendResponse({ 
                success: true, 
                needsUpdate,
                localVersion,
                remoteVersion
            });
        })();
        return true;
    }
});

chrome.runtime.onStartup.addListener(() => {
    console.log('[KR Patch] Browser started, checking for updates...');
    checkForUpdates();
});

chrome.runtime.onInstalled.addListener(() => {
    console.log('[KR Patch] Extension installed/updated, fetching data...');
    fetchData();
});

chrome.alarms.create('checkUpdates', { periodInMinutes: 360 });

chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'checkUpdates') {
        checkForUpdates();
    }
});
