/**
 * KOSTEAM Cart Enhancer
 * Adds per-item selection and checkout controls in Steam cart
 */

import { sendMessage, storageGet } from './shared/api.js';
import { waitForKeySet, waitForObservedCondition } from './shared/cart_state.js';
import { getRemoveControlIndex, isContextualRemoveControl } from './shared/cart-controls.js';
import { mapCartEntries } from './shared/cart-mapping.js';
import { getCartRecoveryPlan, getMissingCartItems } from './shared/cart-recovery.js';
import { isValidCheckoutUrl } from './shared/url-validator.js';
import { isValidCartItem, MAX_CART_RESTORE_ITEMS } from './shared/restore-validation.js';
import {
    CART_FEATURE_KEY,
    CART_PURCHASE_COMPLETE_KEY,
    MSG_CLEAR_CART_RESTORE,
    MSG_MARK_CART_CHECKOUT_STARTED,
    MSG_RECOVER_CART,
    MSG_RESTORE_CART,
    MSG_SAVE_CART_RESTORE,
    PENDING_CART_RESTORE_KEY
} from './shared/constants.js';

(async function () {
    const CART_PATH_PREFIX = '/cart';
    const RESTORE_SOURCE_TAG = 'main-cluster-topseller';
    const DISABLE_CART_DIALOGS = false;
    const PRICE_CURRENCY_PATTERNS = [
        /₩\s?([\d,]+)/g,
        /\$\s?([\d,]+(?:\.\d{1,2})?)/g,
        /€\s?([\d,]+(?:\.\d{1,2})?)/g,
        /£\s?([\d,]+(?:\.\d{1,2})?)/g
    ];
    const SELECTORS = [
        '[data-line-item-id]',
        '[data-cart-item-id]',
        '[data-ds-appid]',
        '.cart_item',
        '.cart_item_row',
        '.cart_row',
        '.cart_item_wrapper'
    ];
    const CART_REMOVE_TIMEOUT_MS = 15000;
    const MAX_IMPORT_FILE_BYTES = 1024 * 1024;

    if (window.location.pathname !== CART_PATH_PREFIX &&
        !window.location.pathname.startsWith(`${CART_PATH_PREFIX}/`)) return;

    // Remove the page-origin snapshot left by versions before 1.6.4.
    try {
        window.localStorage.removeItem('kosteam_cart_snapshot');
    } catch {
        // Storage access can be blocked by browser privacy settings.
    }

    try {
        const settings = await storageGet([CART_FEATURE_KEY]);
        if (settings[CART_FEATURE_KEY] !== true) return;
    } catch {
        return;
    }

    window.addEventListener('pageshow', event => {
        if (event.persisted) window.location.reload();
    });

    const selectedKeys = new Set();
    let refreshScheduled = false;
    let checkoutInProgress = false;
    let allowNativeCheckoutClick = false;
    let pendingRecoveryBlocked = false;

    document.addEventListener('click', guardNativeCheckoutDuringSelection, true);

    // ========== Data Access Functions ==========

    function getStoreUserConfigJson() {
        const el = document.querySelector('#application_config');
        if (!el) return null;
        const raw = el.getAttribute('data-store_user_config')
            || el.getAttribute('data-store-user-config')
            || el.dataset.storeUserConfig
            || '';
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch (err) {
            console.debug('[KOSTEAM] JSON parse error:', err);
            return null;
        }
    }

    function getWebApiToken() {
        const cfg = getStoreUserConfigJson();
        return cfg?.webapi_token || '';
    }

    function getAccountCountryCode() {
        const raw = document.querySelector('#application_config')?.getAttribute('data-userinfo') || '';
        try {
            const code = JSON.parse(raw)?.country_code;
            return typeof code === 'string' && /^[A-Z]{2}$/.test(code) ? code : '';
        } catch {
            return '';
        }
    }

    function getCartLineItems() {
        const cfg = getStoreUserConfigJson();
        const items = cfg?.accountcart?.cart?.line_items;
        return Array.isArray(items) ? items : [];
    }

    function isSimpleRecoverableLineItem(lineItem) {
        if (!lineItem || typeof lineItem !== 'object') return false;
        const flags = lineItem.flags && typeof lineItem.flags === 'object' ? lineItem.flags : {};
        const hasSpecialFlag = Object.values(flags).some(value => {
            if (value === false || value === 0 || value === '0' || value == null) return false;
            return true;
        });
        const hasGiftInfo = lineItem.gift_info &&
            typeof lineItem.gift_info === 'object' &&
            Object.keys(lineItem.gift_info).length > 0;
        const hasCoupon = Number(lineItem.gidcoupon_applied || 0) > 0;
        return !hasSpecialFlag && !hasGiftInfo && !hasCoupon;
    }

    // ========== DOM Utility Functions ==========

    function getItemKey(item) {
        const reference = getStoreItemReference(item);
        return reference ? `${reference.type}:${reference.id}` : null;
    }

    function getItemSelectionKey(item, items = findCartItems()) {
        const baseKey = getItemKey(item);
        if (!baseKey) return null;

        let occurrence = 0;
        for (const currentItem of items) {
            if (getItemKey(currentItem) !== baseKey) continue;
            if (currentItem === item) return `${baseKey}::${occurrence}`;
            occurrence++;
        }
        return baseKey;
    }

    function getLineItemId(item) {
        if (!item?.getAttribute) return null;
        const direct = item.getAttribute('data-line-item-id') || item.getAttribute('data-line_item_id');
        if (direct) return direct;
        if (item.dataset?.lineItemId) return item.dataset.lineItemId;
        const nested = item.querySelector('[data-line-item-id], [data-line_item_id]');
        if (!nested) return null;
        const nestedValue = nested.getAttribute('data-line-item-id') || nested.getAttribute('data-line_item_id');
        return nestedValue || null;
    }

    function getCartRoot() {
        return document.querySelector('#page_root') || document.body;
    }

    function findItemLink(item) {
        if (!item?.querySelector) return null;
        for (const selector of ['a[href*="/bundle/"]', 'a[href*="/sub/"]', 'a[href*="/app/"]']) {
            const link = item.querySelector(selector);
            if (link) return link;
        }
        return null;
    }

    function getStoreItemReference(item) {
        const link = findItemLink(item);
        if (!link) return null;

        try {
            const url = new URL(link.href, window.location.origin);
            if (url.protocol !== 'https:' || url.hostname !== 'store.steampowered.com') return null;
            const match = url.pathname.match(/^\/(app|sub|bundle)\/(\d+)(?:\/|$)/);
            if (!match) return null;
            const id = Number(match[2]);
            return isValidCartItem({
                id,
                type: match[1] === 'bundle' ? 'bundle' : 'package'
            }) ? { type: match[1], id } : null;
        } catch {
            return null;
        }
    }

    // ========== Cart Item Detection ==========

    function isRecommendationItem(item) {
        const recContainer = item.closest('[class*="Discovery"], [class*="Recommend"], [class*="recommend"]');
        return !!recContainer;
    }

    function looksLikeCartItem(node) {
        if (!node?.querySelector) return false;
        const links = Array.from(node.querySelectorAll('a[href*="/app/"], a[href*="/sub/"], a[href*="/bundle/"]'));
        if (links.length === 0) return false;
        if (links.length !== 1 && !node.querySelector('a[href*="/sub/"], a[href*="/bundle/"]')) {
            const appKeys = links
                .map(link => {
                    const href = link.getAttribute('href') || '';
                    const match = href.match(/\/app\/(\d+)/);
                    return match ? `app:${match[1]}` : null;
                })
                .filter(Boolean);
            if (new Set(appKeys).size !== 1) return false;
        }
        if (!findRemoveButton(node)) return false;
        return true;
    }

    function collectBySelectors(root) {
        const seen = new Set();
        const candidates = [];
        for (const selector of SELECTORS) {
            root.querySelectorAll(selector).forEach(el => {
                if (!seen.has(el)) {
                    seen.add(el);
                    candidates.push(el);
                }
            });
        }
        return candidates;
    }

    function collectByAppLinks(root) {
        const links = root.querySelectorAll('a[href*="/app/"], a[href*="/sub/"], a[href*="/bundle/"]');
        const items = [];
        links.forEach(link => {
            let node = link.parentElement;
            let depth = 0;
            while (node && node !== document.body && depth < 8) {
                if (looksLikeCartItem(node)) {
                    items.push(node);
                    break;
                }
                node = node.parentElement;
                depth++;
            }
        });
        return items;
    }

    function uniqueLeaf(items) {
        const unique = Array.from(new Set(items));
        return unique.filter(el => !unique.some(other => other !== el && el.contains(other)));
    }

    function findCartItems() {
        const cartRoot = getCartRoot();
        const merged = [
            ...collectBySelectors(cartRoot),
            ...collectByAppLinks(cartRoot)
        ]
            .filter(item => !isRecommendationItem(item))
            .filter(item => looksLikeCartItem(item))
            .filter(el => findItemLink(el));

        const unique = uniqueLeaf(merged);

        // Sort by visual position (Y coordinate) to match line_items order
        unique.sort((a, b) => {
            const rectA = a.getBoundingClientRect();
            const rectB = b.getBoundingClientRect();
            return rectA.top - rectB.top;
        });

        return unique;
    }

    // ========== Remove Button Detection ==========

    function isUsableControl(control) {
        if (!control?.isConnected || control.hidden) return false;
        if (control.getAttribute('aria-disabled') === 'true') return false;
        if (control.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
        if ('disabled' in control && control.disabled) return false;

        const style = window.getComputedStyle(control);
        if (style.display === 'none' || style.visibility === 'hidden' ||
            Number(style.opacity) === 0 || style.pointerEvents === 'none') return false;

        const rect = control.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function normalizeAccessibleName(value) {
        return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    }

    function isItemTitleContextId(item, contextId) {
        const context = document.getElementById(contextId);
        if (!context?.isConnected || !item.contains(context)) return false;

        const itemLink = findItemLink(item);
        if (!itemLink) return false;

        const contextName = normalizeAccessibleName(context.textContent);
        const linkedNames = [
            itemLink.getAttribute('aria-label'),
            itemLink.getAttribute('title'),
            itemLink.querySelector('img[alt]')?.getAttribute('alt'),
            itemLink.textContent
        ]
            .map(normalizeAccessibleName)
            .filter(Boolean);

        // This compares the product identity exposed by two related elements;
        // it does not depend on localized Add/Remove wording.
        return !!contextName && linkedNames.includes(contextName);
    }

    function findRemoveControlsByAccessibility(item) {
        return Array.from(item.querySelectorAll('[role="button"]')).filter(control => (
            isUsableControl(control) &&
            isContextualRemoveControl({
                id: control.id,
                labelledBy: control.getAttribute('aria-labelledby'),
                title: control.getAttribute('title')
            }, contextId => isItemTitleContextId(item, contextId))
        ));
    }

    function findRemoveControlsByStructure(item) {
        const parents = new Set(
            Array.from(item.querySelectorAll('[role="button"]'))
                .map(control => control.parentElement)
                .filter(Boolean)
        );
        const matches = new Set();

        for (const parent of parents) {
            const controls = Array.from(parent.children)
                .filter(child => child.getAttribute('role') === 'button');
            if (!controls.every(isUsableControl)) continue;
            const removeIndex = getRemoveControlIndex(
                controls.map(control => ({
                    id: control.id,
                    labelledBy: control.getAttribute('aria-labelledby'),
                    title: control.getAttribute('title')
                })),
                contextId => isItemTitleContextId(item, contextId)
            );
            if (removeIndex >= 0) matches.add(controls[removeIndex]);
        }

        return Array.from(matches);
    }

    function findRemoveButton(item) {
        const candidates = new Set(
            Array.from(item.querySelectorAll(
                '[data-cart-remove], [data-action="remove"], .remove_link, .cart_remove'
            )).filter(isUsableControl)
        );
        findRemoveControlsByAccessibility(item).forEach(control => candidates.add(control));
        return candidates.size === 1 ? candidates.values().next().value : null;
    }

    function findReAddableRemoveButton(item) {
        const removeButton = findRemoveButton(item);
        if (!removeButton) return null;
        const structuralMatches = findRemoveControlsByStructure(item);
        return structuralMatches.length === 1 && structuralMatches[0] === removeButton
            ? removeButton
            : null;
    }

    function hasReAddableActionPair(item) {
        return !!findReAddableRemoveButton(item);
    }

    // ========== Smart Cart Mapping ==========
    //
    // DOM 순서와 API line_items 순서가 다를 수 있음
    //
    // 정확한 line-item ID, bundle/sub URL, appdetails package ID만 사용한다.
    // Steam의 DOM 순서와 API 순서는 다를 수 있으므로 순서 기반 추정은 하지 않는다.

    /**
     * DOM 항목들을 API line_items와 매핑
     * @param {HTMLElement[]} domItems - DOM 항목 배열
     * @returns {Map<HTMLElement, {id: number, type: 'package'|'bundle'}>}
     */
    async function mapDomItemsToCartInfo(domItems) {
        const map = new Map();
        const lineItems = getCartLineItems();

        const entries = domItems.map(item => {
            const reference = getStoreItemReference(item);
            return {
                lineItemId: getLineItemId(item),
                bundleId: reference?.type === 'bundle' ? reference.id : null,
                packageId: reference?.type === 'sub' ? reference.id : null,
                appId: reference?.type === 'app' ? reference.id : null
            };
        });

        const appIds = Array.from(new Set(entries.map(entry => entry.appId).filter(Boolean)));
        const appPackagesById = new Map(await Promise.all(
            appIds.map(async appId => [appId, await fetchAppPackageIds(appId)])
        ));
        const mappings = mapCartEntries(entries, lineItems, appPackagesById);
        mappings.forEach((info, index) => {
            if (info) map.set(domItems[index], info);
        });

        return map;
    }

    /**
     * DOM 항목 개수와 line_items 개수가 일치하는지 확인
     * @param {number} domCount - DOM 항목 개수
     * @returns {boolean}
     */
    function validateCartSync(domCount) {
        const lineItems = getCartLineItems();
        return lineItems.length === domCount;
    }

    function getCartItemKeys() {
        return findCartItems()
            .map(item => getItemKey(item))
            .filter(Boolean);
    }

    function observeCartChanges(callback) {
        const root = getCartRoot();
        const cartObserver = new MutationObserver(callback);
        cartObserver.observe(root, {
            attributes: true,
            childList: true,
            subtree: true
        });
        return () => cartObserver.disconnect();
    }

    function observeCheckoutChanges(callback) {
        const root = document.querySelector('#page_root') || document.body;
        const checkoutObserver = new MutationObserver(callback);
        checkoutObserver.observe(root, {
            attributes: true,
            attributeFilter: ['aria-disabled', 'aria-hidden', 'class', 'disabled', 'hidden', 'style'],
            childList: true,
            subtree: true
        });
        return () => checkoutObserver.disconnect();
    }

    function waitForCartKeys(expectedKeys) {
        return waitForKeySet({
            expectedKeys,
            getCurrentKeys: getCartItemKeys,
            observe: observeCartChanges,
            timeoutMs: CART_REMOVE_TIMEOUT_MS
        });
    }

    async function waitForNativeCheckoutButtonReady() {
        const ready = await waitForObservedCondition({
            condition: () => !!findNativeCheckoutButton({ requireReady: true }),
            observe: observeCheckoutChanges,
            timeoutMs: CART_REMOVE_TIMEOUT_MS
        });

        return ready ? findNativeCheckoutButton({ requireReady: true }) : null;
    }

    async function removeCartItemsSequentially(itemsToRemove, expectedRemainingKeys) {
        const expectedKeys = getCartItemKeys();
        const removedItems = [];

        for (let i = itemsToRemove.length - 1; i >= 0; i--) {
            const target = itemsToRemove[i];
            if (!target.key || !isValidCartItem(target.cartInfo)) {
                return { success: false, removedItems, ambiguous: false };
            }

            const currentItems = findCartItems();
            let item = null;
            if (target.element?.isConnected && currentItems.includes(target.element)) {
                item = target.element;
            }
            if (!item && target.selectionKey) {
                item = currentItems.find(cartItem => getItemSelectionKey(cartItem, currentItems) === target.selectionKey);
            }
            if (!item) {
                item = currentItems.find(cartItem => getItemKey(cartItem) === target.key);
            }

            if (!item) {
                // A missing node can be a transient React re-render. Do not
                // guess that Steam removed it: keep the prepared transaction
                // so a reload can compare the full cart multiset safely.
                return { success: false, removedItems, ambiguous: true };
            }

            const expectedIndex = expectedKeys.indexOf(target.key);
            if (expectedIndex >= 0) expectedKeys.splice(expectedIndex, 1);

            // Revalidate the paired Add/Remove relationship immediately before
            // every destructive click because React may have replaced the item.
            const removeButton = findReAddableRemoveButton(item);
            if (!removeButton) return { success: false, removedItems, ambiguous: false };

            removeButton.click();
            const removed = await waitForCartKeys(expectedKeys);
            if (!removed) return { success: false, removedItems, ambiguous: true };
            removedItems.push(target.cartInfo);
        }

        return {
            success: await waitForCartKeys(expectedRemainingKeys),
            removedItems
        };
    }

    // ========== Price Handling ==========

    function getItemPrice(item) {
        if (item.dataset?.kosteamPrice) {
            return {
                value: Number(item.dataset.kosteamPrice),
                currency: item.dataset.kosteamCurrency || ''
            };
        }

        const priceInfo = parsePriceText(item.textContent || '');
        if (priceInfo && item.dataset) {
            item.dataset.kosteamPrice = String(priceInfo.value);
            item.dataset.kosteamCurrency = priceInfo.currency;
        }
        if (priceInfo) return priceInfo;
        return null;
    }

    function parsePriceText(text) {
        if (!text) return null;
        for (const pattern of PRICE_CURRENCY_PATTERNS) {
            const matches = [...text.matchAll(pattern)];
            if (matches.length > 0) {
                const last = matches[matches.length - 1];
                const raw = last[1].replace(/,/g, '');
                const value = Number(raw);
                if (!Number.isNaN(value)) {
                    const currency = last[0].trim().replace(raw, '').trim();
                    return { value, currency };
                }
            }
        }
        return null;
    }

    const appPackageCache = new Map();

    async function fetchAppPackageIds(appId) {
        if (appPackageCache.has(appId)) return appPackageCache.get(appId);
        try {
            const countryCode = getAccountCountryCode();
            if (!countryCode) throw new Error('Missing Steam country code');
            const params = new URLSearchParams({
                appids: String(appId),
                cc: countryCode,
                l: 'english'
            });
            const url = `https://store.steampowered.com/api/appdetails?${params}`;
            const res = await fetch(url, { credentials: 'omit' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            const data = json?.[String(appId)]?.data;
            const packages = Array.isArray(data?.packages)
                ? data.packages.map(id => Number(id)).filter(id => id > 0)
                : [];
            appPackageCache.set(appId, packages);
            return packages;
        } catch (err) {
            appPackageCache.set(appId, []);
            return [];
        }
    }

    function formatCurrency(value, currency) {
        if (currency.includes('₩')) return `₩ ${value.toLocaleString('ko-KR')}`;
        if (currency.includes('$')) return `$${value.toLocaleString('en-US')}`;
        if (currency.includes('€')) return `€${value.toLocaleString('de-DE')}`;
        if (currency.includes('£')) return `£${value.toLocaleString('en-GB')}`;
        return `${currency}${value.toLocaleString()}`;
    }

    // ========== Export Functions ==========

    function extractItemName(item) {
        const link = findItemLink(item);
        if (!link) return null;

        const img = link.querySelector('img');
        if (img?.alt) return img.alt;

        const text = link.textContent?.trim();
        if (text) return text;

        const titleEl = item.querySelector('[class*="title"], [class*="name"], h1, h2, h3, h4');
        return titleEl?.textContent?.trim() || null;
    }

    function extractItemLink(item) {
        const reference = getStoreItemReference(item);
        return reference ? `https://store.steampowered.com/${reference.type}/${reference.id}` : null;
    }

    function extractAppIds(item) {
        const ids = new Set();
        const links = item.querySelectorAll('a[href*="/app/"]');
        links.forEach(link => {
            const href = link.getAttribute('href') || '';
            const match = href.match(/\/app\/(\d+)/);
            if (match) ids.add(Number(match[1]));
        });
        return Array.from(ids);
    }

    async function buildExportData(items, options = {}) {
        const cartInfoMap = await mapDomItemsToCartInfo(items);
        const selectedElements = options.selectedElements instanceof Set ? options.selectedElements : null;

        const exportItems = items.map((item, index) => {
            const cartInfo = cartInfoMap.get(item);
            const name = extractItemName(item) || `Item ${index + 1}`;
            const link = extractItemLink(item) || '';
            const priceInfo = getItemPrice(item);

            const exportItem = {
                name,
                type: cartInfo?.type || 'package',
                link
            };

            if (selectedElements) exportItem.selected = selectedElements.has(item);

            // Set ID based on type
            if (cartInfo?.type === 'bundle') {
                exportItem.bundleId = cartInfo.id;
            } else if (cartInfo?.id) {
                exportItem.packageId = cartInfo.id;
            }

            if (priceInfo) exportItem.price = formatCurrency(priceInfo.value, priceInfo.currency);

            return exportItem;
        });

        return {
            exportedAt: new Date().toISOString(),
            itemCount: exportItems.length,
            items: exportItems
        };
    }

    async function downloadSelectedCheckoutBackup(items, checkedItems, uncheckedItems) {
        const selectedElements = new Set(checkedItems.map(item => item.element));
        const exportData = await buildExportData(items, { selectedElements });
        exportData.backupReason = 'selected_checkout';
        exportData.selectedItemCount = checkedItems.length;
        exportData.unselectedItemCount = uncheckedItems.length;
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        downloadJson(exportData, `steam-cart-selected-checkout-backup-${stamp}`);
    }

    function downloadJson(data, filename) {
        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${filename}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // ========== Restore Transaction Functions ==========

    async function savePendingRestore(snapshot) {
        try {
            const token = getWebApiToken();
            const countryCode = getAccountCountryCode();
            if (!token) return { success: false, error: 'missing_token' };
            if (!countryCode) return { success: false, error: 'missing_country_code' };

            return await sendMessage({
                type: MSG_SAVE_CART_RESTORE,
                token,
                items: snapshot.removedItems,
                remainingItems: snapshot.remainingItems,
                countryCode,
                sourceTag: RESTORE_SOURCE_TAG
            });
        } catch (err) {
            console.debug('[KOSTEAM] Pending restore save error:', err);
            return { success: false, error: err.message };
        }
    }

    async function clearPendingRestore(transactionId, recoveryRevision) {
        try {
            return await sendMessage({
                type: MSG_CLEAR_CART_RESTORE,
                transactionId,
                recoveryRevision
            });
        } catch (err) {
            console.debug('[KOSTEAM] Pending restore clear error:', err);
            return { success: false, error: err.message };
        }
    }

    function getSessionId() {
        return window.g_sessionID || (document.cookie.match(/sessionid=([^;]+)/) || [])[1] || '';
    }

    async function sendAppIdsToWishlist(appIds) {
        const sessionid = getSessionId();
        if (!sessionid) {
            if (!DISABLE_CART_DIALOGS) {
                window.alert('찜목록 요청 실패: 세션 정보를 찾을 수 없습니다.');
            }
            return { added: 0, failed: appIds.length };
        }

        let added = 0;
        let failed = 0;
        for (const appId of appIds) {
            try {
                const form = new URLSearchParams();
                form.set('appid', String(appId));
                form.set('sessionid', sessionid);
                const res = await fetch('https://store.steampowered.com/api/addtowishlist', {
                    method: 'POST',
                    body: form,
                    credentials: 'include',
                    redirect: 'error'
                });
                const data = res.ok ? await res.json() : null;
                if (data?.success) {
                    added++;
                } else {
                    failed++;
                }
            } catch (err) {
                console.debug('[KOSTEAM] Wishlist add error:', err);
                failed++;
            }
        }
        return { added, failed };
    }

    async function restoreItemsToCart(items, options = {}) {
        const { pending = null, recoveryTargetItems, silent = false } = options;
        const token = getWebApiToken();
        const countryCode = getAccountCountryCode();
        if (!token) return { success: false, error: 'missing_token' };
        if (!countryCode) return { success: false, error: 'missing_country_code' };

        try {
            const response = await sendMessage({
                type: pending ? MSG_RECOVER_CART : MSG_RESTORE_CART,
                token,
                items,
                transactionId: pending?.transactionId,
                recoveryRevision: pending?.recoveryRevision,
                ...(recoveryTargetItems ? { recoveryTargetItems } : {}),
                countryCode,
                sourceTag: RESTORE_SOURCE_TAG
            });
            if (!response?.success) {
                const detail = response?.detail ? ` (${response.detail})` : '';
                if (!silent && !DISABLE_CART_DIALOGS) {
                    window.alert(`복원 요청 실패: ${response?.error || 'unknown'}${detail}`);
                }
                return {
                    ...response,
                    success: false,
                    error: response?.error || 'unknown'
                };
            }
            return response;
        } catch (err) {
            if (!silent && !DISABLE_CART_DIALOGS) {
                window.alert(`복원 요청 실패: ${err.message}`);
            }
            return { success: false, error: err.message };
        }
    }

    // ========== UI Components ==========

    function ensureActionBar() {
        let bar = document.querySelector('.kosteam-cart-bar');
        if (bar) return bar;

        bar = document.createElement('div');
        bar.className = 'kosteam-cart-bar';

        // Select All checkbox
        const label = document.createElement('label');
        label.className = 'kosteam-cart-selectall';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'kosteam-cart-selectall-checkbox';
        const span = document.createElement('span');
        span.textContent = '전체 선택';
        label.appendChild(checkbox);
        label.appendChild(span);

        // Total display
        const total = document.createElement('div');
        total.className = 'kosteam-cart-total';
        total.textContent = '선택 합계: -';

        // Buttons
        const buySelectedButton = createButton('선택항목만 구매', 'kosteam-cart-buy-selected-btn');
        const wishlistAllButton = createButton('전부 찜 목록에 추가', 'kosteam-cart-wishlist-all-btn');
        const wishlistSelectedButton = createButton('선택항목을 찜 목록에 추가', 'kosteam-cart-wishlist-selected-btn');
        const jsonButton = createButton('JSON 저장', 'kosteam-cart-json-btn');
        const jsonImportButton = createButton('JSON 불러오기', 'kosteam-cart-json-import-btn');

        // Event handlers
        checkbox.addEventListener('change', () => {
            const currentItems = findCartItems();
            currentItems.forEach(item => {
                const box = item.querySelector('.kosteam-cart-checkbox');
                if (box) {
                    box.checked = checkbox.checked;
                    const key = getItemSelectionKey(item, currentItems);
                    if (key) {
                        if (box.checked) selectedKeys.add(key);
                        else selectedKeys.delete(key);
                    }
                }
            });
            updateSelectAllState();
        });

        buySelectedButton.addEventListener('click', handleBuySelected);
        wishlistAllButton.addEventListener('click', handleSendAllToWishlist);
        wishlistSelectedButton.addEventListener('click', handleSendSelectedToWishlist);
        jsonButton.addEventListener('click', handleJsonExport);
        jsonImportButton.addEventListener('click', handleJsonImport);

        bar.appendChild(label);
        bar.appendChild(total);
        bar.appendChild(buySelectedButton);
        bar.appendChild(wishlistAllButton);
        bar.appendChild(wishlistSelectedButton);
        bar.appendChild(jsonButton);
        bar.appendChild(jsonImportButton);
        document.body.appendChild(bar);
        return bar;
    }

    function createButton(text, className) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `kosteam-cart-btn ${className}`;
        btn.textContent = text;
        return btn;
    }

    // ========== Event Handlers ==========

    async function handleJsonExport(e) {
        e.preventDefault();
        e.stopPropagation();
        const items = findCartItems();
        if (items.length === 0) {
            if (!DISABLE_CART_DIALOGS) {
                window.alert('장바구니가 비어 있습니다.');
            }
            return;
        }
        const exportData = await buildExportData(items);
        const date = new Date().toISOString().slice(0, 10);
        downloadJson(exportData, `steam-cart-${date}`);
    }

    async function handleJsonImport(e) {
        e.preventDefault();
        e.stopPropagation();

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.style.display = 'none';

        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) return;
            if (file.size > MAX_IMPORT_FILE_BYTES) {
                if (!DISABLE_CART_DIALOGS) {
                    window.alert('JSON 파일이 너무 큽니다. 1MB 이하의 장바구니 백업만 불러올 수 있습니다.');
                }
                return;
            }

            let data;
            try {
                const text = await file.text();
                data = JSON.parse(text);
            } catch (err) {
                console.debug('[KOSTEAM] JSON import parse error:', err);
                if (!DISABLE_CART_DIALOGS) {
                    window.alert('JSON 파일을 읽을 수 없습니다.');
                }
                return;
            }

            const items = data?.items;
            if (!Array.isArray(items) || items.length === 0 || items.length > MAX_CART_RESTORE_ITEMS) {
                if (!DISABLE_CART_DIALOGS) {
                    window.alert(`유효한 장바구니 데이터가 없습니다. 최대 ${MAX_CART_RESTORE_ITEMS}개까지 복원할 수 있습니다.`);
                }
                return;
            }

            const restoreItems = items
                .map(item => {
                    if (item?.type === 'bundle') {
                        return { id: item.bundleId, type: 'bundle' };
                    }
                    if (item?.type === 'package') {
                        return { id: item.packageId, type: 'package' };
                    }
                    return null;
                });

            if (restoreItems.some(item => !isValidCartItem(item))) {
                if (!DISABLE_CART_DIALOGS) {
                    window.alert('장바구니 데이터에 유효하지 않은 packageId 또는 bundleId가 있습니다.');
                }
                return;
            }

            const currentDomCount = findCartItems().length;
            const currentCartItems = getCurrentCartInfoItems();
            if (!validateCartSync(currentDomCount) || currentCartItems.length !== currentDomCount) {
                if (!DISABLE_CART_DIALOGS) {
                    window.alert('현재 장바구니 DOM과 Steam 내부 데이터가 일치하지 않습니다. 새로고침 후 다시 불러와 주세요.');
                }
                return;
            }
            const missingItems = getMissingCartItems(restoreItems, currentCartItems);
            if (!missingItems || missingItems.length === 0) {
                if (!DISABLE_CART_DIALOGS) {
                    window.alert('백업의 모든 항목이 현재 장바구니에 이미 있습니다.');
                }
                return;
            }

            const shownNames = items.slice(0, 10).map(i => typeof i?.name === 'string' ? i.name.slice(0, 100) : '?');
            const names = `${shownNames.join(', ')}${items.length > shownNames.length ? ` 외 ${items.length - shownNames.length}개` : ''}`;
            if (!DISABLE_CART_DIALOGS) {
                if (!window.confirm(`${missingItems.length}개 누락 항목을 장바구니에 추가할까요?\n${names}`)) return;
            }

            const result = await restoreItemsToCart(missingItems, { silent: true });
            if (result?.success) {
                if (!DISABLE_CART_DIALOGS) {
                    window.alert('장바구니에 추가했습니다. 곧 자동 새로고침합니다.');
                }
                window.location.reload();
            } else if (result?.completedCount > 0) {
                if (!DISABLE_CART_DIALOGS) {
                    window.alert(`${result.completedCount}개 항목 추가는 확인됐지만 전체 복원은 완료되지 않았습니다. 장바구니를 새로고침합니다. 같은 JSON을 다시 불러오면 남은 항목만 계산합니다.`);
                }
                window.location.reload();
            } else if (!DISABLE_CART_DIALOGS) {
                window.alert(`복원 요청 실패: ${result?.error || 'unknown'}`);
            }
        });

        document.body.appendChild(input);
        input.click();
        document.body.removeChild(input);
    }

    function setSelectedCheckoutButtonsDisabled(disabled) {
        document.querySelectorAll('.kosteam-cart-buy-selected-btn, .kosteam-buy-selected-sidebar')
            .forEach(button => { button.disabled = disabled; });
    }

    async function handleBuySelected(e) {
        e.preventDefault();
        e.stopPropagation();

        if (checkoutInProgress) return;
        if (pendingRecoveryBlocked) {
            if (!DISABLE_CART_DIALOGS) {
                window.alert('이전 장바구니 복원이 완료되지 않았거나 다른 탭에서 진행 중입니다. 해당 탭에서 완료하거나, 장바구니 기능을 껐다 다시 켠 뒤 이 페이지를 새로고침해 주세요.');
            }
            return;
        }

        checkoutInProgress = true;
        setSelectedCheckoutButtonsDisabled(true);
        let checkoutStarted = false;
        try {
            checkoutStarted = await performBuySelected();
        } finally {
            if (!checkoutStarted) {
                checkoutInProgress = false;
                setSelectedCheckoutButtonsDisabled(false);
            }
        }
    }

    async function rollbackInterruptedSelection(
        removedItems,
        pending,
        ambiguous = false,
        recoveryTargetItems = null
    ) {
        if (ambiguous) return { success: false, preserved: true };
        if (removedItems.length === 0) {
            return clearPendingRestore(pending?.transactionId, pending?.recoveryRevision);
        }
        return restoreItemsToCart(removedItems, {
            pending,
            recoveryTargetItems,
            silent: true
        });
    }

    async function performBuySelected() {

        const items = findCartItems();
        if (!getCartLineItems().every(isSimpleRecoverableLineItem)) {
            if (!DISABLE_CART_DIALOGS) {
                window.alert('선물·비공개 구매·쿠폰이 적용된 특수 장바구니 항목은 안전하게 복원할 수 없어 선택 구매를 지원하지 않습니다.');
            }
            return false;
        }

        if (!validateCartSync(items.length)) {
            if (!DISABLE_CART_DIALOGS) {
                window.alert('장바구니 항목 수가 일치하지 않습니다. 새로고침 후 다시 시도해 주세요.');
            }
            return;
        }

        const cartInfoMap = await mapDomItemsToCartInfo(items);
        if (cartInfoMap.size !== items.length) {
            if (!DISABLE_CART_DIALOGS) {
                window.alert('장바구니 항목을 Steam 내부 데이터와 정확히 대응할 수 없습니다. 새로고침 후 다시 시도해 주세요.');
            }
            return;
        }
        const checkedItems = [];
        const uncheckedItems = [];

        items.forEach((item, index) => {
            const box = item.querySelector('.kosteam-cart-checkbox');
            const cartInfo = cartInfoMap.get(item);
            const name = extractItemName(item) || `Item ${index + 1}`;
            const key = getItemKey(item);
            const selectionKey = getItemSelectionKey(item, items);

            if (box?.checked) {
                checkedItems.push({ element: item, cartInfo, name, key, selectionKey });
            } else {
                uncheckedItems.push({ element: item, cartInfo, name, key, selectionKey });
            }
        });

        if (checkedItems.length === 0) {
            if (!DISABLE_CART_DIALOGS) {
                window.alert('선택된 항목이 없습니다.');
            }
            return;
        }

        try {
            await downloadSelectedCheckoutBackup(items, checkedItems, uncheckedItems);
        } catch (err) {
            console.debug('[KOSTEAM] Selected checkout backup error:', err);
            if (!DISABLE_CART_DIALOGS) {
                window.alert('장바구니 백업 JSON을 생성할 수 없습니다. 다시 시도해 주세요.');
            }
            return;
        }

        const checkedKeys = checkedItems.map(item => item.key).filter(Boolean);
        const uncheckedKeys = uncheckedItems.map(item => item.key).filter(Boolean);
        if (checkedKeys.length !== checkedItems.length || uncheckedKeys.length !== uncheckedItems.length) {
            if (!DISABLE_CART_DIALOGS) {
                window.alert('장바구니 항목 식별 정보를 찾을 수 없습니다. 새로고침 후 다시 시도해 주세요.');
            }
            return;
        }

        if (uncheckedItems.length === 0) {
            const checkoutStarted = await continueToCheckout();
            if (!checkoutStarted && !DISABLE_CART_DIALOGS) {
                window.alert('Steam 결제 버튼이 아직 활성화되지 않았습니다. 장바구니 상태를 확인한 뒤 다시 시도해 주세요.');
            }
            return checkoutStarted;
        }

        const itemsToRemove = uncheckedItems
            .map(item => item.cartInfo)
            .filter(isValidCartItem);

        if (itemsToRemove.length !== uncheckedItems.length) {
            if (!DISABLE_CART_DIALOGS) {
                window.alert('제거할 항목의 정확한 Steam 식별자를 찾을 수 없습니다.');
            }
            return;
        }
        if (uncheckedItems.some(item => !hasReAddableActionPair(item.element))) {
            if (!DISABLE_CART_DIALOGS) {
                window.alert('Steam이 다시 추가할 수 있다고 표시한 일반 항목만 선택 구매에서 제외할 수 있습니다. 제한된 항목이 있어 구매를 중단했습니다.');
            }
            return false;
        }

        const snapshot = {
            removedItems: itemsToRemove,
            remainingItems: checkedItems.map(item => item.cartInfo)
        };
        const fullRecoveryTarget = [...snapshot.remainingItems, ...snapshot.removedItems];
        const pendingResult = await savePendingRestore(snapshot);
        if (!pendingResult?.success) {
            if (!DISABLE_CART_DIALOGS) {
                window.alert(`장바구니 복원 정보를 안전하게 보관할 수 없어 구매를 중단했습니다. (${pendingResult?.error || 'unknown'})`);
            }
            return;
        }

        const removalResult = await removeCartItemsSequentially(uncheckedItems, checkedKeys);
        if (!removalResult.success) {
            const rollback = await rollbackInterruptedSelection(
                removalResult.removedItems,
                pendingResult,
                removalResult.ambiguous,
                fullRecoveryTarget
            );
            if (!DISABLE_CART_DIALOGS) {
                window.alert(rollback?.success
                    ? '미선택 항목 제거가 완료되지 않아 제거된 항목을 즉시 복원했습니다.'
                    : '미선택 항목 제거와 즉시 복원이 모두 완료되지 않았습니다. 복원 상태와 백업 JSON을 유지했으니 페이지를 새로고침해 주세요.');
            }
            return false;
        }

        const checkoutStarted = await continueToCheckout(
            pendingResult.transactionId,
            pendingResult.recoveryRevision
        );
        if (!checkoutStarted) {
            const rollback = await rollbackInterruptedSelection(
                removalResult.removedItems,
                pendingResult,
                false,
                fullRecoveryTarget
            );
            if (!DISABLE_CART_DIALOGS) {
                window.alert(rollback?.success
                    ? 'Steam 결제를 안전하게 시작할 수 없어 제거된 항목을 즉시 복원했습니다.'
                    : 'Steam 결제를 시작하지 못했고 즉시 복원도 완료되지 않았습니다. 복원 상태와 백업 JSON을 유지했습니다.');
            }
        }
        return checkoutStarted;
    }

    async function handleSendAllToWishlist(e) {
        e.preventDefault();
        e.stopPropagation();

        const items = findCartItems();
        if (items.length === 0) {
            if (!DISABLE_CART_DIALOGS) {
                window.alert('장바구니가 비어 있습니다.');
            }
            return;
        }

        const appIds = items.flatMap(item => extractAppIds(item)).filter(id => Number.isInteger(id));
        const uniqueAppIds = Array.from(new Set(appIds));

        if (uniqueAppIds.length === 0) {
            if (!DISABLE_CART_DIALOGS) {
                window.alert('찜목록으로 보낼 수 있는 앱이 없습니다.');
            }
            return;
        }

        const { added, failed } = await sendAppIdsToWishlist(uniqueAppIds);
        if (!DISABLE_CART_DIALOGS) {
            window.alert(`찜목록 추가 완료: ${added}개\n실패: ${failed}개\n\n(번들은 낱개 상품으로 찜 목록에 추가됩니다.)`);
        }
    }

    async function handleSendSelectedToWishlist(e) {
        e.preventDefault();
        e.stopPropagation();

        const items = findCartItems();
        if (items.length === 0) {
            if (!DISABLE_CART_DIALOGS) {
                window.alert('장바구니가 비어 있습니다.');
            }
            return;
        }

        const selectedItems = items.filter(item => item.querySelector('.kosteam-cart-checkbox')?.checked);
        if (selectedItems.length === 0) {
            if (!DISABLE_CART_DIALOGS) {
                window.alert('선택된 항목이 없습니다.');
            }
            return;
        }

        const appIds = selectedItems.flatMap(item => extractAppIds(item)).filter(id => Number.isInteger(id));
        const uniqueAppIds = Array.from(new Set(appIds));

        if (uniqueAppIds.length === 0) {
            if (!DISABLE_CART_DIALOGS) {
                window.alert('찜목록으로 보낼 수 있는 앱이 없습니다.');
            }
            return;
        }

        const { added, failed } = await sendAppIdsToWishlist(uniqueAppIds);
        if (!DISABLE_CART_DIALOGS) {
            window.alert(`찜목록 추가 완료: ${added}개\n실패: ${failed}개`);
        }
    }

    // ========== UI State Management ==========

    function updateSelectAllState() {
        const bar = ensureActionBar();
        const checkbox = bar.querySelector('.kosteam-cart-selectall-checkbox');
        const items = findCartItems();

        if (items.length === 0) {
            checkbox.checked = false;
            checkbox.indeterminate = false;
            return;
        }

        const selectedCount = items.filter(item => item.querySelector('.kosteam-cart-checkbox')?.checked).length;
        checkbox.checked = selectedCount === items.length;
        checkbox.indeterminate = selectedCount > 0 && selectedCount < items.length;
        updateSelectedTotal();
    }

    function updateSelectedTotal() {
        const bar = document.querySelector('.kosteam-cart-bar');
        const totalEl = bar?.querySelector('.kosteam-cart-total');
        if (!totalEl) return;

        const items = findCartItems();
        let sum = 0;
        let currency = '';

        for (const item of items) {
            if (!item.querySelector('.kosteam-cart-checkbox')?.checked) continue;
            const priceInfo = getItemPrice(item);
            if (priceInfo) {
                sum += priceInfo.value;
                currency = priceInfo.currency || currency;
            }
        }

        const nextText = currency ? `선택 합계: ${formatCurrency(sum, currency)}` : '선택 합계: -';
        if (totalEl.textContent !== nextText) totalEl.textContent = nextText;
    }

    function isNativeCheckoutButtonReady(button) {
        return !!button &&
            !button.disabled &&
            button.getAttribute('aria-disabled') !== 'true' &&
            !button.classList.contains('Disabled');
    }

    function findNativeCheckoutButton(options = {}) {
        const { requireReady = false } = options;
        const cartItems = findCartItems();
        const firstItem = cartItems[0];
        let root = firstItem?.parentElement || null;
        const isVisible = element => {
            if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
            const style = window.getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        };
        const useIfReady = element => {
            if (!element || (requireReady && !isNativeCheckoutButtonReady(element))) return null;
            return element;
        };

        while (root && root !== document.body) {
            const containsEveryCartItem = cartItems.every(item => root.contains(item));
            if (!containsEveryCartItem) {
                root = root.parentElement;
                continue;
            }
            const trustedLinks = Array.from(root.querySelectorAll('a[href]')).filter(link => {
                const insideCartItem = cartItems.some(item => item.contains(link));
                return !insideCartItem &&
                    !link.closest('[role="dialog"], dialog') &&
                    isValidCheckoutUrl(link.href) &&
                    isVisible(link);
            });
            if (trustedLinks.length > 1) return null;
            if (trustedLinks.length === 1) return useIfReady(trustedLinks[0]);

            const nativeButtons = Array.from(root.querySelectorAll('button.DialogButton.Primary')).filter(button => {
                return !button.closest('[role="dialog"], dialog') && isVisible(button);
            });
            if (nativeButtons.length > 1) return null;
            if (nativeButtons.length === 1) return useIfReady(nativeButtons[0]);

            root = root.parentElement;
        }
        return null;
    }

    function guardNativeCheckoutDuringSelection(event) {
        if (!checkoutInProgress || allowNativeCheckoutClick || !(event.target instanceof Element)) return;
        const control = event.target.closest('a[href], button');
        if (!control || control.closest('[role="dialog"], dialog')) return;

        const isCheckoutLink = control.tagName === 'A' && isValidCheckoutUrl(control.href);
        const isNativePrimaryButton = control.matches('button.DialogButton.Primary');
        if (!isCheckoutLink && !isNativePrimaryButton) return;

        event.preventDefault();
        event.stopImmediatePropagation();
    }

    async function continueToCheckout(transactionId = null, recoveryRevision = null) {
        const checkoutBtn = await waitForNativeCheckoutButtonReady();
        if (!checkoutBtn) return false;

        if (transactionId) {
            try {
                const marked = await sendMessage({
                    type: MSG_MARK_CART_CHECKOUT_STARTED,
                    transactionId,
                    recoveryRevision
                });
                if (!marked?.success) return false;
            } catch (err) {
                console.debug('[KOSTEAM] Failed to mark checkout start:', err);
                return false;
            }
        }

        const currentCheckoutBtn = findNativeCheckoutButton({ requireReady: true });
        if (!currentCheckoutBtn?.isConnected) return false;
        allowNativeCheckoutClick = true;
        try {
            currentCheckoutBtn.click();
        } finally {
            allowNativeCheckoutClick = false;
        }
        return true;
    }

    function ensureBuySelectedButton() {
        const existing = document.querySelector('.kosteam-buy-selected-sidebar');
        if (existing && !existing.classList.contains('kosteam-cart-btn')) return;
        if (existing) existing.remove();

        // Use the unique visible checkout control within the cart interaction root.
        const checkoutBtn = findNativeCheckoutButton();

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'kosteam-buy-selected-sidebar';
        btn.textContent = '선택항목만 구매';
        btn.addEventListener('click', handleBuySelected);

        if (checkoutBtn) {
            btn.style.cssText = 'display: block; width: 100%; height: 32px; line-height: 32px; margin-top: 8px; background: #3895EA; color: #fff; border: none; border-radius: 2px; cursor: pointer; font-size: 14px; text-align: center;';
            btn.addEventListener('mouseover', () => { btn.style.background = '#5aabf0'; });
            btn.addEventListener('mouseout', () => { btn.style.background = '#3895EA'; });
            checkoutBtn.insertAdjacentElement('afterend', btn);
        }
    }

    function decorateItems() {
        const items = findCartItems();
        ensureActionBar();
        ensureBuySelectedButton();

        if (items.length === 0) {
            updateSelectAllState();
            return;
        }

        for (const item of items) {
            if (item.querySelector('.kosteam-cart-controls')) continue;

            item.classList.add('kosteam-cart-item');

            const controls = document.createElement('div');
            controls.className = 'kosteam-cart-controls';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'kosteam-cart-checkbox';

            const label = document.createElement('span');
            label.textContent = '선택';
            label.className = 'kosteam-cart-checkbox-label';

            const key = getItemSelectionKey(item, items);
            if (key && selectedKeys.has(key)) checkbox.checked = true;

            getItemPrice(item); // Cache price

            checkbox.addEventListener('change', () => {
                if (key) {
                    if (checkbox.checked) selectedKeys.add(key);
                    else selectedKeys.delete(key);
                }
                updateSelectAllState();
            });

            controls.appendChild(checkbox);
            controls.appendChild(label);
            item.insertBefore(controls, item.firstChild);
        }

        updateSelectAllState();
    }

    // ========== Auto Restore ==========

    function getCurrentCartInfoItems() {
        return getCartLineItems().map(lineItem => {
            const bundleId = Number(lineItem?.bundleid || 0);
            const packageId = Number(lineItem?.packageid || 0);
            const item = bundleId > 0
                ? { id: bundleId, type: 'bundle' }
                : { id: packageId, type: 'package' };
            return isValidCartItem(item) ? item : null;
        }).filter(Boolean);
    }

    async function tryAutoRestore() {
        let restoreState = {};
        try {
            restoreState = await storageGet([
                PENDING_CART_RESTORE_KEY,
                CART_PURCHASE_COMPLETE_KEY
            ]);
        } catch (err) {
            console.debug('[KOSTEAM] Pending restore state read error:', err);
        }

        const pending = restoreState[PENDING_CART_RESTORE_KEY];
        const purchaseMarker = restoreState[CART_PURCHASE_COMPLETE_KEY];
        const purchaseCompleted = purchaseMarker?.transactionId
            ? purchaseMarker.transactionId === pending?.transactionId
            : (!pending?.transactionId && typeof purchaseMarker === 'string');
        const currentItems = getCurrentCartInfoItems();
        const restoreItems = getCartRecoveryPlan(pending, currentItems, purchaseCompleted);
        if (!restoreItems) {
            pendingRecoveryBlocked = !!pending;
            return false;
        }

        if (restoreItems.length === 0) {
            const cleared = await clearPendingRestore(
                pending.transactionId,
                pending.recoveryRevision
            );
            if (!cleared?.success) pendingRecoveryBlocked = true;
            return false;
        }

        console.log('[KOSTEAM] Auto-restoring', restoreItems.length, 'items');

        const result = await restoreItemsToCart(restoreItems, {
            pending,
            recoveryTargetItems: [...currentItems, ...restoreItems],
            silent: true
        });

        if (result?.success) {
            // 복원 성공 → 조용히 새로고침 (API 결과를 DOM에 반영하려면 필요)
            window.location.reload();
            return true;
        } else {
            pendingRecoveryBlocked = true;
            console.error('[KOSTEAM] Auto-restore failed:', result?.error);
            return false;
        }
    }

    // ========== Initialization ==========

    function scheduleRefresh() {
        if (refreshScheduled) return;

        refreshScheduled = true;
        requestAnimationFrame(() => {
            refreshScheduled = false;
            decorateItems();
        });
    }

    const observer = new MutationObserver(() => scheduleRefresh());

    async function init() {
        if (await tryAutoRestore()) return;
        scheduleRefresh();
        observer.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
