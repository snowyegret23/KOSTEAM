const DATA_URL = 'https://raw.githubusercontent.com/snowyegret23/Steam_KRLocInfo/main/data/lookup.json';
const CACHE_KEY = 'kr_patch_data';
const CACHE_TIME_KEY = 'kr_patch_cache_time';
const CACHE_DURATION = 6 * 60 * 60 * 1000;

async function fetchData() {
    try {
        const response = await fetch(DATA_URL);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        
        await chrome.storage.local.set({
            [CACHE_KEY]: data,
            [CACHE_TIME_KEY]: Date.now()
        });
        
        console.log('[KR Patch] Data updated:', Object.keys(data).length, 'games');
        return data;
    } catch (err) {
        console.error('[KR Patch] Fetch failed:', err);
        return null;
    }
}

async function getData() {
    const result = await chrome.storage.local.get([CACHE_KEY, CACHE_TIME_KEY]);
    const cacheTime = result[CACHE_TIME_KEY] || 0;
    
    if (Date.now() - cacheTime > CACHE_DURATION || !result[CACHE_KEY]) {
        const freshData = await fetchData();
        if (freshData) return freshData;
    }
    
    return result[CACHE_KEY] || {};
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_PATCH_INFO') {
        getData().then(data => {
            const appId = message.appId;
            const info = data[appId] || null;
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
});

chrome.alarms.create('refreshData', { periodInMinutes: 360 });

chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'refreshData') {
        fetchData();
    }
});

chrome.runtime.onInstalled.addListener(() => {
    fetchData();
});
