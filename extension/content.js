(function () {
    const appIdMatch = window.location.pathname.match(/\/app\/(\d+)/);
    if (!appIdMatch) return;

    const appId = appIdMatch[1];
    const hasOfficialKorean = checkOfficialKoreanSupport();

    chrome.runtime.sendMessage({ type: 'GET_PATCH_INFO', appId }, response => {
        const info = response?.info;
        injectPatchInfo(info, hasOfficialKorean);
    });

    function checkOfficialKoreanSupport() {
        const rows = document.querySelectorAll('.game_language_options tr');
        for (const row of rows) {
            if (row.classList.contains('unsupported')) continue;
            const firstCell = row.querySelector('td.ellipsis');
            if (!firstCell) continue;
            const text = firstCell.textContent.trim();
            if (text === '한국어' || text === 'Korean') {
                const checks = row.querySelectorAll('td.checkcol');
                for (const check of checks) {
                    if (check.textContent.includes('✔') || check.querySelector('span')) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    function getPatchTypeInfo(info, hasOfficialKorean) {
        const hasUserPatches = info && info.links && info.links.length > 0;
        const sources = info ? (info.sources || []) : [];
        const type = info ? info.type : null;

        const hasDirectG = sources.includes('directg');
        const hasStove = sources.includes('stove');
        const hasDbInfo = !!info;
        const isDbOfficial = type === 'official';

        if (hasOfficialKorean) {
            if (hasUserPatches) {
                return { label: '공식(유저패치 존재)', cssClass: 'official-with-user', color: '#4c9a2a' };
            }
            return { label: '공식', cssClass: 'official-steam', color: '#4c9a2a' };
        }

        if (hasDirectG) {
            return { label: '다이렉트 게임즈', cssClass: 'official-directg', color: '#0C7CED' };
        }

        if (hasStove) {
            return { label: '스토브', cssClass: 'official-stove', color: '#FF8126' };
        }

        if (hasDbInfo) {
            if (isDbOfficial) {
                return { label: '공식지원 추정', cssClass: 'official', color: '#4c9a2a' };
            }
            return { label: '유저패치', cssClass: 'user', color: '#B921FF' };
        }

        return { label: '한국어 없음', cssClass: 'none', color: '#e74c3c' };
    }

    function formatSingleDescription(desc) {
        if (!desc) return '';
        return desc.replace(/\n/g, ' // ').trim();
    }

    function injectPatchInfo(info, initialHasOfficialKorean) {
        const hasOfficialKorean = checkOfficialKoreanSupport() || initialHasOfficialKorean;

        chrome.storage.local.get(['source_steamapp', 'source_quasarplay', 'source_directg', 'source_stove'], (settings) => {
            const patchTypeInfo = getPatchTypeInfo(info, hasOfficialKorean);
            if (!patchTypeInfo) return;

            const isSourceEnabled = (source) => settings[`source_${source}`] !== false;
            const isOfficialGame = hasOfficialKorean || (info && info.type === 'official');

            let targetArea = document.querySelector('.game_language_options');
            let noKoreanBox = null;

            const noticeBoxContent = document.querySelector('.notice_box_content');
            if (noticeBoxContent) {
                const text = noticeBoxContent.textContent;
                if (text.includes('한국어(을)를 지원하지 않습니다') || text.includes('언어 인터페이스')) {
                    noKoreanBox = noticeBoxContent.closest('.notice_box') || noticeBoxContent;
                }
            }

            if (!noKoreanBox) {
                const parentBlocks = document.querySelectorAll('.game_area_description');
                for (const block of parentBlocks) {
                    const text = block.textContent;
                    if (text.includes('한국어(을)를 지원하지 않습니다') || text.includes('언어 인터페이스')) {
                        noKoreanBox = block.closest('.notice_box') || block;
                        break;
                    }
                }
            }

            if (!noKoreanBox) {
                targetArea = document.querySelector('.game_area_purchase_game_wrapper') ||
                    document.querySelector('.game_area_purchase') ||
                    document.querySelector('#game_area_purchase');
            }

            if (!targetArea && !noKoreanBox) return;

            const banner = document.createElement('div');
            banner.className = 'kr-patch-banner';

            let contentHtml = '';
            const linksBySource = new Map();

            if (info && info.links) {
                const siteUrls = info.source_site_urls || {};
                const links = info.links || [];
                const patchSources = info.patch_sources || [];
                const patchDescriptions = info.patch_descriptions || [];

                for (let i = 0; i < links.length; i++) {
                    const source = patchSources[i];
                    if (!isSourceEnabled(source)) continue;

                    if (!linksBySource.has(source)) {
                        linksBySource.set(source, {
                            url: siteUrls[source] || links[i],
                            descriptions: []
                        });
                    }

                    const desc = formatSingleDescription(patchDescriptions[i]);
                    if (desc) {
                        linksBySource.get(source).descriptions.push(desc);
                    }
                }
            }

            const isOfficial = patchTypeInfo.label.includes('공식');
            const hasLinks = linksBySource.size > 0;

            if (hasLinks) {
                contentHtml = '<div class="kr-patch-links-list">';
                let index = 1;
                linksBySource.forEach((data, source) => {
                    const labelPrefix = source === 'stove' ? 'STOVE' :
                        source === 'directg' ? '다이렉트게임즈' :
                            source === 'quasarplay' ? 'quasarplay' : 'steamapp';

                    contentHtml += `
                        <div class="kr-patch-link-item">
                            <div class="kr-patch-link-header">
                                <span class="kr-patch-link-label">링크 ${index++}:</span>
                                <a href="${data.url}" target="_blank" rel="noopener" class="kr-patch-link-text">[ ${labelPrefix} 연결 ]</a>
                            </div>
                            ${data.descriptions.length > 0 ? `
                                <div style="margin-top: 5px;">
                                    ${data.descriptions.map(d => `<div class="kr-patch-link-description" style="margin-bottom: 4px;">${d}</div>`).join('')}
                                </div>
                            ` : ''}
                        </div>`;
                });
                contentHtml += '</div>';
            } else if (isOfficial) {
                if (patchTypeInfo.label === '공식지원 추정') {
                    contentHtml = '<div class="kr-patch-official-text">공식으로 한국어를 지원하는 것으로 추정되는 게임입니다.<br>(한글패치 사이트에 한국어 버전이 존재한다고 제보된 게임)</div>';
                } else {
                    contentHtml = '<div class="kr-patch-official-text">공식으로 한국어를 지원하는 게임입니다.</div>';
                }
            } else if (patchTypeInfo.cssClass === 'none') {
                contentHtml = '<div class="kr-patch-none-text">현재 데이터베이스에 등록된 한국어 패치 정보가 없습니다.</div>';
            } else {
                contentHtml = '<div class="kr-patch-none-text">해당 게임의 패치 정보 사이트로 연결되는 링크를 찾을 수 없습니다.</div>';
            }

            banner.innerHTML = `
                <div class="kr-patch-content">
                    <div class="kr-patch-type-label ${patchTypeInfo.cssClass}" style="background-color: ${patchTypeInfo.color}">
                        ${patchTypeInfo.label}
                    </div>
                    <div class="kr-patch-data-area">
                        ${contentHtml}
                    </div>
                </div>
            `;

            const existingBanner = document.querySelector('.kr-patch-banner');
            if (existingBanner) {
                existingBanner.replaceWith(banner);
            } else {
                if (noKoreanBox) {
                    noKoreanBox.replaceWith(banner);
                } else if (targetArea) {
                    targetArea.parentNode.insertBefore(banner, targetArea);
                }
            }
        });
    }

    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local') {
            const hasSourceChange = Object.keys(changes).some(key => key.startsWith('source_'));
            if (hasSourceChange) {
                chrome.runtime.sendMessage({ type: 'GET_PATCH_INFO', appId }, response => {
                    if (response && response.success) {
                        injectPatchInfo(response.info, hasOfficialKorean);
                    }
                });
            }
        }
    });
})();
