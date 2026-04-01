/**
 * URL validation utilities for security
 */

// Allowed protocols for external links
const ALLOWED_PROTOCOLS = ['http:', 'https:'];

/**
 * Validates if a URL is safe to use as an href
 * Prevents javascript:, data:, and other potentially dangerous protocols
 *
 * @param {string} url - URL to validate
 * @returns {boolean} True if the URL is safe
 */
export function isValidUrl(url) {
    if (!url || typeof url !== 'string') {
        return false;
    }

    try {
        const parsed = new URL(url);
        return ALLOWED_PROTOCOLS.includes(parsed.protocol);
    } catch {
        return false;
    }
}