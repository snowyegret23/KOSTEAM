/**
 * KOSTEAM Cart Enhancer
 * Adds per-item selection and checkout controls in Steam cart
 */

import { sendMessage, storageGet } from './shared/api.js';
import { MSG_RESTORE_CART } from './shared/constants.js';

(async function () {
    const CART_PATH_PREFIX = '/cart';
    const REMOVE_TEXTS = ['remove', '삭제', '제거', '삭제하기'];
    const SNAPSHOT_STORAGE_KEY = 'kosteam_cart_snapshot';
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
        } catch {
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
        const link = item.querySelector('a[href*="/app/"], a[href*="/sub/"], a[href*="/bundle/"]');
        if (!link) return null;
        const href = link.getAttribute('href') || '';
        const match = href.match(/\/(app|sub|bundle)\/(\d+)/);
        return match ? `${match[1]}:${match[2]}` : null;
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
        const links = node.querySelectorAll('a[href*="/app/"], a[href*="/sub/"], a[href*="/bundle/"]');
        if (links.length !== 1 && !node.querySelector('a[href*="/bundle/"]')) return false;
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
            .filter(el => el.querySelector('a[href*="/app/"], a[href*="/sub/"], a[href*="/bundle/"]'));

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
            const link = item.querySelector('a[href*="/app/"], a[href*="/sub/"], a[href*="/bundle/"]');
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
                    const name = extractItemName(item)?.substring(0, 20);
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
                const name = extractItemName(item)?.substring(0, 20);
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

                const name = extractItemName(item)?.substring(0, 20);
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
        const link = item.querySelector('a[href*="/app/"], a[href*="/sub/"], a[href*="/bundle/"]');
        if (!link) return null;

        const img = link.querySelector('img');
        if (img?.alt) return img.alt;

        const text = link.textContent?.trim();
        if (text) return text;

        const titleEl = item.querySelector('[class*="title"], [class*="name"], h1, h2, h3, h4');
        return titleEl?.textContent?.trim() || null;
    }

    function extractItemLink(item) {
        const link = item.querySelector('a[href*="/app/"], a[href*="/sub/"], a[href*="/bundle/"]');
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

    async function buildExportData(items) {
        const cartInfoMap = await mapDomItemsToCartInfo(items);

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

    function getSnapshot() {
        try {
            const raw = localStorage.getItem(SNAPSHOT_STORAGE_KEY);
            if (!raw) return null;

            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return null;

            // 새 형식: removedItems 배열만 사용
            const removedItems = Array.isArray(parsed.removedItems) ? parsed.removedItems : [];
            const savedWithSelection = parsed.savedWithSelection === true;

            return { removedItems, savedWithSelection };
        } catch {
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
            } catch {
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
        const wishlistAllButton = createButton('전부 찜 목록에 추가', 'kosteam-cart-wishlist-all-btn');
        const wishlistSelectedButton = createButton('선택항목을 찜 목록에 추가', 'kosteam-cart-wishlist-selected-btn');
        const jsonButton = createButton('JSON 저장', 'kosteam-cart-json-btn');
        const keepButton = createButton('선택항목만 남기기', 'kosteam-cart-keep-btn');
        const restoreButton = createButton('복원', 'kosteam-cart-restore-btn');

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
        });

        wishlistAllButton.addEventListener('click', handleSendAllToWishlist);
        wishlistSelectedButton.addEventListener('click', handleSendSelectedToWishlist);
        jsonButton.addEventListener('click', handleJsonExport);
        keepButton.addEventListener('click', handleKeepSelected);
        restoreButton.addEventListener('click', handleRestore);

        bar.appendChild(label);
        bar.appendChild(total);
        bar.appendChild(wishlistAllButton);
        bar.appendChild(wishlistSelectedButton);
        bar.appendChild(jsonButton);
        bar.appendChild(keepButton);
        bar.appendChild(restoreButton);
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

    async function handleKeepSelected(e) {
        e.preventDefault();
        e.stopPropagation();

        const items = findCartItems();

        // DOM과 API 데이터 동기화 확인
        if (!validateCartSync(items.length)) {
            if (!DISABLE_CART_DIALOGS) {
                window.alert('장바구니 항목 수가 일치하지 않습니다. 새로고침 후 다시 시도해 주세요.');
            }
            return;
        }

        // 매핑 수행
        const cartInfoMap = await mapDomItemsToCartInfo(items);

        // 체크된 항목과 체크되지 않은 항목 분류
        const checkedItems = [];
        const uncheckedItems = [];

        items.forEach((item, index) => {
            const box = item.querySelector('.kosteam-cart-checkbox');
            const cartInfo = cartInfoMap.get(item);
            const name = extractItemName(item) || `Item ${index + 1}`;

            if (box?.checked) {
                checkedItems.push({ element: item, cartInfo, name });
            } else {
                uncheckedItems.push({ element: item, cartInfo, name });
            }
        });

        if (checkedItems.length === 0) {
            if (!DISABLE_CART_DIALOGS) {
                window.alert('선택된 항목이 없습니다.');
            }
            return;
        }

        if (uncheckedItems.length === 0) {
            if (!DISABLE_CART_DIALOGS) {
                window.alert('모든 항목이 선택되어 있습니다. 제거할 항목이 없습니다.');
            }
            return;
        }

        // 제거할 항목의 cart info 추출
        const itemsToRemove = uncheckedItems
            .map(item => item.cartInfo)
            .filter(info => info?.id > 0);

        if (itemsToRemove.length === 0) {
            if (!DISABLE_CART_DIALOGS) {
                window.alert('제거할 항목을 찾을 수 없습니다.');
            }
            return;
        }

        // 확인 메시지
        const keepNames = checkedItems.map(i => i.name).join(', ');
        const removeNames = uncheckedItems.map(i => i.name).join(', ');

        if (!DISABLE_CART_DIALOGS) {
            if (!window.confirm(`[유지] ${keepNames}\n\n[제거] ${removeNames}\n\n제거할까요? (복원 버튼으로 되돌릴 수 있습니다)`)) {
                return;
            }
        }

        // 스냅샷 저장
        saveSnapshot({
            removedItems: itemsToRemove,
            savedWithSelection: true
        });

        // DOM에서 체크되지 않은 항목 제거 (역순으로)
        for (let i = uncheckedItems.length - 1; i >= 0; i--) {
            const removeButton = findRemoveButton(uncheckedItems[i].element);
            removeButton?.click();
        }

        if (!DISABLE_CART_DIALOGS) {
            window.alert(`${itemsToRemove.length}개 항목을 제거했습니다.\n복원 버튼으로 되돌릴 수 있습니다.`);
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

    async function handleRestore(e) {
        e.preventDefault();
        e.stopPropagation();

        const snapshot = getSnapshot();
        if (!snapshot?.savedWithSelection || !snapshot.removedItems?.length) {
            if (!DISABLE_CART_DIALOGS) {
                window.alert('복원할 저장 데이터가 없습니다. 먼저 "선택항목만 남기기"를 사용해 주세요.');
            }
            return;
        }

        const itemsToRestore = snapshot.removedItems;

        // 현재 장바구니에 이미 있는 항목 제외
        const currentCartItems = getCartItemsWithType();
        const currentCartIds = new Set(currentCartItems.map(i => `${i.type}:${i.id}`));
        const restoreItems = itemsToRestore.filter(item => !currentCartIds.has(`${item.type}:${item.id}`));

        if (restoreItems.length === 0) {
            if (!DISABLE_CART_DIALOGS) {
                window.alert('복원할 항목이 없습니다. (이미 장바구니에 있거나 저장된 항목이 없음)');
            }
            return;
        }

        // 복원할 항목 표시
        const restoreInfo = restoreItems.map(item =>
            `${item.type === 'bundle' ? 'bundle' : 'pkg'}:${item.id}`
        ).join(', ');

        if (!DISABLE_CART_DIALOGS) {
            if (!window.confirm(`다음 항목을 복원할까요?\n${restoreInfo}`)) return;
        }

        const result = await restoreItemsToCart(restoreItems);
        if (result?.success) {
            // 복원 성공 시 스냅샷 삭제
            localStorage.removeItem(SNAPSHOT_STORAGE_KEY);
            if (!DISABLE_CART_DIALOGS) {
                window.alert(result.opaque
                    ? '복원 요청을 전송했습니다. 반영까지 몇 초 걸릴 수 있어요. 곧 자동 새로고침합니다.'
                    : '복원 요청을 보냈습니다. 곧 자동 새로고침합니다.');
            }
            setTimeout(() => window.location.reload(), 3000);
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

    function decorateItems() {
        const items = findCartItems();
        ensureActionBar();

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

            const key = getItemKey(item);
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

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            scheduleRefresh(true);
            observer.observe(document.body, { childList: true, subtree: true });
        });
    } else {
        scheduleRefresh(true);
        observer.observe(document.body, { childList: true, subtree: true });
    }
})();
