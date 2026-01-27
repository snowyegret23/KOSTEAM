/**
 * KOSTEAM Popup Script
 * Manages extension popup UI and user settings
 */

import { sendMessage, storageGet, storageSet } from './shared/api.js';
import { formatTimeAgo } from './shared/time-utils.js';
import { CACHE_KEY, MSG_CHECK_UPDATE_STATUS, MSG_REFRESH_DATA } from './shared/constants.js';

document.addEventListener('DOMContentLoaded', async () => {
    // DOM element references
    const gameCountEl = document.getElementById('gameCount');
    const remoteUpdateEl = document.getElementById('remoteUpdate');
    const dbStatusEl = document.getElementById('dbStatus');
    const statusEl = document.getElementById('status');
    const refreshBtn = document.getElementById('refreshBtn');

    // Source checkboxes
    const sourceIds = ['source_steamapp', 'source_quasarplay', 'source_directg', 'source_stove'];
    const sources = sourceIds.map(id => document.getElementById(id));
    const bypassCheckbox = document.getElementById('bypass_language_filter');
    const cartFeatureCheckbox = document.getElementById('cart_feature_enabled');

    /**
     * Load and display game count statistics
     */
    async function loadStats() {
        try {
            const result = await storageGet([CACHE_KEY]);

            if (result[CACHE_KEY]) {
                // Filter out _meta key when counting games
                const count = Object.keys(result[CACHE_KEY]).filter(k => k !== '_meta').length;
                gameCountEl.textContent = count.toLocaleString() + '개';
            }
        } catch (err) {
            console.error('[KOSTEAM] Failed to load stats:', err);
        }
    }

    /**
     * Check and display update status
     */
    async function checkUpdateStatus() {
        try {
            const response = await sendMessage({ type: MSG_CHECK_UPDATE_STATUS });

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
            console.error('[KOSTEAM] Failed to check update status:', err);
            dbStatusEl.textContent = '확인 실패';
            dbStatusEl.className = 'stat-value';
        }
    }

    /**
     * Handle refresh button click
     */
    refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '업데이트 중...';
        statusEl.textContent = '';
        statusEl.className = 'status';

        try {
            const response = await sendMessage({ type: MSG_REFRESH_DATA });

            if (response && response.success) {
                statusEl.textContent = '데이터가 업데이트되었습니다';
                statusEl.className = 'status success';
                await loadStats();
                await checkUpdateStatus();
            } else {
                throw new Error('Update failed');
            }
        } catch (err) {
            console.error('[KOSTEAM] Refresh failed:', err);
            statusEl.textContent = '✗ 업데이트 실패. 나중에 다시 시도해주세요.';
            statusEl.className = 'status error';
        }

        refreshBtn.disabled = false;
        refreshBtn.textContent = '데이터 새로고침';
    });

    /**
     * Load and initialize user settings
     */
    async function loadSettings() {
        try {
            const settings = await storageGet([...sourceIds, 'bypass_language_filter', 'cart_feature_enabled']);

            // Initialize source checkboxes
            sources.forEach(checkbox => {
                if (!checkbox) return;

                checkbox.checked = settings[checkbox.id] !== false;

                checkbox.addEventListener('change', () => {
                    storageSet({ [checkbox.id]: checkbox.checked });
                });
            });

            // Initialize bypass checkbox
            if (bypassCheckbox) {
                bypassCheckbox.checked = settings.bypass_language_filter !== false;
                bypassCheckbox.addEventListener('change', () => {
                    storageSet({ bypass_language_filter: bypassCheckbox.checked });
                });
            }

            if (cartFeatureCheckbox) {
                cartFeatureCheckbox.checked = settings.cart_feature_enabled !== false;
                cartFeatureCheckbox.addEventListener('change', () => {
                    storageSet({ cart_feature_enabled: cartFeatureCheckbox.checked });
                });
            }
        } catch (err) {
            console.error('[KOSTEAM] Failed to load settings:', err);
        }
    }

    // Initialize popup - run independent operations in parallel
    await Promise.all([
        loadStats(),
        loadSettings(),
        checkUpdateStatus()
    ]);
});
