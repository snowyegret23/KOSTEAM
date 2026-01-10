document.addEventListener('DOMContentLoaded', async () => {
    const gameCountEl = document.getElementById('gameCount');
    const lastUpdateEl = document.getElementById('lastUpdate');
    const statusEl = document.getElementById('status');
    const refreshBtn = document.getElementById('refreshBtn');
    const githubBtn = document.getElementById('githubBtn');

    const sourceIds = ['source_steamapp', 'source_quasarplay', 'source_directg', 'source_stove'];
    const sources = sourceIds.map(id => document.getElementById(id));
    const bypassCheckbox = document.getElementById('bypass_language_filter');

    async function loadStats() {
        try {
            const result = await chrome.storage.local.get(['kr_patch_data', 'kr_patch_version']);

            if (result.kr_patch_data) {
                const count = Object.keys(result.kr_patch_data).length - 1;
                gameCountEl.textContent = count.toLocaleString() + '개';
            }

            if (result.kr_patch_version && result.kr_patch_version.generated_at) {
                const date = new Date(result.kr_patch_version.generated_at);
                const now = new Date();
                const diff = now - date;

                let timeText;
                if (diff < 60000) {
                    timeText = '방금 전';
                } else if (diff < 3600000) {
                    timeText = Math.floor(diff / 60000) + '분 전';
                } else if (diff < 86400000) {
                    timeText = Math.floor(diff / 3600000) + '시간 전';
                } else if (diff < 604800000) {
                    timeText = Math.floor(diff / 86400000) + '일 전';
                } else {
                    timeText = date.toLocaleDateString('ko-KR');
                }

                lastUpdateEl.textContent = timeText;
            }
        } catch (err) {
            console.error('Failed to load stats:', err);
        }
    }

    refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '업데이트 중...';
        statusEl.textContent = '';
        statusEl.className = 'status';

        try {
            const response = await chrome.runtime.sendMessage({ type: 'REFRESH_DATA' });

            if (response && response.success) {
                statusEl.textContent = '데이터가 업데이트되었습니다';
                statusEl.className = 'status success';
                await loadStats();
            } else {
                throw new Error('Update failed');
            }
        } catch (err) {
            statusEl.textContent = '✗ 업데이트 실패. 나중에 다시 시도해주세요.';
            statusEl.className = 'status error';
        }

        refreshBtn.disabled = false;
        refreshBtn.textContent = '데이터 새로고침';
    });

    githubBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: 'https://github.com/snowyegret23/KOSTEAM' });
    });

    async function loadSettings() {
        const defaultSettings = {
            source_steamapp: true,
            source_quasarplay: true,
            source_directg: true,
            source_stove: true,
            bypass_language_filter: true
        };
        const settings = await chrome.storage.local.get([...sourceIds, 'bypass_language_filter']);

        sources.forEach(checkbox => {
            const val = settings[checkbox.id] !== undefined ? settings[checkbox.id] : defaultSettings[checkbox.id];
            checkbox.checked = val;

            checkbox.addEventListener('change', () => {
                chrome.storage.local.set({ [checkbox.id]: checkbox.checked });
            });
        });

        bypassCheckbox.checked = settings.bypass_language_filter !== undefined 
            ? settings.bypass_language_filter 
            : defaultSettings.bypass_language_filter;
        bypassCheckbox.addEventListener('change', () => {
            chrome.storage.local.set({ bypass_language_filter: bypassCheckbox.checked });
        });
    }

    await loadStats();
    await loadSettings();
});
