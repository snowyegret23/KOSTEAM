/**
 * KOSTEAM Search Bypass Script
 * Automatically removes Korean language filter from Steam search/browse pages
 */

import { storageGet } from './shared/api.js';
import { LANGUAGE_TABLE_WATCH_TIMEOUT_MS } from './shared/constants.js';

(function () {
    /**
     * Initialize search bypass functionality
     */
    async function init() {
        try {
            const settings = await storageGet(['bypass_language_filter']);
            const isBypassEnabled = settings.bypass_language_filter !== false;

            if (!isBypassEnabled) return;

            const url = new URL(window.location.href);
            const path = url.pathname;

            // Handle /search pages - add ndl=1 parameter
            if (path === '/search' || path.startsWith('/search/')) {
                if (!url.searchParams.has('ndl') || url.searchParams.get('ndl') !== '1') {
                    url.searchParams.set('ndl', '1');
                    window.location.replace(url.toString());
                }
                return;
            }

            // Handle category/genre/tags pages - click to remove Korean filter
            if (path.startsWith('/category/')
                || path.startsWith('/genre/')
                || path.startsWith('/tags/')
                || path.startsWith('/vr')
                || path.startsWith('/greatondeck')
                || path.startsWith('/specials')
                || path.startsWith('/sale')
            ) {
                if (document.visibilityState === 'visible') {
                    removeKoreanFilter();
                }
                else {
                    document.addEventListener('visibilitychange', function onVisible() {
                        if (document.visibilityState === 'visible') {
                            removeKoreanFilter();
                            document.removeEventListener('visibilitychange', onVisible);
                        }
                    });
                }
            }
        } catch (err) {
            console.debug('[KOSTEAM] Search bypass error:', err);
        }
    }

    /**
     * Remove Korean language filter using MutationObserver
     * More efficient than polling with setTimeout
     */
    function removeKoreanFilter() {
        let found = false;

        /**
         * Try to find and click the Korean filter link
         * Uses structure-based selection (svg + span) instead of obfuscated class names
         * @returns {boolean} True if filter was found and clicked
         */
        function tryRemoveFilter() {
            const links = document.querySelectorAll('a');

            for (const link of links) {
                const svg = link.querySelector('svg');
                const span = link.querySelector('span');

                // Filter buttons have svg (X icon) + span (text) structure
                if (svg && span) {
                    const text = span.textContent.trim();
                    // Match Korean filter in both Korean and English UI
                    // Korean: "한국어", English: "한국어 (Korean)"
                    if (text === '한국어' || text === 'Korean' ||
                        text.includes('한국어') || text.includes('Korean')) {
                        link.click();
                        return true;
                    }
                }
            }
            return false;
        }

        /**
         * Check if we're on mobile view and open filter panel if needed
         * Mobile filter panel must be opened to access filter buttons
         * @returns {boolean} True if mobile filter was opened
         */
        function tryOpenMobileFilter() {
            // Mobile filter button has specific class and text "필터"
            const filterButtons = document.querySelectorAll('div');
            for (const btn of filterButtons) {
                const text = btn.textContent?.trim();
                // Check for filter button with click handler
                if (text === '필터' && typeof btn.onclick === 'function') {
                    btn.click();
                    return true;
                }
            }
            return false;
        }

        /**
         * Close mobile filter panel
         */
        function closeMobileFilter() {
            // Look for close button (X with "닫기" text)
            const closeButtons = document.querySelectorAll('div');
            for (const btn of closeButtons) {
                const text = btn.textContent?.trim();
                if (text === '닫기') {
                    btn.click();
                    return;
                }
            }
        }

        // Try immediately first (desktop)
        if (tryRemoveFilter()) return;

        // Try mobile filter immediately
        let mobileFilterOpened = tryOpenMobileFilter();

        // Use MutationObserver for efficiency
        const observer = new MutationObserver((mutations, obs) => {
            if (found) return;

            if (tryRemoveFilter()) {
                found = true;
                obs.disconnect();
                // Close mobile filter panel immediately if it was opened
                if (mobileFilterOpened) {
                    closeMobileFilter();
                }
            } else if (!mobileFilterOpened) {
                // Try opening mobile filter if not already opened
                mobileFilterOpened = tryOpenMobileFilter();
            }
        });

        // Start observing when DOM is ready
        function startObserver() {
            if (document.body) {
                observer.observe(document.body, {
                    childList: true,
                    subtree: true
                });

                // Cleanup observer after timeout
                setTimeout(() => {
                    if (!found) {
                        observer.disconnect();
                    }
                }, LANGUAGE_TABLE_WATCH_TIMEOUT_MS);
            }
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', startObserver);
        } else {
            startObserver();
        }
    }

    // Execute
    init();
})();
