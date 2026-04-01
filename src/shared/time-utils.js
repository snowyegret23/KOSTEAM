/**
 * Time formatting utilities
 */

import {
    MS_PER_MINUTE,
    MS_PER_HOUR,
    MS_PER_DAY,
    MS_PER_WEEK
} from './constants.js';

/**
 * Formats a date string as a relative time in Korean
 *
 * @param {string} dateString - ISO date string
 * @returns {string} Formatted relative time (e.g., "5분 전", "2시간 전")
 */
export function formatTimeAgo(dateString) {
    if (!dateString) return '-';

    const date = new Date(dateString);
    if (isNaN(date.getTime())) return '-';
    const now = new Date();
    const diff = now - date;

    if (diff < MS_PER_MINUTE) return '방금 전';
    if (diff < MS_PER_HOUR) return Math.floor(diff / MS_PER_MINUTE) + '분 전';
    if (diff < MS_PER_DAY) return Math.floor(diff / MS_PER_HOUR) + '시간 전';
    if (diff < MS_PER_WEEK) return Math.floor(diff / MS_PER_DAY) + '일 전';

    return date.toLocaleDateString('ko-KR');
}
