/**
 * KOSTEAM Content Script
 * Injects Korean patch info banner into Steam app pages
 */

import { sendMessage, storageGet, onStorageChanged } from './shared/api.js';
import { isValidSourceUrl } from './shared/url-validator.js';
import {
    PATCH_TYPES,
    SOURCE_LABELS,
    MSG_GET_PATCH_INFO,
    KOREAN_LABELS,
    UI_STRINGS,
    CACHE_KEY,
    CACHE_ALIAS_KEY
} from './shared/constants.js';

(async function () {
    // Extract appId from URL
    const appIdMatch = window.location.pathname.match(/\/app\/(\d+)/);
    if (!appIdMatch) return;

    const appId = appIdMatch[1];

    let patchInfoData = null;
    let patchInfoReady = false;
    let patchInfoLoading = true;
    let patchRequestId = 0;
    let patchRenderId = 0;
    let replacedLanguageNotice = null;
    const observerCleanups = [];

    // Check if URL has curator_clanid parameter and scroll to curator review
    handleCuratorLink();

    // Request patch info from background
    startLanguageTableWatcher();
    refreshPatchInfo();

    async function refreshPatchInfo() {
        const requestId = ++patchRequestId;
        patchRenderId++;
        try {
            const response = await sendMessage({ type: MSG_GET_PATCH_INFO, appId });
            if (requestId !== patchRequestId) return;
            patchInfoReady = response?.success === true;
            patchInfoData = patchInfoReady ? response.info : null;
        } catch (err) {
            if (requestId !== patchRequestId) return;
            patchInfoReady = false;
            console.debug('[KOSTEAM] Message error:', err);
        } finally {
            if (requestId === patchRequestId) {
                patchInfoLoading = false;
                const currentSupport = checkOfficialKoreanSupport();
                if (currentSupport !== null) injectPatchInfo(patchInfoData, currentSupport);
            }
        }
    }

    /**
     * Handle curator link - scroll to curator review section if curator_clanid is in URL
     */
    function handleCuratorLink() {
        const urlParams = new URLSearchParams(window.location.search);
        const curatorClanId = urlParams.get('curator_clanid');

        if (!curatorClanId) return;

        // Function to find and scroll to curator review
        const scrollToCuratorReview = () => {
            const curatorSection = document.querySelector('[data-featuretarget="referring-curator-review"]') ||
                document.querySelector('.referring_curator_ctn');

            if (curatorSection && curatorSection.getBoundingClientRect().height > 0) {
                curatorSection.scrollIntoView({ behavior: 'auto', block: 'start' });
                return true;
            }
            return false;
        };

        // Try immediate scroll
        if (scrollToCuratorReview()) return;

        // If not found, wait for DOM to load with MutationObserver
        const observer = new MutationObserver(() => {
            if (scrollToCuratorReview()) {
                observer.disconnect();
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'hidden']
        });
        observerCleanups.push(() => observer.disconnect());
    }

    /**
     * Start watching for the language table and its state changes
     */
    function startLanguageTableWatcher() {
        let lastKoreanSupport;
        let observedContainer = null;

        /**
         * Check Korean support and update UI if changed
         */
        function checkAndUpdate() {
            const currentSupport = checkOfficialKoreanSupport();
            if (currentSupport === null) return;
            if (currentSupport !== lastKoreanSupport) {
                lastKoreanSupport = currentSupport;
                injectPatchInfo(patchInfoData, currentSupport);
            }
        }

        const tableObserver = new MutationObserver(() => checkAndUpdate());

        const attachTableObserver = () => {
            const container = document.querySelector('#languageTable') || document.querySelector('.game_language_options');
            if (!container || container === observedContainer) return;

            tableObserver.disconnect();
            observedContainer = container;
            tableObserver.observe(container, {
                attributes: true,
                childList: true,
                subtree: true,
                characterData: true
            });
            checkAndUpdate();
        };

        const pageObserver = new MutationObserver(() => {
            if (!observedContainer?.isConnected) attachTableObserver();
        });

        pageObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
        attachTableObserver();
        observerCleanups.push(() => {
            pageObserver.disconnect();
            tableObserver.disconnect();
        });
    }

    /**
     * Check if the game has official Korean language support on Steam
     * @returns {boolean|null}
     */
    function checkOfficialKoreanSupport() {
        const table = document.querySelector('.game_language_options');
        if (!table) return null;

        const localizedLabel = document.querySelector('#review_language_koreana[data-language]')?.dataset.language;
        const labels = new Set(KOREAN_LABELS);
        if (localizedLabel) labels.add(localizedLabel);

        for (const row of table.querySelectorAll('tr')) {
            const firstCell = row.querySelector('td.ellipsis');
            if (!firstCell || !labels.has(firstCell.textContent?.trim() || '')) continue;

            if (row.classList.contains('unsupported')) return false;
            return !!row.querySelector('td.checkcol span');
        }

        return false;
    }

    /**
     * Determine patch type info based on data and Korean support status
     * @param {Object|null} info - Patch info from database
     * @param {boolean} hasOfficialKorean - Whether Steam shows official Korean support
     * @returns {Object} Patch type configuration
     */
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
                return PATCH_TYPES.OFFICIAL_WITH_USER;
            }
            return PATCH_TYPES.OFFICIAL_STEAM;
        }

        if (hasDirectG) return PATCH_TYPES.OFFICIAL_DIRECTG;
        if (hasStove) return PATCH_TYPES.OFFICIAL_STOVE;

        if (hasDbInfo) {
            if (isDbOfficial) return PATCH_TYPES.OFFICIAL_ESTIMATED;
            return PATCH_TYPES.USER_PATCH;
        }

        return PATCH_TYPES.NONE;
    }

    /**
     * Format a description string, replacing newlines with separators
     * @param {string} desc - Description text
     * @returns {string} Formatted description
     */
    function formatSingleDescription(desc) {
        if (!desc) return '';
        return desc.replace(/\n/g, ' // ').trim();
    }

    /**
     * Create a DOM element with optional class and text
     * @param {string} tag - HTML tag name
     * @param {string} [className] - CSS class(es)
     * @param {string} [text] - Text content
     * @returns {HTMLElement}
     */
    function createElement(tag, className, text) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text) el.textContent = text;
        return el;
    }

    /**
     * Get the source label for a source key
     * @param {string} source - Source key
     * @returns {string} Display label
     */
    function getSourceLabel(source) {
        return SOURCE_LABELS[source] || source;
    }


    function removePatchInfo() {
        const banner = document.querySelector('.kr-patch-banner');
        if (banner && replacedLanguageNotice) {
            banner.replaceWith(replacedLanguageNotice);
        } else if (banner) {
            banner.remove();
        }
        replacedLanguageNotice = null;
    }

    /**
     * Inject the patch info banner into the page
     * @param {Object|null} info - Patch info from database
     * @param {boolean} hasOfficialKorean - Korean support status
     */
    function injectPatchInfo(info, hasOfficialKorean) {
        const renderId = ++patchRenderId;
        storageGet(['source_steamapp', 'source_quasarplay', 'source_directg', 'source_stove', 'disable_patch_info'])
            .then(settings => {
                if (renderId !== patchRenderId) return;
                if (settings.disable_patch_info === true) {
                    removePatchInfo();
                    return;
                }
                const patchTypeInfo = patchInfoReady ? getPatchTypeInfo(info, hasOfficialKorean) : {
                    label: patchInfoLoading ? '정보 조회 중' : '정보 조회 실패',
                    cssClass: 'unknown',
                    color: '#607d8b'
                };
                if (!patchTypeInfo) return;

                const isSourceEnabled = (source) => settings[`source_${source}`] !== false;

                // Find insertion target
                const noticeContent = Array.from(document.querySelectorAll('.notice_box_content')).find(notice => {
                    const text = notice.textContent || '';
                    return text.includes('한국어') && text.includes('지원하지 않습니다');
                });
                const noKoreanBox = noticeContent?.closest('#purchase_note, .notice_box') || noticeContent;
                const existingBanner = document.querySelector('.kr-patch-banner');
                const targetArea = noKoreanBox || existingBanner ||
                    document.querySelector('.game_area_purchase_game_wrapper') ||
                    document.querySelector('.game_area_purchase') ||
                    document.querySelector('#game_area_purchase');

                if (!targetArea) return;

                // Create banner elements
                const banner = createElement('div', 'kr-patch-banner');
                const content = createElement('div', 'kr-patch-content');
                banner.appendChild(content);

                const typeLabel = createElement('div', `kr-patch-type-label ${patchTypeInfo.cssClass}`, patchTypeInfo.label);
                typeLabel.style.backgroundColor = patchTypeInfo.color;
                content.appendChild(typeLabel);

                const dataArea = createElement('div', 'kr-patch-data-area');
                content.appendChild(dataArea);

                // Group links by source
                const linksBySource = new Map();

                if (info) {
                    const siteUrls = info.source_site_urls || {};
                    const links = info.links || [];
                    const patchSources = info.patch_sources || [];
                    const patchDescriptions = info.patch_descriptions || [];

                    for (let i = 0; i < links.length; i++) {
                        const source = patchSources[i];
                        if (!isSourceEnabled(source)) continue;

                        if (!linksBySource.has(source)) {
                            const url = siteUrls[source] || links[i];
                            // Validate URL before adding
                            if (!isValidSourceUrl(source, url)) continue;

                            linksBySource.set(source, {
                                url: url,
                                descriptions: []
                            });
                        }

                        const desc = formatSingleDescription(patchDescriptions[i]);
                        if (desc && linksBySource.has(source)) {
                            linksBySource.get(source).descriptions.push(desc);
                        }
                    }

                    if (patchTypeInfo === PATCH_TYPES.OFFICIAL_ESTIMATED) {
                        const allSources = info.sources || [];
                        for (const source of allSources) {
                            if (!isSourceEnabled(source)) continue;
                            if (linksBySource.has(source)) continue;

                            const url = siteUrls[source];

                            if (url && isValidSourceUrl(source, url)) {
                                // Collect descriptions belonging to this source
                                const sourceDescs = [];
                                for (let j = 0; j < patchSources.length; j++) {
                                    if (patchSources[j] === source) {
                                        const desc = formatSingleDescription(patchDescriptions[j]);
                                        if (desc) sourceDescs.push(desc);
                                    }
                                }
                                linksBySource.set(source, {
                                    url: url,
                                    descriptions: sourceDescs
                                });
                            }
                        }
                    }
                }

                const isOfficial = patchTypeInfo === PATCH_TYPES.OFFICIAL_STEAM ||
                    patchTypeInfo === PATCH_TYPES.OFFICIAL_WITH_USER ||
                    patchTypeInfo === PATCH_TYPES.OFFICIAL_ESTIMATED;
                const hasLinks = linksBySource.size > 0;
                const isOfficialEstimated = patchTypeInfo === PATCH_TYPES.OFFICIAL_ESTIMATED;

                // Helper function to render links list
                const renderLinksList = () => {
                    const listContainer = createElement('div', 'kr-patch-links-list');
                    let index = 1;

                    linksBySource.forEach((data, source) => {
                        const itemDiv = createElement('div', 'kr-patch-link-item');
                        const headerDiv = createElement('div', 'kr-patch-link-header');

                        const labelSpan = createElement('span', 'kr-patch-link-label', `${UI_STRINGS.LINK_PREFIX} ${index++}:`);
                        headerDiv.appendChild(labelSpan);

                        const linkAnchor = createElement('a', 'kr-patch-link-text', `[ ${getSourceLabel(source)} ]`);
                        linkAnchor.href = data.url;
                        linkAnchor.target = '_blank';
                        linkAnchor.rel = 'noopener noreferrer';
                        headerDiv.appendChild(linkAnchor);

                        itemDiv.appendChild(headerDiv);

                        if (data.descriptions.length > 0) {
                            const descContainer = createElement('div');
                            descContainer.style.marginTop = '5px';

                            data.descriptions.forEach(desc => {
                                const descDiv = createElement('div', 'kr-patch-link-description', desc);
                                descDiv.style.marginBottom = '4px';
                                descContainer.appendChild(descDiv);
                            });
                            itemDiv.appendChild(descContainer);
                        }

                        listContainer.appendChild(itemDiv);
                    });

                    return listContainer;
                };

                // OFFICIAL_ESTIMATED: Show explanation text first, then links
                if (!patchInfoReady) {
                    dataArea.appendChild(createElement('div', 'kr-patch-none-text', patchInfoLoading
                        ? '한국어 패치 정보를 불러오는 중입니다.'
                        : '패치 정보를 불러오지 못했습니다. 확장 프로그램에서 데이터를 새로고침해 주세요.'));
                } else if (isOfficialEstimated) {
                    const msgDiv = createElement('div', 'kr-patch-official-text');
                    msgDiv.textContent = UI_STRINGS.OFFICIAL_ESTIMATED_TEXT;
                    dataArea.appendChild(msgDiv);

                    // Show links below the explanation
                    if (hasLinks) {
                        const listContainer = renderLinksList();
                        listContainer.style.marginTop = '10px';
                        dataArea.appendChild(listContainer);
                    }
                } else if (hasLinks) {
                    // Other types with links: just show links
                    dataArea.appendChild(renderLinksList());

                } else if (isOfficial) {
                    // Official types without links
                    const msgDiv = createElement('div', 'kr-patch-official-text');
                    msgDiv.textContent = UI_STRINGS.OFFICIAL_SUPPORT_TEXT;
                    dataArea.appendChild(msgDiv);
                } else if (patchTypeInfo === PATCH_TYPES.NONE) {
                    dataArea.appendChild(createElement('div', 'kr-patch-none-text', UI_STRINGS.NO_PATCH_INFO_TEXT));
                } else {
                    dataArea.appendChild(createElement('div', 'kr-patch-none-text', UI_STRINGS.NO_LINK_TEXT));
                }

                // Insert banner into page
                if (noKoreanBox) {
                    if (existingBanner) existingBanner.remove();
                    replacedLanguageNotice = noKoreanBox;
                    noKoreanBox.replaceWith(banner);
                } else if (existingBanner) {
                    existingBanner.replaceWith(banner);
                } else {
                    targetArea.parentNode.insertBefore(banner, targetArea);
                }
            })
            .catch(err => console.error('[KOSTEAM] Storage error:', err));
    }

    // Listen for settings changes and re-render
    onStorageChanged((changes, namespace) => {
        if (namespace === 'local') {
            const hasSourceChange = Object.keys(changes).some(key => key.startsWith('source_'));
            const hasPatchToggle = Object.prototype.hasOwnProperty.call(changes, 'disable_patch_info');
            if (hasPatchToggle && changes.disable_patch_info?.newValue === true) {
                patchRequestId++;
                patchRenderId++;
                removePatchInfo();
                return;
            }
            if (hasSourceChange || hasPatchToggle || changes[CACHE_KEY] || changes[CACHE_ALIAS_KEY]) {
                refreshPatchInfo();
            }
        }
    });

    // Cleanup on page unload
    window.addEventListener('pagehide', () => {
        observerCleanups.splice(0).forEach(cleanup => cleanup());
    });
})();
