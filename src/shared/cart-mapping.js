import { isValidCartItem, MAX_STEAM_ITEM_ID } from './restore-validation.js';

function toSteamId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 && id <= MAX_STEAM_ITEM_ID ? id : null;
}

function normalizeLineItem(lineItem, index) {
    const bundleId = toSteamId(lineItem?.bundleid);
    const packageId = toSteamId(lineItem?.packageid);
    const item = bundleId
        ? { id: bundleId, type: 'bundle' }
        : { id: packageId, type: 'package' };

    if (!isValidCartItem(item)) return null;
    return {
        ...item,
        bundleId,
        packageId,
        index,
        lineItemId: String(lineItem?.line_item_id || '')
    };
}

/**
 * Map DOM-derived identifiers to Steam cart line items without relying on order.
 * Duplicate packages are deliberately consumed as a multiset.
 */
export function mapCartEntries(entries, lineItems, appPackagesById = new Map()) {
    if (!Array.isArray(entries) || !Array.isArray(lineItems) || entries.length !== lineItems.length) {
        return [];
    }

    const infos = lineItems.map(normalizeLineItem);
    if (infos.some(info => !info)) return [];

    const mapped = new Array(entries.length).fill(null);
    const used = new Set();
    const consume = predicate => {
        const info = infos.find(candidate => !used.has(candidate.index) && predicate(candidate));
        if (!info) return null;
        used.add(info.index);
        return { id: info.id, type: info.type };
    };

    entries.forEach((entry, index) => {
        if (!entry?.lineItemId) return;
        mapped[index] = consume(candidate => candidate.lineItemId === String(entry.lineItemId));
    });

    entries.forEach((entry, index) => {
        if (mapped[index]) return;
        const bundleId = toSteamId(entry?.bundleId);
        if (!bundleId) return;
        mapped[index] = consume(candidate => candidate.type === 'bundle' && candidate.bundleId === bundleId);
    });

    entries.forEach((entry, index) => {
        if (mapped[index]) return;
        const packageId = toSteamId(entry?.packageId);
        if (!packageId) return;
        mapped[index] = consume(candidate => candidate.type === 'package' && candidate.packageId === packageId);
    });

    entries.forEach((entry, index) => {
        if (mapped[index]) return;
        const appId = toSteamId(entry?.appId);
        if (!appId) return;

        const packages = appPackagesById instanceof Map
            ? appPackagesById.get(appId)
            : appPackagesById?.[appId];
        if (!Array.isArray(packages)) return;

        const candidates = Array.from(new Set(
            packages
                .map(toSteamId)
                .filter(Boolean)
                .filter(packageId => infos.some(candidate =>
                    !used.has(candidate.index) &&
                    candidate.type === 'package' &&
                    candidate.packageId === packageId))
        ));

        if (candidates.length !== 1) return;
        mapped[index] = consume(candidate =>
            candidate.type === 'package' && candidate.packageId === candidates[0]);
    });

    return mapped;
}
