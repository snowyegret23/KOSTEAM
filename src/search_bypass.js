/**
 * KOSTEAM Search Bypass Script
 * Removes Steam's automatically selected Korean language filter on search/browse pages.
 */

import { storageGet } from './shared/api.js';

(function () {
    async function init() {
        const url = new URL(window.location.href);
        const isSearch = /^\/search(?:\/|$)/.test(url.pathname);
        const isBrowse = /^\/(?:category|genre|tags|vr|greatondeck|specials|sale)(?:\/|$)/.test(url.pathname);
        if (!isSearch && !isBrowse) return;

        try {
            const settings = await storageGet(['bypass_language_filter']);
            if (settings.bypass_language_filter === false) return;

            // Steam handles the default language filter before rendering results.
            // Preserve explicit search filters and avoid depending on click-handler timing.
            if (isSearch) {
                if (url.searchParams.get('ndl') !== '1') {
                    url.searchParams.set('ndl', '1');
                    window.location.replace(url.href);
                }
                return;
            }
            watchBrowseFilters();
        } catch (err) {
            console.debug('[KOSTEAM] Search bypass error:', err);
        }
    }

    function watchBrowseFilters() {
        if (!document.documentElement) {
            document.addEventListener('DOMContentLoaded', watchBrowseFilters, { once: true });
            return;
        }

        let finished = false;
        let openedMobileFilter = null;
        const observer = new MutationObserver(checkFilterState);

        function disconnect() {
            finished = true;
            observer.disconnect();
            document.removeEventListener('visibilitychange', checkFilterState);
        }

        function findMobileControl(root, labels) {
            const controls = Array.from(root.querySelectorAll('button, [role="button"], div')).filter(element => {
                if (!labels.includes(element.textContent?.trim())) return false;
                return element.matches('button, [role="button"]') ||
                    typeof element.onclick === 'function' || !!element.querySelector('svg.SVGIcon_Filter');
            });
            // Loading placeholders can leave an entire ancestor with only the
            // button's label. Click the innermost control, not that empty wrapper.
            return controls.find(element => !controls.some(other => other !== element && element.contains(other)));
        }

        function closeMobileFilter(root) {
            if (!openedMobileFilter) return;
            const closeLabels = ['닫기', 'Close'];
            const close = openedMobileFilter.isConnected && closeLabels.includes(openedMobileFilter.textContent?.trim())
                ? openedMobileFilter : findMobileControl(root, closeLabels);
            close?.click();
        }

        function checkFilterState() {
            if (finished || document.visibilityState === 'hidden') return;
            const root = document.querySelector('[data-featuretarget="sale-display"]') || document;
            const activeFilter = Array.from(root.querySelectorAll('a')).find(link => {
                // Selected facets have a removal icon and label, with no navigation target.
                const href = link.getAttribute('href');
                if (href && href !== '#') return false;
                if (!link.querySelector('svg')) return false;
                const label = link.querySelector('span')?.textContent?.trim() || '';
                return /^(?:한국어|Korean)(?:\s*\([^()]*\))?$/i.test(label);
            });
            if (activeFilter) {
                disconnect();
                activeFilter.click();
                closeMobileFilter(root);
            } else if (openedMobileFilter) {
                // Steam renders the input and empty option placeholders before
                // loading facet data. Wait for their labels before closing an empty panel.
                const options = Array.from(root.querySelectorAll('a[href=""]'));
                if (root.querySelector('input.DialogInput') && options.length > 0 &&
                    options.every(option => option.textContent?.trim())) {
                    disconnect();
                    closeMobileFilter(root);
                }
            } else {
                openedMobileFilter = findMobileControl(root, ['필터', 'Filter', 'Filters']);
                openedMobileFilter?.click();
            }
        }

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true
        });
        document.addEventListener('visibilitychange', checkFilterState);
        window.addEventListener('pagehide', disconnect, { once: true });
        checkFilterState();
    }

    init();
})();
