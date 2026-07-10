/**
 * URL validation utilities for security
 */

const SOURCE_HOSTS = {
    steamapp: new Set(['hanpe.net']),
    quasarplay: new Set(['store.steampowered.com']),
    directg: new Set(['www.directg.net']),
    stove: new Set(['store.onstove.com'])
};

/**
 * Validates if a URL is safe to use as an href
 * Prevents javascript:, data:, and other potentially dangerous protocols
 *
 * @param {string} url - URL to validate
 * @returns {boolean} True if the URL is safe
 */
export function isValidSourceUrl(source, url) {
    if (!SOURCE_HOSTS[source] || !url || typeof url !== 'string') {
        return false;
    }

    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' &&
            !parsed.username &&
            !parsed.password &&
            !parsed.port &&
            SOURCE_HOSTS[source].has(parsed.hostname);
    } catch {
        return false;
    }
}

export function isValidCheckoutUrl(url, baseUrl = 'https://store.steampowered.com/') {
    if (!url || typeof url !== 'string') return false;

    try {
        const parsed = new URL(url, baseUrl);
        const purchaseType = parsed.searchParams.get('purchasetype');
        return parsed.protocol === 'https:' &&
            parsed.hostname === 'checkout.steampowered.com' &&
            !parsed.username &&
            !parsed.password &&
            !parsed.port &&
            (!parsed.searchParams.has('purchasetype') || purchaseType === 'self') &&
            (parsed.pathname === '/checkout' || parsed.pathname.startsWith('/checkout/'));
    } catch {
        return false;
    }
}
