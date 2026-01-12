const api = (typeof browser !== 'undefined') ? browser : chrome;

document.addEventListener('DOMContentLoaded', async () => {
    const gameCountEl = document.getElementById('gameCount');
    const remoteUpdateEl = document.getElementById('remoteUpdate');
    const dbStatusEl = document.getElementById('dbStatus');
    const statusEl = document.getElementById('status');
    const refreshBtn = document.getElementById('refreshBtn');
    const githubBtn = document.getElementById('githubBtn');

    const sourceIds = ['source_steamapp', 'source_quasarplay', 'source_directg', 'source_stove'];
    const sources = sourceIds.map(id => document.getElementById(id));
    const bypassCheckbox = document.getElementById('bypass_language_filter');

    function formatTimeAgo(dateString) {
        if (!dateString) return '-';
        const date = new Date(dateString);
        const now = new Date();
        const diff = now - date;

        if (diff < 60000) return '방금 전';
        if (diff < 3600000) return Math.floor(diff / 60000) + '분 전';
        if (diff < 86400000) return Math.floor(diff / 3600000) + '시간 전';
        if (diff < 604800000) return Math.floor(diff / 86400000) + '일 전';
        return date.toLocaleDateString('ko-KR');
    }

    async function loadStats() {
        try {
            const result = await api.storage.local.get(['kr_patch_data']);

            if (result.kr_patch_data) {
                const count = Object.keys(result.kr_patch_data).length - 1;
                gameCountEl.textContent = count.toLocaleString() + '개';
            }
        } catch (err) {
            console.error('Failed to load stats:', err);
        }
    }

    async function checkUpdateStatus() {
        try {
            const response = await api.runtime.sendMessage({ type: 'CHECK_UPDATE_STATUS' });

            if (response && response.success) {
                if (response.remoteVersion && response.remoteVersion.generated_at) {
                    remoteUpdateEl.textContent = formatTimeAgo(response.remoteVersion.generated_at);
                }

                if (response.needsUpdate) {
                    dbStatusEl.textContent = '업데이트 필요!';
                    dbStatusEl.className = 'stat-value needs-update';
                } else {
                    dbStatusEl.textContent = '최신 버전';
                    dbStatusEl.className = 'stat-value up-to-date';
                }
            } else {
                dbStatusEl.textContent = '확인 실패';
                dbStatusEl.className = 'stat-value';
            }
        } catch (err) {
            console.error('Failed to check update status:', err);
            dbStatusEl.textContent = '확인 실패';
            dbStatusEl.className = 'stat-value';
        }
    }

    refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '업데이트 중...';
        statusEl.textContent = '';
        statusEl.className = 'status';

        try {
            const response = await api.runtime.sendMessage({ type: 'REFRESH_DATA' });

            if (response && response.success) {
                statusEl.textContent = '데이터가 업데이트되었습니다';
                statusEl.className = 'status success';
                await loadStats();
                await checkUpdateStatus();
            } else {
                throw new Error('Update failed');
            }
        } catch (err) {
            console.error(err);
            statusEl.textContent = '✗ 업데이트 실패. 나중에 다시 시도해주세요.';
            statusEl.className = 'status error';
        }

        refreshBtn.disabled = false;
        refreshBtn.textContent = '데이터 새로고침';
    });

    if (githubBtn) {
        githubBtn.addEventListener('click', () => {
            api.tabs.create({ url: 'https://github.com/snowyegret23/KOSTEAM' });
        });
    }

    async function loadSettings() {
        try {
            const settings = await api.storage.local.get([...sourceIds, 'bypass_language_filter']);

            sources.forEach(checkbox => {
                checkbox.checked = settings[checkbox.id] !== false;

                checkbox.addEventListener('change', () => {
                    api.storage.local.set({ [checkbox.id]: checkbox.checked });
                });
            });

            bypassCheckbox.checked = settings.bypass_language_filter !== false;
            bypassCheckbox.addEventListener('change', () => {
                api.storage.local.set({ bypass_language_filter: bypassCheckbox.checked });
            });
        } catch (err) {
            console.error('Failed to load settings:', err);
        }
    }

    await loadStats();
    await loadSettings();
    await checkUpdateStatus();
});