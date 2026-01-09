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
                const checks = row.querySelectorAll('td.check');
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
        if (!info) {
            if (hasOfficialKorean) {
                return { label: '공식', cssClass: 'official-steam', color: '#4c9a2a' };
            }
            return { label: '없음', cssClass: 'none', color: '#e74c3c' };
        }

        const isOfficial = info.type === 'official';
        const hasUserPatches = info.links && info.links.length > 0;
        const sources = info.sources || [];

        if (sources.includes('stove')) {
            return { label: '공식(스토브)', cssClass: 'official-stove', color: '#FF8126' };
        }

        if (sources.includes('directg')) {
            return { label: '공식(다이렉트게임즈)', cssClass: 'official-directg', color: '#0C7CED' };
        }

        if (hasOfficialKorean) {
            if (hasUserPatches) {
                return { label: '공식(관련 유저패치 있음)', cssClass: 'official-with-user', color: '#4c9a2a' };
            }
            return { label: '공식', cssClass: 'official-steam', color: '#4c9a2a' };
        }

        if (isOfficial && hasUserPatches) {
            return { label: '공식(관련 유저패치 있음)', cssClass: 'official-with-user', color: '#4c9a2a' };
        }

        if (isOfficial) {
            return { label: '공식', cssClass: 'official', color: '#4c9a2a' };
        }

        return { label: '유저패치', cssClass: 'user', color: '#B921FF' };
    }

    function formatSingleDescription(desc) {
        if (!desc) return '';
        return desc.replace(/\n/g, ' // ').trim();
    }

    function formatDescriptions(descs) {
        if (!descs || descs.length === 0) return '';
        const formatted = descs.map(d => formatSingleDescription(d)).filter(Boolean);
        return formatted.join('\n');
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
            const linksWithDescs = [];

            if (info) {
                const siteUrls = info.source_site_urls || {};
                const patchSources = info.patch_sources || [];
                const sourcesWithLinks = info.sources_with_links || [];

                const hasLinksFromSource = (source) => {
                    return sourcesWithLinks.includes(source) || patchSources.includes(source);
                };

                if (isSourceEnabled('steamapp') && siteUrls.steamapp) {
                    const hasLinks = hasLinksFromSource('steamapp');
                    const isRedundant = isOfficialGame && !hasLinks;

                    if (!isRedundant) {
                        const descs = patchSources.map((s, i) => s === 'steamapp' ? info.patch_descriptions[i] : null).filter(Boolean);

                        linksWithDescs.push({
                            url: siteUrls.steamapp,
                            name: 'steamapp',
                            label: 'steamapp 연결',
                            desc: formatDescriptions(descs) || formatSingleDescription(info.description) || ''
                        });
                    }
                }

                if (isSourceEnabled('quasarplay') && siteUrls.quasarplay) {
                    const hasLinks = hasLinksFromSource('quasarplay');
                    const isRedundant = isOfficialGame && !hasLinks;

                    if (!isRedundant) {
                        const descs = patchSources.map((s, i) => s === 'quasarplay' ? info.patch_descriptions[i] : null).filter(Boolean);

                        linksWithDescs.push({
                            url: siteUrls.quasarplay,
                            name: 'quasarplay',
                            label: 'quasarplay 연결',
                            desc: formatDescriptions(descs) || ''
                        });
                    }
                }

                if (isSourceEnabled('stove') && info.sources.includes('stove')) {
                    const stoveSiteUrl = siteUrls.stove;
                    const links = info.links || [];
                    for (let i = 0; i < links.length; i++) {
                        if (patchSources[i] === 'stove') {
                            linksWithDescs.push({
                                url: stoveSiteUrl || links[i],
                                name: 'stove',
                                label: 'STOVE 연결',
                                desc: formatSingleDescription(info.patch_descriptions[i] || '')
                            });
                            if (stoveSiteUrl) break;
                        }
                    }
                }

                if (isSourceEnabled('directg') && info.sources.includes('directg')) {
                    const dgSiteUrl = siteUrls.directg;
                    const links = info.links || [];
                    for (let i = 0; i < links.length; i++) {
                        if (patchSources[i] === 'directg') {
                            linksWithDescs.push({
                                url: dgSiteUrl || links[i],
                                name: 'directg',
                                label: '다이렉트게임즈 연결',
                                desc: formatSingleDescription(info.patch_descriptions[i] || '')
                            });
                            if (dgSiteUrl) break;
                        }
                    }
                }
            }

            const isOfficial = patchTypeInfo.label.includes('공식');
            const hasLinks = linksWithDescs.length > 0;

            if (hasLinks) {
                contentHtml = '<div class="kr-patch-links-list">';
                linksWithDescs.forEach((item, index) => {
                    const label = SOURCE_LABELS[item.name] || item.name;

                    contentHtml += `
                        <div class="kr-patch-link-item">
                            <div class="kr-patch-link-header">
                                <span class="kr-patch-link-label">링크 ${index + 1}: ${label}</span>
                                <a href="${item.url}" target="_blank" rel="noopener" class="kr-patch-link-text">[ ${item.label} ]</a>
                            </div>
                            ${item.desc ? `<div class="kr-patch-link-description">${item.desc}</div>` : ''}
                        </div>`;
                });
                contentHtml += '</div>';
            } else if (isOfficial) {
                contentHtml = '<div class="kr-patch-official-text">공식으로 한국어를 지원하는 게임입니다.</div>';
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
