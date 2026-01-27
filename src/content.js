/**
 * KOSTEAM Content Script
 * Injects Korean patch info banner into Steam app pages
 */

import { sendMessage, storageGet, onStorageChanged } from './shared/api.js';
import { isValidUrl } from './shared/url-validator.js';
import {
    PATCH_TYPES,
    SOURCE_LABELS,
    MSG_GET_PATCH_INFO,
    KOREAN_LABELS,
    UI_STRINGS,
    CURATOR_SCROLL_TIMEOUT_MS,
    LANGUAGE_TABLE_WATCH_TIMEOUT_MS,
    SEARCH_BYPASS_RETRY_DELAY_MS
} from './shared/constants.js';

(async function () {
    // Extract appId from URL
    const appIdMatch = window.location.pathname.match(/\/app\/(\d+)/);
    if (!appIdMatch) return;

    const appId = appIdMatch[1];

    let patchInfoData = null;
    let observerCleanup = null;

    // Check if URL has curator_clanid parameter and scroll to curator review
    handleCuratorLink();

    // Request patch info from background
    sendMessage({ type: MSG_GET_PATCH_INFO, appId })
        .then(response => {
            patchInfoData = response?.info;
            startLanguageTableWatcher();
        })
        .catch(err => console.debug('[KOSTEAM] Message error:', err));

    /**
     * Handle curator link - scroll to curator review section if curator_clanid is in URL
     */
    function handleCuratorLink() {
        const urlParams = new URLSearchParams(window.location.search);
        const curatorClanId = urlParams.get('curator_clanid');

        if (!curatorClanId) return;

        // Function to find and scroll to curator review
        const scrollToCuratorReview = () => {
            // Look for curator review section by class
            const curatorSection = document.querySelector('.referring_curator_ctn');

            if (curatorSection) {
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
            subtree: true
        });

        // Stop trying after timeout
        setTimeout(() => observer.disconnect(), CURATOR_SCROLL_TIMEOUT_MS);
    }

    /**
     * Start watching for language table and periodically check for updates
     */
    function startLanguageTableWatcher() {
        let lastKoreanSupport = null;
        let pollInterval = null;

        /**
         * Check Korean support and update UI if changed
         */
        function checkAndUpdate() {
            const currentSupport = checkOfficialKoreanSupport();
            if (currentSupport !== lastKoreanSupport) {
                lastKoreanSupport = currentSupport;
                injectPatchInfo(patchInfoData, currentSupport);
            }
        }

        // MutationObserver to detect when language table is added to DOM
        const observer = new MutationObserver(() => {
            const table = document.querySelector('.game_language_options');
            if (table) {
                checkAndUpdate();
            }
        });

        // Start observing DOM changes
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        // Polling interval to continuously check (fallback for edge cases)
        pollInterval = setInterval(() => {
            checkAndUpdate();
        }, SEARCH_BYPASS_RETRY_DELAY_MS);

        // Initial check
        checkAndUpdate();

        // Cleanup function
        observerCleanup = () => {
            observer.disconnect();
            if (pollInterval) {
                clearInterval(pollInterval);
            }
        };

        // Stop polling after timeout (language table should be loaded by then)
        setTimeout(() => {
            if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
            }
            // Keep MutationObserver running in case of dynamic changes
        }, LANGUAGE_TABLE_WATCH_TIMEOUT_MS);
    }

    /**
     * Check if the game has official Korean language support on Steam
     * @returns {boolean}
     */
    function checkOfficialKoreanSupport() {
        const rows = document.querySelectorAll('.game_language_options tr');

        for (const row of rows) {
            if (row.classList.contains('unsupported')) continue;

            const firstCell = row.querySelector('td.ellipsis');
            if (!firstCell) continue;

            const text = firstCell.textContent?.trim() || '';
            if (KOREAN_LABELS.includes(text)) {
                const checks = row.querySelectorAll('td.checkcol');
                for (const check of checks) {
                    if (check.textContent?.includes('✔') || check.querySelector('span')) {
                        return true;
                    }
                }
            }
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


    /**
     * Inject the patch info banner into the page
     * @param {Object|null} info - Patch info from database
     * @param {boolean} hasOfficialKorean - Korean support status
     */
    function injectPatchInfo(info, hasOfficialKorean) {

        storageGet(['source_steamapp', 'source_quasarplay', 'source_directg', 'source_stove', 'disable_patch_info'])
            .then(settings => {
                if (settings.disable_patch_info === true) {
                    const existingBanner = document.querySelector('.kr-patch-banner');
                    if (existingBanner) existingBanner.remove();
                    return;
                }
                const patchTypeInfo = getPatchTypeInfo(info, hasOfficialKorean);
                if (!patchTypeInfo) return;

                const isSourceEnabled = (source) => settings[`source_${source}`] !== false;

                // Find insertion target
                let targetArea = document.querySelector('.game_language_options');
                let noKoreanBox = null;

                // Look for "Korean not supported" notice
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
                            if (!isValidUrl(url)) continue;

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

                            let url = siteUrls[source];

                            // Generate URL dynamically if not in source_site_urls (steamapp only)
                            // appId is already validated by URL regex pattern /\/app\/(\d+)/
                            if (!url && source === 'steamapp') {
                                url = `https://steamapp.net/app/${encodeURIComponent(appId)}`;
                            }

                            if (url && isValidUrl(url)) {
                                linksBySource.set(source, {
                                    url: url,
                                    descriptions: []
                                });
                            }
                        }
                    }
                }

                const isOfficial = patchTypeInfo.label.includes('공식');
                const hasLinks = linksBySource.size > 0;
                const isOfficialEstimated = patchTypeInfo.label === PATCH_TYPES.OFFICIAL_ESTIMATED.label;

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
                if (isOfficialEstimated) {
                    const msgDiv = createElement('div', 'kr-patch-official-text');
                    msgDiv.textContent = UI_STRINGS.OFFICIAL_ESTIMATED_TEXT;
                    msgDiv.appendChild(document.createElement('br'));
                    msgDiv.appendChild(document.createTextNode(UI_STRINGS.OFFICIAL_ESTIMATED_SUBTEXT));
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
                } else if (patchTypeInfo.cssClass === 'none') {
                    dataArea.appendChild(createElement('div', 'kr-patch-none-text', UI_STRINGS.NO_PATCH_INFO_TEXT));
                } else {
                    dataArea.appendChild(createElement('div', 'kr-patch-none-text', UI_STRINGS.NO_LINK_TEXT));
                }

                // Insert banner into page
                const existingBanner = document.querySelector('.kr-patch-banner');
                if (existingBanner) {
                    existingBanner.replaceWith(banner);
                } else if (noKoreanBox) {
                    noKoreanBox.replaceWith(banner);
                } else if (targetArea) {
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
                const existingBanner = document.querySelector('.kr-patch-banner');
                if (existingBanner) existingBanner.remove();
                return;
            }
            if (hasSourceChange || hasPatchToggle) {
                sendMessage({ type: MSG_GET_PATCH_INFO, appId })
                    .then(response => {
                        if (response && response.success) {
                            const currentSupport = checkOfficialKoreanSupport();
                            injectPatchInfo(response.info, currentSupport);
                        }
                    })
                    .catch(err => console.debug('[KOSTEAM] Re-render error:', err));
            }
        }
    });

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
        if (observerCleanup) {
            observerCleanup();
        }
    });
})();
