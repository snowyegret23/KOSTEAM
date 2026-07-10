/**
 * KOSTEAM Search Bypass Script
 * Removes Steam's automatically selected Korean language filter.
 */

import { storageGet } from './shared/api.js';

(function () {
    const ACTIVE_KOREAN_FILTER = 'span.tab_filter_control[role="button"][data-param="supportedlang"][data-value="koreana"].checked';
    const LANGUAGE_FILTER_CONTROL = 'span.tab_filter_control[role="button"][data-param="supportedlang"]';

    async function init() {
        if (window.location.pathname !== '/search' && !window.location.pathname.startsWith('/search/')) return;

        try {
            const settings = await storageGet(['bypass_language_filter']);
            if (settings.bypass_language_filter === false) return;
            watchSelectedKoreanFilter();
        } catch (err) {
            console.debug('[KOSTEAM] Search bypass error:', err);
        }
    }

    function watchSelectedKoreanFilter() {
        if (!document.documentElement) {
            document.addEventListener('readystatechange', watchSelectedKoreanFilter, { once: true });
            return;
        }

        let clickedFilter = null;

        const observer = new MutationObserver(checkFilterState);

        function disconnect() {
            observer.disconnect();
        }

        function checkFilterState() {
            const activeFilter = document.querySelector(ACTIVE_KOREAN_FILTER);
            if (!activeFilter) {
                if (clickedFilter || document.querySelector(LANGUAGE_FILTER_CONTROL)) disconnect();
                return;
            }
            if (activeFilter === clickedFilter) return;

            clickedFilter = activeFilter;
            activeFilter.click();
        }

        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class'],
            childList: true,
            subtree: true
        });
        window.addEventListener('pagehide', disconnect, { once: true });
        checkFilterState();
    }

    init();
})();
