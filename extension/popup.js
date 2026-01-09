document.addEventListener('DOMContentLoaded', async () => {
    const gameCountEl = document.getElementById('gameCount');
    const lastUpdateEl = document.getElementById('lastUpdate');
    const statusEl = document.getElementById('status');
    const refreshBtn = document.getElementById('refreshBtn');
    const githubBtn = document.getElementById('githubBtn');
    
    async function loadStats() {
        try {
            const result = await chrome.storage.local.get(['kr_patch_data', 'kr_patch_cache_time']);
            
            if (result.kr_patch_data) {
                const count = Object.keys(result.kr_patch_data).length;
                gameCountEl.textContent = count.toLocaleString() + '개';
            }
            
            if (result.kr_patch_cache_time) {
                const date = new Date(result.kr_patch_cache_time);
                const now = new Date();
                const diff = now - date;
                
                let timeText;
                if (diff < 60000) {
                    timeText = '방금 전';
                } else if (diff < 3600000) {
                    timeText = Math.floor(diff / 60000) + '분 전';
                } else if (diff < 86400000) {
                    timeText = Math.floor(diff / 3600000) + '시간 전';
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
        refreshBtn.textContent = '⏳ 업데이트 중...';
        statusEl.textContent = '';
        statusEl.className = 'status';
        
        try {
            const response = await chrome.runtime.sendMessage({ type: 'REFRESH_DATA' });
            
            if (response && response.success) {
                statusEl.textContent = '✓ 데이터가 업데이트되었습니다';
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
        refreshBtn.textContent = '🔄 데이터 새로고침';
    });
    
    githubBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: 'https://github.com/snowyegret23/Steam_KRLocInfo' });
    });
    
    await loadStats();
});
