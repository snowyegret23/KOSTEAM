/**
 * KOSTEAM Cart Enhancer
 * Adds per-item selection and checkout controls in Steam cart
 */

import { sendMessage, storageGet, storageSet } from './shared/api.js';
import { waitForKeySet, waitForObservedCondition } from './shared/cart_state.js';
import {
    CART_PURCHASE_COMPLETE_KEY,
    CART_RESTORE_COMPLETE_KEY,
    MSG_RESTORE_CART,
    PENDING_CART_RESTORE_KEY
} from './shared/constants.js';

(async function () {
    const CART_PATH_PREFIX = '/cart';
    const REMOVE_TEXTS = ['remove', '삭제', '제거', '삭제하기'];
    const SNAPSHOT_STORAGE_KEY = 'kosteam_cart_snapshot';
    const CART_URL = 'https://store.steampowered.com/cart/';
    const RESTORE_SOURCE_TAG = 'main-cluster-topseller';
    const DISABLE_CART_DIALOGS = false;
    const CART_FEATURE_KEY = 'cart_feature_enabled';
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
        '.cart_item_wrapper',
        '._3F0SnUeC_obtI4WyQtijAa'
    ];
    const REFRESH_DEBOUNCE_MS = 250;
    const CART_REMOVE_TIMEOUT_MS = 15000;
    const CART_KEY_STABLE_MS = 100;
    const CHECKOUT_READY_STABLE_MS = 100;

    if (!window.location.pathname.startsWith(CART_PATH_PREFIX)) return;

    try {
        const settings = await storageGet([CART_FEATURE_KEY]);
        if (settings[CART_FEATURE_KEY] === false) return;
    } catch {
        // Fail open if storage is unavailable.
    }

    const selectedKeys = new Set();
    let refreshScheduled = false;
    let lastRefreshAt = 0;

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

    function getCartLineItems() {
        const cfg = getStoreUserConfigJson();
        const items = cfg?.accountcart?.cart?.line_items;
        return Array.isArray(items) ? items : [];
    }

    function getCartItemsWithType() {
        const lineItems = getCartLineItems();
        return lineItems
            .map(item => {
                const bundleId = Number(item.bundleid || 0);
                const packageId = Number(item.packageid || 0);
                if (bundleId > 0) return { id: bundleId, type: 'bundle' };
                if (packageId > 0) return { id: packageId, type: 'package' };
                return null;
            })
            .filter(item => item !== null);
    }

    // ========== DOM Utility Functions ==========

    function getItemKey(item) {
        const link = findItemLink(item);
        if (!link) return null;
        const href = link.getAttribute('href') || '';
        const match = href.match(/\/(app|sub|bundle)\/(\d+)/);
        return match ? `${match[1]}:${match[2]}` : null;
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
        if (direct) return Number(direct);
        if (item.dataset?.lineItemId) return Number(item.dataset.lineItemId);
        const nested = item.querySelector('[data-line-item-id], [data-line_item_id]');
        if (!nested) return null;
        const nestedValue = nested.getAttribute('data-line-item-id') || nested.getAttribute('data-line_item_id');
        return nestedValue ? Number(nestedValue) : null;
    }

    function getCartRoot() {
        return document.querySelector('._17GFdSD2pc0BquZk5cejg8') || document.body;
    }

    function hasPriceText(text) {
        return text?.includes('₩') || text?.includes('$') || text?.includes('€') || text?.includes('£');
    }

    function findItemLink(item) {
        if (!item?.querySelector) return null;
        for (const selector of ['a[href*="/bundle/"]', 'a[href*="/sub/"]', 'a[href*="/app/"]']) {
            const link = item.querySelector(selector);
            if (link) return link;
        }
        return null;
    }

    // ========== Cart Item Detection ==========

    function isRecommendationItem(item) {
        const recContainer = item.closest('._2rkDlHZ2yi-tFtDk4-CC4U, [class*="Discovery"], [class*="Recommend"], [class*="recommend"]');
        if (recContainer) return true;

        let parent = item.parentElement;
        let depth = 0;
        while (parent && depth < 5) {
            const text = (parent.textContent || '').substring(0, 200).toLowerCase();
            if ((text.includes('맞춤') && text.includes('추천')) || text.includes('discovery queue')) {
                if (!text.includes('장바구니') && !text.includes('your cart')) {
                    return true;
                }
            }
            parent = parent.parentElement;
            depth++;
        }
        return false;
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
        const text = (node.textContent || '').toLowerCase();
        return text.includes('remove') || text.includes('삭제') || text.includes('제거') || hasPriceText(text);
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

    function collectByRemoveButtons(root) {
        const removeButtons = findRemoveButtons(root);
        const items = [];
        for (const button of removeButtons) {
            const byClass = button.closest('._3F0SnUeC_obtI4WyQtijAa');
            if (byClass) {
                items.push(byClass);
                continue;
            }
            let node = button;
            while (node && node !== document.body) {
                if (node.querySelector?.('a[href*="/app/"], a[href*="/sub/"], a[href*="/bundle/"]') && looksLikeCartItem(node)) {
                    items.push(node);
                    break;
                }
                node = node.parentElement;
            }
        }
        return items;
    }

    function collectByAppLinks(root) {
        const links = root.querySelectorAll('a[href*="/app/"], a[href*="/sub/"], a[href*="/bundle/"]');
        const items = [];
        links.forEach(link => {
            const byClass = link.closest('._3F0SnUeC_obtI4WyQtijAa');
            if (byClass) {
                items.push(byClass);
                return;
            }
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
            ...collectByRemoveButtons(cartRoot),
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

    function textMatchesRemove(text) {
        if (!text) return false;
        const lower = text.trim().toLowerCase();
        return REMOVE_TEXTS.some(term => lower === term || lower.includes(term));
    }

    function scoreRemoveCandidate(el) {
        const text = (el.textContent || '').trim().toLowerCase();
        if (!text) return 0;
        let score = 0;
        if (REMOVE_TEXTS.some(term => text === term)) score += 100;
        if (text.startsWith('제거') || text.startsWith('remove')) score += 80;
        if (text.includes('제거') || text.includes('remove')) score += 50;
        if (text.includes('추가') || text.includes('개인') || text.includes('wishlist')) score -= 40;
        if (text.includes('|')) score -= 20;
        if (el.tagName === 'DIV' && /panel/i.test(el.className || '')) score += 5;
        return score;
    }

    function findRemoveButtons(root) {
        const candidates = root.querySelectorAll('a, button, [role="button"], .Panel, [data-panel]');
        const matches = [];
        for (const el of candidates) {
            const text = (el.textContent || '').trim();
            const onclick = (el.getAttribute('onclick') || '').toLowerCase();
            const href = (el.getAttribute('href') || '').toLowerCase();
            if (textMatchesRemove(text) || onclick.includes('remove') || onclick.includes('delete') || href.includes('remove')) {
                matches.push(el);
            }
        }
        return matches;
    }

    function findRemoveButton(item) {
        const matches = findRemoveButtons(item);
        if (matches.length === 0) return null;
        const scored = matches
            .map(el => ({ el, score: scoreRemoveCandidate(el) }))
            .filter(entry => entry.score > 0)
            .sort((a, b) => b.score - a.score);
        return scored.length > 0 ? scored[0].el : matches[0];
    }

    // ========== Smart Cart Mapping ==========
    //
    // DOM 순서와 API line_items 순서가 다를 수 있음
    //
    // 전략:
    // 1. Bundle: DOM의 /bundle/ID URL로 API의 bundleid와 직접 매칭 (확실)
    // 2. Package: 남은 DOM 항목과 남은 API packageid를 순서대로 매칭
    //
    // 이 방식이 작동하는 이유:
    // - Bundle은 URL에 bundleId가 있어서 100% 확실하게 매칭 가능
    // - Package만 있는 경우, DOM 순서와 API 순서가 일치함 (bundle이 섞여있을 때만 불일치)

    /**
     * DOM 항목들을 API line_items와 매핑
     * @param {HTMLElement[]} domItems - DOM 항목 배열
     * @returns {Map<HTMLElement, {id: number, type: 'package'|'bundle'}>}
     */
    async function mapDomItemsToCartInfo(domItems) {
        const map = new Map();
        const lineItems = getCartLineItems();

        if (domItems.length !== lineItems.length) {
            return map;
        }

        // 매칭 전략:
        // 1) Bundle: /bundle/ID 로 정확 매칭
        // 2) AppID: appdetails 패키지 목록과 line_items 교집합으로 매칭
        // 3) Fallback: 남은 항목은 순서대로 매칭

        const usedLineItemIndices = new Set();
        const lineItemInfos = lineItems.map((lineItem, index) => {
            const bundleId = Number(lineItem?.bundleid || 0);
            const packageId = Number(lineItem?.packageid || 0);
            return {
                index,
                id: bundleId > 0 ? bundleId : packageId,
                type: bundleId > 0 ? 'bundle' : 'package',
                packageId,
                bundleId
            };
        });

        // Pass 1: Bundle URL이 있는 DOM 항목을 먼저 매칭
        for (let domIdx = 0; domIdx < domItems.length; domIdx++) {
            const item = domItems[domIdx];
            const itemLink = extractItemLink(item);
            const bundleMatch = itemLink?.match(/\/bundle\/(\d+)/);

            if (bundleMatch) {
                const bundleId = Number(bundleMatch[1]);
                // API에서 해당 bundleId를 가진 line_item 찾기
                for (let i = 0; i < lineItemInfos.length; i++) {
                    if (usedLineItemIndices.has(i)) continue;
                    const apiBundleId = lineItemInfos[i]?.type === 'bundle' ? lineItemInfos[i].id : 0;
                    if (apiBundleId === bundleId) {
                        map.set(item, { id: bundleId, type: 'bundle' });
                        usedLineItemIndices.add(i);
                        break;
                    }
                }
            }
        }


        // Pass 2: AppID -> packageId 매칭 (appdetails 패키지 교집합)
        const remainingPackageIds = new Set(
            lineItemInfos
                .filter(info => info.type === 'package' && !usedLineItemIndices.has(info.index))
                .map(info => info.packageId)
                .filter(id => id > 0)
        );

        for (let domIdx = 0; domIdx < domItems.length; domIdx++) {
            const item = domItems[domIdx];
            if (map.has(item)) continue;
            const link = findItemLink(item);
            if (!link) continue;

            const href = link.getAttribute('href') || '';
            const subMatch = href.match(/\/sub\/(\d+)/);
            if (subMatch) {
                const subId = Number(subMatch[1]);
                if (remainingPackageIds.has(subId)) {
                    map.set(item, { id: subId, type: 'package' });
                    remainingPackageIds.delete(subId);
                    const matchedIndex = lineItemInfos.findIndex(info => info.packageId === subId);
                    if (matchedIndex >= 0) usedLineItemIndices.add(matchedIndex);
                }
                continue;
            }

            const appMatch = href.match(/\/app\/(\d+)/);
            if (!appMatch) continue;
            const appId = Number(appMatch[1]);
            const resolvedPackageId = await resolvePackageIdFromAppId(appId, remainingPackageIds);
            if (resolvedPackageId) {
                map.set(item, { id: resolvedPackageId, type: 'package' });
                remainingPackageIds.delete(resolvedPackageId);
                const matchedIndex = lineItemInfos.findIndex(info => info.packageId === resolvedPackageId);
                if (matchedIndex >= 0) usedLineItemIndices.add(matchedIndex);
            }
        }

        // Pass 3: 나머지 DOM 항목을 남은 line_items와 순서대로 매칭
        let nextAvailableIndex = 0;
        for (let domIdx = 0; domIdx < domItems.length; domIdx++) {
            const item = domItems[domIdx];
            if (map.has(item)) {
                continue;
            }

            // 사용되지 않은 다음 line_item 찾기
            while (nextAvailableIndex < lineItemInfos.length && usedLineItemIndices.has(nextAvailableIndex)) {
                nextAvailableIndex++;
            }

            if (nextAvailableIndex < lineItemInfos.length) {
                const info = lineItemInfos[nextAvailableIndex];
                const cartInfo = { id: info.id, type: info.type };

                map.set(item, cartInfo);
                usedLineItemIndices.add(nextAvailableIndex);
                nextAvailableIndex++;
            }
        }

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

    function waitForCartKeys(expectedKeys, stableMs = CART_KEY_STABLE_MS) {
        return waitForKeySet({
            expectedKeys,
            getCurrentKeys: getCartItemKeys,
            observe: observeCartChanges,
            timeoutMs: CART_REMOVE_TIMEOUT_MS,
            stableMs
        });
    }

    async function waitForNativeCheckoutButtonReady() {
        const ready = await waitForObservedCondition({
            condition: () => !!findNativeCheckoutButton({ requireReady: true }),
            observe: observeCartChanges,
            timeoutMs: CART_REMOVE_TIMEOUT_MS,
            stableMs: CHECKOUT_READY_STABLE_MS
        });

        return ready ? findNativeCheckoutButton({ requireReady: true }) : null;
    }

    async function removeCartItemsSequentially(itemsToRemove, expectedRemainingKeys) {
        const expectedKeys = getCartItemKeys();

        for (let i = itemsToRemove.length - 1; i >= 0; i--) {
            const target = itemsToRemove[i];
            if (!target.key) return false;

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

            const expectedIndex = expectedKeys.indexOf(target.key);
            if (expectedIndex >= 0) expectedKeys.splice(expectedIndex, 1);
            if (!item) continue;

            const removeButton = findRemoveButton(item);
            if (!removeButton) return false;

            removeButton.click();
            const removed = await waitForCartKeys(expectedKeys, 0);
            if (!removed) return false;
        }

        return waitForCartKeys(expectedRemainingKeys);
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
            const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=KR&l=ko`;
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

    async function resolvePackageIdFromAppId(appId, remainingPackageIds) {
        const packages = await fetchAppPackageIds(appId);
        if (packages.length === 0) return null;
        const matches = packages.filter(id => remainingPackageIds.has(id));
        if (matches.length === 1) return matches[0];
        if (matches.length > 1) {
            return matches[0];
        }
        return null;
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
        const link = findItemLink(item);
        if (!link) return null;

        const href = link.getAttribute('href') || '';
        const match = href.match(/\/(app|sub|bundle)\/(\d+)/);
        if (!match) return null;

        return `https://store.steampowered.com/${match[1]}/${match[2]}`;
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

    // ========== Snapshot/Restore Functions ==========

    function saveSnapshot(snapshot) {
        localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot));
    }

    async function savePendingRestore(snapshot) {
        try {
            const token = getWebApiToken();
            await storageSet({
                [PENDING_CART_RESTORE_KEY]: {
                    autoRestore: snapshot.autoRestore === true,
                    removedItems: snapshot.removedItems || [],
                    removedItemCount: snapshot.removedItems?.length || 0,
                    token,
                    sourceTag: RESTORE_SOURCE_TAG,
                    savedAt: new Date().toISOString(),
                    cartUrl: CART_URL
                },
                [CART_RESTORE_COMPLETE_KEY]: null,
                [CART_PURCHASE_COMPLETE_KEY]: null
            });
        } catch (err) {
            console.debug('[KOSTEAM] Pending restore save error:', err);
        }
    }

    async function clearPendingRestore(markComplete = false) {
        try {
            await storageSet({
                [PENDING_CART_RESTORE_KEY]: null,
                [CART_RESTORE_COMPLETE_KEY]: markComplete ? new Date().toISOString() : null,
                [CART_PURCHASE_COMPLETE_KEY]: null
            });
        } catch (err) {
            console.debug('[KOSTEAM] Pending restore clear error:', err);
        }
    }

    function getSnapshot() {
        try {
            const raw = localStorage.getItem(SNAPSHOT_STORAGE_KEY);
            if (!raw) return null;

            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return null;

            // 새 형식: removedItems 배열만 사용
            const removedItems = Array.isArray(parsed.removedItems) ? parsed.removedItems : [];
            const savedWithSelection = parsed.savedWithSelection === true;
            const autoRestore = parsed.autoRestore === true;

            return { removedItems, savedWithSelection, autoRestore };
        } catch (err) {
            console.debug('[KOSTEAM] Snapshot parse error:', err);
            return null;
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
                    credentials: 'include'
                });
                if (res.ok) {
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

    async function restoreItemsToCart(items) {
        const token = getWebApiToken();
        if (!token) return { success: false, error: 'missing_token' };

        try {
            const response = await sendMessage({
                type: MSG_RESTORE_CART,
                token,
                items,
                sourceTag: RESTORE_SOURCE_TAG
            });
            if (!response?.success) {
                const detail = response?.detail ? ` (${response.detail})` : '';
                if (!DISABLE_CART_DIALOGS) {
                    window.alert(`복원 요청 실패: ${response?.error || 'unknown'}${detail}`);
                }
                return { success: false, error: response?.error || 'unknown' };
            }
            return response;
        } catch (err) {
            if (!DISABLE_CART_DIALOGS) {
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
            findCartItems().forEach(item => {
                const box = item.querySelector('.kosteam-cart-checkbox');
                if (box) {
                    box.checked = checkbox.checked;
                    const key = getItemKey(item);
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
            if (!Array.isArray(items) || items.length === 0) {
                if (!DISABLE_CART_DIALOGS) {
                    window.alert('유효한 장바구니 데이터가 없습니다.');
                }
                return;
            }

            const restoreItems = items
                .map(item => {
                    if (item.type === 'bundle' && item.bundleId) {
                        return { id: Number(item.bundleId), type: 'bundle' };
                    }
                    if (item.packageId) {
                        return { id: Number(item.packageId), type: 'package' };
                    }
                    return null;
                })
                .filter(item => item && item.id > 0);

            if (restoreItems.length === 0) {
                if (!DISABLE_CART_DIALOGS) {
                    window.alert('장바구니에 추가할 수 있는 항목이 없습니다. (packageId 또는 bundleId 필요)');
                }
                return;
            }

            const names = items.map(i => i.name || '?').join(', ');
            if (!DISABLE_CART_DIALOGS) {
                if (!window.confirm(`${restoreItems.length}개 항목을 장바구니에 추가할까요?\n${names}`)) return;
            }

            const result = await restoreItemsToCart(restoreItems);
            if (result?.success) {
                if (!DISABLE_CART_DIALOGS) {
                    window.alert('장바구니에 추가했습니다. 곧 자동 새로고침합니다.');
                }
                window.location.reload();
            }
        });

        document.body.appendChild(input);
        input.click();
        document.body.removeChild(input);
    }

    async function handleBuySelected(e) {
        e.preventDefault();
        e.stopPropagation();

        const items = findCartItems();

        if (!validateCartSync(items.length)) {
            if (!DISABLE_CART_DIALOGS) {
                window.alert('장바구니 항목 수가 일치하지 않습니다. 새로고침 후 다시 시도해 주세요.');
            }
            return;
        }

        const cartInfoMap = await mapDomItemsToCartInfo(items);
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
            return;
        }

        const itemsToRemove = uncheckedItems
            .map(item => item.cartInfo)
            .filter(info => info?.id > 0);

        if (itemsToRemove.length === 0) {
            if (!DISABLE_CART_DIALOGS) {
                window.alert('제거할 항목을 찾을 수 없습니다.');
            }
            return;
        }

        const snapshot = {
            removedItems: itemsToRemove,
            savedWithSelection: true,
            autoRestore: true
        };
        saveSnapshot(snapshot);
        await savePendingRestore(snapshot);

        const removed = await removeCartItemsSequentially(uncheckedItems, checkedKeys);
        if (!removed) {
            if (!DISABLE_CART_DIALOGS) {
                window.alert('미선택 항목 제거가 완료되지 않았습니다. 장바구니를 새로고침한 뒤 다시 시도해 주세요.');
            }
            return;
        }

        const checkoutStarted = await continueToCheckout();
        if (!checkoutStarted && !DISABLE_CART_DIALOGS) {
            window.alert('Steam 결제 버튼이 아직 활성화되지 않았습니다. 장바구니 상태를 확인한 뒤 다시 시도해 주세요.');
        }
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

        totalEl.textContent = currency ? `선택 합계: ${formatCurrency(sum, currency)}` : '선택 합계: -';
    }

    function isNativeCheckoutButtonReady(button) {
        return !!button &&
            !button.disabled &&
            button.getAttribute('aria-disabled') !== 'true' &&
            !button.classList.contains('Disabled');
    }

    function findNativeCheckoutButton(options = {}) {
        const { requireReady = false } = options;
        const checkoutCandidates = Array.from(document.querySelectorAll('a, button, div[role="button"]')).filter(el => {
            const href = el.getAttribute('href') || '';
            const text = (el.textContent?.trim() || '').toLowerCase();
            const isCheckout = href.includes('/checkout') ||
                text === '결제 계속하기' ||
                text === 'continue to payment';
            return isCheckout &&
                el.offsetParent !== null &&
                (!requireReady || isNativeCheckoutButtonReady(el));
        });
        return checkoutCandidates.sort((a, b) => {
            return b.getBoundingClientRect().x - a.getBoundingClientRect().x;
        })[0] || null;
    }

    async function continueToCheckout() {
        const checkoutBtn = await waitForNativeCheckoutButtonReady();
        if (checkoutBtn) {
            checkoutBtn.click();
            return true;
        }
        return false;
    }

    function ensureBuySelectedButton() {
        const existing = document.querySelector('.kosteam-buy-selected-sidebar');
        if (existing && !existing.classList.contains('kosteam-cart-btn')) return;
        if (existing) existing.remove();

        // 사이드바의 "결제 계속하기" 버튼 찾기 (가장 오른쪽에 보이는 것)
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

    async function tryAutoRestore() {
        const snapshot = getSnapshot();
        let restoreState = {};
        try {
            restoreState = await storageGet([
                PENDING_CART_RESTORE_KEY,
                CART_RESTORE_COMPLETE_KEY,
                CART_PURCHASE_COMPLETE_KEY
            ]);
        } catch (err) {
            console.debug('[KOSTEAM] Pending restore state read error:', err);
        }

        if (restoreState[CART_RESTORE_COMPLETE_KEY]) {
            localStorage.removeItem(SNAPSHOT_STORAGE_KEY);
            await clearPendingRestore();
            return;
        }

        const pending = restoreState[PENDING_CART_RESTORE_KEY];
        if (!restoreState[CART_PURCHASE_COMPLETE_KEY]) {
            return;
        }

        const restoreItems = snapshot?.removedItems?.length
            ? snapshot.removedItems
            : (Array.isArray(pending?.removedItems) ? pending.removedItems : []);
        const shouldAutoRestore = (snapshot?.autoRestore === true || pending?.autoRestore === true) && restoreItems.length > 0;

        if (!shouldAutoRestore) {
            return;
        }

        console.log('[KOSTEAM] Auto-restoring', restoreItems.length, 'items');

        const result = await restoreItemsToCart(restoreItems);

        if (result?.success) {
            localStorage.removeItem(SNAPSHOT_STORAGE_KEY);
            await clearPendingRestore(true);
            // 복원 성공 → 조용히 새로고침 (API 결과를 DOM에 반영하려면 필요)
            window.location.reload();
        } else {
            console.error('[KOSTEAM] Auto-restore failed:', result?.error);
        }
    }

    // ========== Initialization ==========

    function scheduleRefresh(force = false) {
        const now = Date.now();
        if (!force && now - lastRefreshAt < REFRESH_DEBOUNCE_MS && refreshScheduled) return;
        if (refreshScheduled) return;

        refreshScheduled = true;
        setTimeout(() => {
            refreshScheduled = false;
            lastRefreshAt = Date.now();
            decorateItems();
        }, REFRESH_DEBOUNCE_MS);
    }

    const observer = new MutationObserver(() => scheduleRefresh());

    function init() {
        tryAutoRestore();
        scheduleRefresh(true);
        observer.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
