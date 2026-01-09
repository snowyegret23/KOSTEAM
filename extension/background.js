const REMOTE_BASE_URL = 'https://raw.githubusercontent.com/snowyegret23/Steam_KRLocInfo/main/data';
const VERSION_URL = `${REMOTE_BASE_URL}/version.json`;
const DATA_URL = `${REMOTE_BASE_URL}/lookup.json`;

const CACHE_KEY = 'kr_patch_data';
const CACHE_VERSION_KEY = 'kr_patch_version';

async function checkForUpdates() {
    try {
        const response = await fetch(VERSION_URL, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const remoteVersion = await response.json();

        const local = await chrome.storage.local.get([CACHE_VERSION_KEY]);
        const localVersion = local[CACHE_VERSION_KEY];

        if (!localVersion || localVersion.generated_at !== remoteVersion.generated_at) {
            console.log('[KR Patch] New version available, downloading...');
            return await fetchData(remoteVersion);
        }

        console.log('[KR Patch] Data is up to date');
        return null;
    } catch (err) {
        console.error('[KR Patch] Version check failed:', err);
        return null;
    }
}

async function fetchData(versionInfo) {
    try {
        const response = await fetch(DATA_URL);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        const version = versionInfo || data._meta || { generated_at: new Date().toISOString() };

        await chrome.storage.local.set({
            [CACHE_KEY]: data,
            [CACHE_VERSION_KEY]: version
        });

        console.log('[KR Patch] Data updated:', Object.keys(data).length - 1, 'games');
        return data;
    } catch (err) {
        console.error('[KR Patch] Fetch failed:', err);
        return null;
    }
}

async function getData() {
    const result = await chrome.storage.local.get([CACHE_KEY]);
    return result[CACHE_KEY] || {};
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_PATCH_INFO') {
        getData().then(data => {
            const info = data[message.appId] || null;
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
            sendResponse({ success: true, version: result[CACHE_VERSION_KEY] });
        });
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
