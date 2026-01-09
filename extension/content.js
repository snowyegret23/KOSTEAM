(function() {
    const appIdMatch = window.location.pathname.match(/\/app\/(\d+)/);
    if (!appIdMatch) return;
    
    const appId = appIdMatch[1];
    
    chrome.runtime.sendMessage({ type: 'GET_PATCH_INFO', appId }, response => {
        if (!response || !response.success || !response.info) return;
        
        const info = response.info;
        injectPatchInfo(info);
    });
    
    function injectPatchInfo(info) {
        const targetArea = document.querySelector('.game_area_purchase_game_wrapper') ||
                          document.querySelector('.game_area_purchase') ||
                          document.querySelector('#game_area_purchase');
        
        if (!targetArea) {
            console.log('[KR Patch] Target area not found');
            return;
        }
        
        const existingBanner = document.querySelector('.kr-patch-banner');
        if (existingBanner) existingBanner.remove();
        
        const banner = document.createElement('div');
        banner.className = 'kr-patch-banner';
        
        const isOfficial = info.type === 'official';
        const typeClass = isOfficial ? 'official' : 'user';
        const typeText = isOfficial ? '공식 한국어' : '유저 한글패치';
        
        let sourcesHtml = '';
        if (info.sources && info.sources.length > 0) {
            const sourceLabels = {
                'steamapp': { name: 'SteamApp', color: '#66c0f4' },
                'quasarplay': { name: 'QuasarPlay', color: '#9b59b6' },
                'directg': { name: 'DirectG', color: '#e74c3c' },
                'stove': { name: 'STOVE', color: '#ff6b35' }
            };
            
            sourcesHtml = '<div class="kr-patch-sources">';
            for (const src of info.sources) {
                const label = sourceLabels[src] || { name: src, color: '#888' };
                sourcesHtml += `<span class="kr-patch-source" style="background-color: ${label.color}">${label.name}</span>`;
            }
            sourcesHtml += '</div>';
        }
        
        let linksHtml = '';
        if (info.links && info.links.length > 0) {
            linksHtml = '<div class="kr-patch-links">';
            const uniqueLinks = [...new Set(info.links)].slice(0, 5);
            for (let i = 0; i < uniqueLinks.length; i++) {
                linksHtml += `<a href="${uniqueLinks[i]}" target="_blank" rel="noopener" class="kr-patch-link">패치 링크 ${i + 1}</a>`;
            }
            linksHtml += '</div>';
        }
        
        banner.innerHTML = `
            <div class="kr-patch-header">
                <span class="kr-patch-icon">🇰🇷</span>
                <span class="kr-patch-title">한국어 패치 정보</span>
                <span class="kr-patch-type ${typeClass}">${typeText}</span>
            </div>
            ${sourcesHtml}
            ${linksHtml}
        `;
        
        targetArea.parentNode.insertBefore(banner, targetArea);
    }
})();
