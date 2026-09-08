import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { rollup } from 'rollup';

const readSource = name => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf-8');

test('dynamic page checks use observers without polling or whole-body text scans', () => {
    for (const name of ['content.js', 'community.js', 'search_bypass.js', 'cart_restore.js']) {
        const source = readSource(name);
        assert.match(source, /MutationObserver/, name);
        assert.doesNotMatch(source, /\bset(?:Timeout|Interval)\s*\(/, name);
        assert.doesNotMatch(source, /\binnerText\b/, name);
    }
});

test('store fallback restoration requires the matching checkout receipt marker', () => {
    const restore = readSource('cart_restore.js');
    assert.match(restore, /CART_PURCHASE_COMPLETE_KEY/);
    assert.match(restore, /purchaseMarker\?\.transactionId === pending\.transactionId/);
});

test('checkout completion uses strict receipt state and background-owned restoration', () => {
    const restore = readSource('cart_restore.js');
    const background = readSource('background.js');

    assert.match(restore, /isConfirmedCheckoutReceipt/);
    assert.doesNotMatch(restore, /CHECKOUT_RECEIPT_SELECTORS/);
    assert.doesNotMatch(restore, /#receipt_pipeline|#checkout_logo_receipt/);
    assert.match(restore, /async function completePurchaseAndRestore/);
    assert.match(
        background,
        /markCartPurchaseComplete\([\s\S]+?\.then\(async marked =>[\s\S]+?restorePendingCart\(/
    );
});

test('destructive cart controls use stable element relationships', () => {
    const cart = readSource('cart.js');

    assert.match(cart, /getRemoveControlIndex/);
    assert.match(cart, /isContextualRemoveControl/);
    assert.match(cart, /aria-labelledby/);
    assert.match(cart, /linkedNames\.includes\(contextName\)/);
    assert.match(cart, /findReAddableRemoveButton/);
    assert.match(cart, /findReAddableRemoveButton\(item\);\s+if \(!removeButton\)[\s\S]+?removeButton\.click\(\)/);
    assert.match(cart, /isConnected/);
    assert.match(cart, /aria-hidden/);
    assert.doesNotMatch(cart, /_3YCgcpoCojlbS6DvkNsG2J|_3F0SnUeC_obtI4WyQtijAa|_17GFdSD2pc0BquZk5cejg8|_2rkDlHZ2yi-tFtDk4-CC4U/);
});

// Execute the actual extension bundles against DOM fixtures. Network and extension
// APIs are supplied by the fixture; rendering, events and observers run normally.
const bundles = Object.fromEntries(await Promise.all(
    ['content', 'search_bypass', 'community', 'popup', 'background', 'cart'].map(async name => {
        const bundle = await rollup({ input: fileURLToPath(new URL(`../src/${name}.js`, import.meta.url)) });
        try {
            const { output } = await bundle.generate({ format: 'iife' });
            return [name, output[0].code];
        } finally {
            await bundle.close();
        }
    })
));
const settle = () => new Promise(resolve => setImmediate(resolve));

function createPage(t, { html = '', url = 'https://store.steampowered.com/app/42/',
    settings = {}, info = null, promiseApi = false, permissions = {}, alarms = true, respond } = {}) {
    const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
        url, runScripts: 'outside-only', pretendToBeVisual: true
    });
    const { window } = dom;
    t.after(() => {
        window.dispatchEvent(new window.Event('pagehide'));
        window.close();
    });
    const local = { ...settings };
    const changes = [];
    const messages = [];
    const navigations = [];
    let messageHandler;
    const asynchronous = fn => (...args) => {
        if (promiseApi) return Promise.resolve(fn(...args));
        const callback = args.pop();
        Promise.resolve(fn(...args)).then(callback);
    };
    const api = {
        runtime: {
            id: 'test-extension',
            getURL: value => `chrome-extension://test-extension/${value}`,
            sendMessage: asynchronous(message => {
                messages.push(message);
                return respond ? respond(message) : { success: true, info };
            }),
            onMessage: { addListener: callback => { messageHandler = callback; } },
            onInstalled: { addListener() {} },
            onStartup: { addListener() {} }
        },
        storage: {
            local: {
                get: asynchronous(keys => Object.fromEntries(keys.map(key => [key, local[key]]))),
                set: asynchronous(values => Object.assign(local, values))
            },
            onChanged: { addListener: callback => changes.push(callback) }
        },
        ...(permissions === null ? {} : { permissions: { getAll: asynchronous(() => permissions) } }),
        ...(alarms ? { alarms: { onAlarm: { addListener() {} } } } : {})
    };
    window[promiseApi ? 'browser' : 'chrome'] = api;
    window.console = { log() {}, error() {}, debug() {} };
    Object.assign(window, { TextEncoder, TextDecoder, AbortController });
    return {
        window, document: window.document, local, messages, navigations,
        async run(script = 'content') {
            if (script === 'search_bypass') {
                // jsdom does not navigate. Capture replace() while retaining its DOM/events.
                vm.runInNewContext(bundles[script], {
                    window: {
                        location: Object.assign(new URL(url), { replace: value => navigations.push(value) }),
                        addEventListener: window.addEventListener.bind(window)
                    },
                    document: window.document, MutationObserver: window.MutationObserver,
                    URL, console: window.console, [promiseApi ? 'browser' : 'chrome']: api
                });
            } else {
                window.eval(bundles[script]);
            }
            await settle();
        },
        async update(values) {
            const updated = Object.fromEntries(Object.entries(values).map(([key, newValue]) =>
                [key, { oldValue: local[key], newValue }]));
            Object.assign(local, values);
            changes.forEach(callback => callback(updated, 'local'));
            await settle();
        },
        send: message => new Promise(resolve => messageHandler(message,
            { id: 'test-extension', url }, resolve))
    };
}

const purchaseArea = '<main id="purchase"><div id="game_area_purchase"><div class="game_area_purchase_game_wrapper" id="buy">Buy</div></div></main>';
const languageTable = (cell = '', label = 'Korean') => `<aside><table class="game_language_options"><tr><td class="ellipsis">${label}</td><td class="checkcol">${cell}</td></tr></table></aside>`;
const userPatch = {
    type: 'user', sources: ['steamapp', 'quasarplay'], links: ['', ''],
    patch_sources: ['steamapp', 'quasarplay'], patch_descriptions: ['제작자: 번역팀', '유저 한글 패치'],
    source_site_urls: {
        steamapp: 'https://hanpe.net/hangul/42',
        quasarplay: 'https://store.steampowered.com/app/42/?curator_clanid=42788178'
    }
};

test('1.6.3 banners stay above purchases for every patch type and both browser APIs', async t => {
    for (const promiseApi of [false, true]) {
        for (const [info, cell, expected] of [
            [null, '<span>✔</span>', '공식 한국어'],
            [userPatch, '<span>✔</span>', '공식(추가정보 존재)'],
            [userPatch, '', '유저패치'],
            [{ ...userPatch, type: 'official' }, '', '공식지원 추정'],
            [{ ...userPatch, sources: ['directg'] }, '', '다이렉트 게임즈'],
            [{ ...userPatch, sources: ['stove'] }, '', '스토브'],
            [null, '', '한국어 없음']
        ]) {
            const page = createPage(t, { html: purchaseArea + languageTable(cell), info, promiseApi });
            await page.run();
            assert.equal(page.document.querySelectorAll('.kr-patch-banner').length, 1);
            assert.equal(page.document.querySelector('#buy').previousElementSibling?.className, 'kr-patch-banner');
            assert.equal(page.document.querySelector('aside .kr-patch-banner'), null);
            assert.equal(page.document.querySelector('.kr-patch-type-label').textContent, expected);
        }
    }
});

test('1.6.3 literal language checkmarks still identify official Korean support', async t => {
    const page = createPage(t, { html: purchaseArea + languageTable('✔') });
    await page.run();
    assert.equal(page.document.querySelector('.kr-patch-type-label').textContent, '공식 한국어');
});

test('purchase container fallbacks keep free-to-play and older store layouts out of the sidebar', async t => {
    for (const target of ['class="game_area_purchase"', 'id="game_area_purchase"']) {
        const page = createPage(t, { html: `${languageTable('<span>✔</span>')}<main><div ${target}>Play</div></main>` });
        await page.run();
        const purchase = page.document.querySelector('main').lastElementChild;
        assert.equal(purchase.textContent, 'Play');
        assert.equal(purchase.previousElementSibling?.className, 'kr-patch-banner');
        assert.equal(page.document.querySelector('aside .kr-patch-banner'), null);
    }
});

test('1.6.3 database patch information remains visible without a language table', async t => {
    const page = createPage(t, { html: purchaseArea, info: userPatch });
    await page.run();
    assert.equal(page.document.querySelector('.kr-patch-type-label')?.textContent, '유저패치');
    page.document.body.insertAdjacentHTML('beforeend', languageTable('<span>✔</span>'));
    await settle();
    assert.equal(page.document.querySelector('.kr-patch-type-label')?.textContent, '공식(추가정보 존재)');
    assert.equal(page.document.querySelectorAll('.kr-patch-banner').length, 1);
});

test('native Korean notices are replaced completely and restored by the display toggle', async t => {
    for (const wrapper of ['id="purchase_note"', 'class="notice_box"']) {
        const notice = `<div ${wrapper}><div class="notice_box_top"></div><div class="notice_box_content"><b>한국어(을)를 지원하지 않습니다</b><p>구매 전에 언어 목록을 확인하세요.</p></div><div class="notice_box_bottom"></div></div>`;
        const page = createPage(t, { html: `<main>${notice}<div id="buy" class="game_area_purchase_game_wrapper"></div></main>${languageTable()}`, info: userPatch });
        const original = page.document.querySelector('main').firstElementChild;
        await page.run();
        assert.equal(original.isConnected, false);
        assert.equal(page.document.querySelector('.notice_box_bottom'), null);
        await page.update({ disable_patch_info: true });
        assert.equal(page.document.querySelector('.kr-patch-banner'), null);
        assert.equal(page.document.querySelector('main').firstElementChild, original);
        await page.update({ disable_patch_info: false });
        assert.equal(original.isConnected, false);
        assert.equal(page.document.querySelector('#buy').previousElementSibling.className, 'kr-patch-banner');
    }
});

test('empty patch links retain source descriptions, ordering and live source toggles', async t => {
    const page = createPage(t, { html: purchaseArea + languageTable(), info: userPatch });
    await page.run();
    const rows = () => [...page.document.querySelectorAll('.kr-patch-link-item')];
    assert.deepEqual(rows().map(row => row.querySelector('a').href), Object.values(userPatch.source_site_urls));
    assert.deepEqual(rows().map(row => row.querySelector('.kr-patch-link-description').textContent), userPatch.patch_descriptions);
    await page.update({ source_steamapp: false });
    assert.equal(rows().length, 1);
    assert.equal(rows()[0].querySelector('.kr-patch-link-label').textContent, '링크 1:');
    assert.equal(rows()[0].querySelector('a').href, userPatch.source_site_urls.quasarplay);
    await page.update({ source_steamapp: true });
    assert.deepEqual(rows().map(row => row.querySelector('a').href), Object.values(userPatch.source_site_urls));
});

test('legacy language notices are replaced without removing the game description', async t => {
    const page = createPage(t, { html: `<div id="purchase_note"><div class="game_area_description">한국어 언어 인터페이스를 지원하지 않습니다.</div></div>${purchaseArea}${languageTable()}<div class="game_area_description" id="about">게임 설명: 언어 인터페이스 설정</div>`, info: userPatch });
    await page.run();
    assert.equal(page.document.querySelector('#purchase_note'), null);
    assert.equal(page.document.querySelector('#about').textContent, '게임 설명: 언어 인터페이스 설정');
});

test('late patch responses cannot undo a display toggle or replace newer patch data', async t => {
    const replies = [];
    const page = createPage(t, { html: purchaseArea + languageTable(),
        respond: () => new Promise(resolve => replies.push(resolve)) });
    await page.run();
    await page.update({ disable_patch_info: true });
    replies.shift()({ success: true, info: userPatch });
    await settle();
    assert.equal(page.document.querySelector('.kr-patch-banner'), null);
    await page.update({ disable_patch_info: false });
    await page.update({ kr_patch_alias: { 42: '43' } });
    replies[1]({ success: true, info: { ...userPatch, type: 'official' } });
    await settle();
    replies[0]({ success: true, info: userPatch });
    await settle();
    assert.equal(page.document.querySelector('.kr-patch-type-label').textContent, '공식지원 추정');
});

test('curator links wait for visible legacy and current reviews, then scroll only once', async t => {
    for (const marker of ['class="referring_curator_ctn"', 'data-featuretarget="referring-curator-review"']) {
        const page = createPage(t, { url: 'https://store.steampowered.com/app/42/?curator_clanid=42788178' });
        const calls = [];
        page.window.HTMLElement.prototype.scrollIntoView = function () { calls.push(this); };
        page.window.HTMLElement.prototype.getBoundingClientRect = function () {
            return { height: this.hidden || !this.textContent ? 0 : 100 };
        };
        await page.run();
        page.document.body.insertAdjacentHTML('beforeend', `<section ${marker} hidden></section>`);
        const review = page.document.querySelector('section');
        await settle();
        assert.equal(calls.length, 0);
        review.textContent = '추천 게임';
        review.hidden = false;
        await settle();
        assert.deepEqual(calls, [review]);
        review.append(' 추가 설명');
        await settle();
        assert.deepEqual(calls, [review]);
    }
});

test('curator scrolling does not run on ordinary app links or after leaving the page', async t => {
    for (const query of ['', '?curator_clanid=42788178']) {
        const page = createPage(t, { url: `https://store.steampowered.com/app/42/${query}` });
        let scrolls = 0;
        page.window.HTMLElement.prototype.scrollIntoView = () => scrolls++;
        page.window.HTMLElement.prototype.getBoundingClientRect = () => ({ height: 100 });
        await page.run();
        page.window.dispatchEvent(new page.window.Event('pagehide'));
        page.document.body.insertAdjacentHTML('beforeend', '<section data-featuretarget="referring-curator-review">Review</section>');
        await settle();
        assert.equal(scrolls, 0);
    }
});

test('1.6.3 search bypass preserves search terms and explicit filters with ndl=1', async t => {
    for (const path of ['/search?term=car&supportedlang=koreana&specials=1', '/search/?ndl=0&term=car']) {
        const page = createPage(t, { url: `https://store.steampowered.com${path}` });
        await page.run('search_bypass');
        assert.equal(page.navigations.length, 1);
        const target = new URL(page.navigations[0]);
        const expected = new URL(`https://store.steampowered.com${path}`);
        expected.searchParams.set('ndl', '1');
        assert.equal(target.href, expected.href);
    }
    const page = createPage(t, { url: 'https://store.steampowered.com/search/?ndl=1' });
    await page.run('search_bypass');
    assert.deepEqual(page.navigations, []);
});

const filterChip = text => `<a href=""><svg class="SVGIcon_X_Line"></svg><span>${text}</span></a>`;

test('1.6.3 category, tag, genre, VR, Deck and sale pages remove only the selected Korean chip', async t => {
    for (const path of ['/category/action/', '/tags/en/Action/', '/genre/Free%20to%20Play/', '/vr/', '/greatondeck/', '/specials/', '/sale/test']) {
        const page = createPage(t, { url: `https://store.steampowered.com${path}`,
            html: `<a href="/app/42/"><svg></svg><span>Korean Game</span></a><div id="filters">${filterChip('English')}${filterChip('한국어 (Korean)')}</div>` });
        let clicks = 0;
        const selected = page.document.querySelector('#filters').lastElementChild;
        selected.addEventListener('click', event => { event.preventDefault(); clicks++; selected.remove(); });
        await page.run('search_bypass');
        assert.equal(clicks, 1, path);
        assert.equal(page.document.querySelector('#filters').textContent, 'English');
        assert.equal(page.document.querySelector('a[href="/app/42/"]').textContent, 'Korean Game');
        page.document.querySelector('#filters').append(selected);
        await settle();
        assert.equal(clicks, 1, 'later manual selections must be preserved');
    }
});

test('category bypass waits for delayed filters and does nothing when disabled', async t => {
    for (const enabled of [true, false]) {
        const page = createPage(t, { url: 'https://store.steampowered.com/category/action/',
            settings: { bypass_language_filter: enabled } });
        await page.run('search_bypass');
        const host = page.document.createElement('div');
        host.innerHTML = filterChip('한국어');
        let clicks = 0;
        host.firstElementChild.addEventListener('click', event => { event.preventDefault(); clicks++; });
        page.document.body.append(host);
        await settle();
        assert.equal(clicks, enabled ? 1 : 0);
    }
    const page = createPage(t, { url: 'https://store.steampowered.com/search/', settings: { bypass_language_filter: false } });
    await page.run('search_bypass');
    assert.deepEqual(page.navigations, []);
});

test('mobile category bypass opens and closes its filter panel after removing Korean', async t => {
    for (const nestedLabel of [false, true]) {
        const page = createPage(t, { url: 'https://store.steampowered.com/category/action/',
            html: `<div data-featuretarget="sale-display"><div><div id="toggle">${nestedLabel ? '<svg class="SVGIcon_Filter"></svg><div>필터</div>' : '필터'}</div><div class="loading-placeholder"></div></div></div>` });
        const toggle = page.document.querySelector('#toggle');
        let toggles = 0;
        let removals = 0;
        const togglePanel = () => {
            toggles++;
            toggle.innerHTML = nestedLabel ? '<svg></svg><div>닫기</div>' : '닫기';
            if (toggles === 1) {
                const panel = page.document.createElement('div');
                panel.innerHTML = filterChip('Korean');
                panel.firstElementChild.addEventListener('click', event => {
                    event.preventDefault(); removals++; panel.remove();
                });
                toggle.after(panel);
            }
        };
        if (nestedLabel) toggle.addEventListener('click', togglePanel);
        else toggle.onclick = togglePanel;
        await page.run('search_bypass');
        await settle();
        assert.equal(removals, 1);
        assert.equal(toggles, 2);
    }
});

test('mobile filters close when there is no Korean selection and hidden tabs wait until visible', async t => {
    const page = createPage(t, { url: 'https://store.steampowered.com/category/action/',
        html: '<div data-featuretarget="sale-display"><button>Filters</button></div>' });
    Object.defineProperty(page.document, 'visibilityState', { configurable: true, value: 'hidden' });
    const button = page.document.querySelector('button');
    let clicks = 0;
    button.onclick = () => {
        clicks++;
        button.textContent = clicks === 1 ? 'Close' : 'Filters';
        if (clicks === 1) button.insertAdjacentHTML('afterend', '<input class="DialogInput"><a href="">Action</a>');
    };
    await page.run('search_bypass');
    assert.equal(clicks, 0);
    Object.defineProperty(page.document, 'visibilityState', { value: 'visible' });
    page.document.dispatchEvent(new page.window.Event('visibilitychange'));
    await settle();
    assert.equal(clicks, 2);
    assert.equal(button.textContent, 'Filters');
});

test('mobile bypass waits for filter data before deciding that no Korean filter is selected', async t => {
    const page = createPage(t, { url: 'https://store.steampowered.com/category/action/',
        html: '<div data-featuretarget="sale-display"><button>Filters</button></div>' });
    const button = page.document.querySelector('button');
    let clicks = 0;
    let removals = 0;
    button.onclick = () => {
        clicks++;
        button.textContent = clicks === 1 ? 'Close' : 'Filters';
        if (clicks === 1) button.insertAdjacentHTML('afterend', '<input class="DialogInput"><a href="" id="option"></a>');
    };
    await page.run('search_bypass');
    assert.equal(clicks, 1, 'keep the loading panel open');
    page.document.querySelector('#option').textContent = 'Action';
    const chip = page.document.createElement('a');
    chip.innerHTML = '<svg></svg><span>한국어</span>';
    chip.addEventListener('click', () => { removals++; chip.remove(); });
    button.after(chip);
    await settle();
    assert.equal(removals, 1);
    assert.equal(clicks, 2);
});

test('community store buttons work for delayed headers and do not duplicate Steam links', async t => {
    for (const existing of [false, true]) {
        const page = createPage(t, { url: 'https://steamcommunity.com/app/42/discussions/' });
        await page.run('community');
        page.document.body.insertAdjacentHTML('beforeend', `<div class="apphub_OtherSiteInfo">${existing ? '<a href="https://store.steampowered.com/app/42/">Store</a>' : ''}</div>`);
        await settle();
        const links = page.document.querySelectorAll('.apphub_OtherSiteInfo a');
        assert.equal(links.length, 1);
        assert.equal(new URL(links[0].href).pathname.replace(/\/$/, ''), '/app/42');
        assert.equal(page.document.querySelectorAll('.kosteam-store-link').length, existing ? 0 : 1);
    }
});

test('popup display settings remain usable when the cart permission API is unavailable', async t => {
    const html = readFileSync(new URL('../src/static/popup.html', import.meta.url), 'utf8');
    const page = createPage(t, { html, permissions: null, settings: { disable_patch_info: true } });
    await page.run('popup');
    const toggle = page.document.getElementById('disable_patch_info');
    assert.equal(toggle.checked, true);
    toggle.click();
    await settle();
    assert.equal(page.local.disable_patch_info, false);
    page.document.getElementById('refreshBtn').click();
    await settle();
    assert.ok(page.messages.some(message => message.type === 'REFRESH_DATA'));
});

test('an open popup follows the initial database download and ignores an older update result', async t => {
    for (const promiseApi of [false, true]) {
        const html = readFileSync(new URL('../src/static/popup.html', import.meta.url), 'utf8');
        let initialStatus;
        let checks = 0;
        const page = createPage(t, { html, promiseApi, respond: message => {
            if (message.type !== 'CHECK_UPDATE_STATUS') return { success: true };
            if (++checks === 1) return new Promise(resolve => { initialStatus = resolve; });
            return { success: true, needsUpdate: false };
        } });
        await page.run('popup');
        assert.equal(page.document.querySelector('#gameCount').textContent, '-');
        await page.update({
            kr_patch_data: { _meta: { total: 1 }, 42: userPatch },
            kr_patch_version: { generated_at: 'downloaded' }
        });
        assert.equal(page.document.querySelector('#gameCount').textContent, '1개');
        assert.equal(page.document.querySelector('#dbStatus').textContent, '최신 버전');
        initialStatus({ success: true, needsUpdate: true });
        await settle();
        assert.equal(page.document.querySelector('#dbStatus').textContent, '최신 버전');
    }
});

test('missing alarms API cannot prevent the background from serving cached patch information', async t => {
    const lookup = { _meta: { generated_at: 'fixture', total: 1 }, 42: userPatch };
    const page = createPage(t, { alarms: false, settings: {
        kr_patch_data: lookup, kr_patch_alias: {}, kr_last_update_check: Date.now()
    } });
    await page.run('background');
    const response = await page.send({ type: 'GET_PATCH_INFO', appId: '42' });
    assert.equal(response.success, true);
    assert.equal(response.info, userPatch);
});

test('guest cart actions explain missing account data and never download an unrestorable backup', async t => {
    for (const promiseApi of [false, true]) {
        for (const lineItems of [[], [{ line_item_id: '1', packageid: 100 }]]) {
            const page = createPage(t, { url: 'https://store.steampowered.com/cart/', promiseApi,
                settings: { cart_feature_enabled: true }, html: `<style>* { opacity: 1; }</style>
                <div id="application_config"></div><main id="page_root">
                <article data-line-item-id="1"><a href="/app/42/">First game</a><span>₩ 1,000</span><button data-cart-remove>Remove</button></article>
                <article data-line-item-id="2"><a href="/app/43/">Second game</a><span>₩ 2,000</span><button data-cart-remove>Remove</button></article></main>` });
            const { window, document } = page;
            document.querySelector('#application_config').setAttribute('data-store_user_config', JSON.stringify({
                accountcart: { cart: { line_items: lineItems } }
            }));
            window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 0, width: 400, height: 50 });
            const alerts = [];
            let downloads = 0;
            window.alert = text => alerts.push(text);
            window.URL.createObjectURL = () => { downloads++; return 'blob:https://store.steampowered.com/fixture'; };
            window.URL.revokeObjectURL = () => {};
            document.addEventListener('click', event => {
                if (event.target.closest('a[download]')) event.preventDefault();
            });
            await page.run('cart');
            await new Promise(resolve => window.requestAnimationFrame(resolve));
            document.querySelector('.kosteam-cart-json-btn').click();
            await settle();
            assert.equal(downloads, 0);
            assert.match(alerts[0], /Steam.*로그인/);
            document.querySelector('.kosteam-cart-checkbox').click();
            document.querySelector('.kosteam-cart-buy-selected-btn').click();
            await settle();
            assert.equal(alerts.length, 2);
            assert.match(alerts[1], /선택 구매.*로그인/);
            assert.equal(page.messages.length, 0);
            await page.update({ cart_feature_enabled: false });
        }
    }
});

test('1.6.3 cart selection, JSON backups and wishlist buttons retain their behavior', async t => {
    const token = `e30.${Buffer.from(JSON.stringify({ sub: '76561198000000001' })).toString('base64url')}.signature`;
    const page = createPage(t, { url: 'https://store.steampowered.com/cart/',
        settings: { cart_feature_enabled: true }, html: `<style>* { opacity: 1; }</style>
        <div id="application_config"></div><main id="page_root">
        <article data-line-item-id="1"><a href="/app/42/">First game</a><span>₩ 1,000</span><button data-cart-remove>Remove</button></article>
        <article data-line-item-id="2"><a href="/bundle/9/">Bundle</a><a href="/app/43/">Included game</a><span>₩ 2,000</span><button data-cart-remove>Remove</button></article>
        <a href="https://checkout.steampowered.com/checkout/" id="checkout">Continue</a></main>`,
        respond: () => ({ success: false, error: 'Fixture stops after inspecting the restore request' }) });
    const { window, document } = page;
    const config = document.querySelector('#application_config');
    config.setAttribute('data-store_user_config', JSON.stringify({ webapi_token: token,
        accountcart: { cart: { line_items: [
            { line_item_id: '1', packageid: 100 }, { line_item_id: '2', bundleid: 9 }
        ] } } }));
    config.setAttribute('data-userinfo', JSON.stringify({ country_code: 'KR' }));
    window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 0, width: 400, height: 50 });
    window.alert = () => {};
    window.confirm = () => true;
    document.cookie = 'sessionid=fixture-session';
    const wishlist = [];
    window.fetch = async (url, options) => {
        assert.equal(url, 'https://store.steampowered.com/api/addtowishlist');
        wishlist.push(options.body.get('appid'));
        return { ok: true, json: async () => ({ success: true }) };
    };
    const downloads = [];
    window.Blob = Blob;
    window.URL.createObjectURL = blob => { downloads.push(blob); return 'blob:https://store.steampowered.com/fixture'; };
    window.URL.revokeObjectURL = () => {};
    document.addEventListener('click', event => {
        if (event.target.closest('a[download], #checkout')) event.preventDefault();
    });
    await page.run('cart');
    await new Promise(resolve => window.requestAnimationFrame(resolve));
    assert.equal(document.querySelectorAll('.kosteam-cart-checkbox').length, 2);
    document.querySelector('.kosteam-cart-checkbox').click();
    assert.equal(document.querySelector('.kosteam-cart-total').textContent, '선택 합계: ₩ 1,000');
    assert.equal(document.querySelector('.kosteam-cart-selectall-checkbox').indeterminate, true);
    document.querySelector('.kosteam-cart-wishlist-selected-btn').click();
    await settle();
    assert.deepEqual(wishlist, ['42']);
    wishlist.length = 0;
    document.querySelector('.kosteam-cart-wishlist-all-btn').click();
    await settle();
    assert.deepEqual(wishlist, ['42', '43']);
    document.querySelector('.kosteam-cart-json-btn').click();
    await settle();
    const backup = JSON.parse(await downloads[0].text());
    assert.deepEqual(backup.items.map(({ type, packageId, bundleId }) => ({ type, packageId, bundleId })), [
        { type: 'package', packageId: 100, bundleId: undefined },
        { type: 'bundle', packageId: undefined, bundleId: 9 }
    ]);
    const nativeClick = window.HTMLInputElement.prototype.click;
    window.HTMLInputElement.prototype.click = function () {
        if (this.type !== 'file') return nativeClick.call(this);
        Object.defineProperty(this, 'files', { value: [{ size: 200, text: async () => JSON.stringify({
            items: [...backup.items, { type: 'package', packageId: 200, name: 'Old backup item' }]
        }) }] });
        this.dispatchEvent(new window.Event('change'));
    };
    document.querySelector('.kosteam-cart-json-import-btn').click();
    await settle();
    const restore = page.messages.find(message => message.type === 'RESTORE_CART');
    assert.deepEqual(JSON.parse(JSON.stringify(restore?.items)), [{ id: 200, type: 'package' }]);
    document.querySelector('.kosteam-cart-selectall-checkbox').click();
    assert.equal(document.querySelector('.kosteam-cart-total').textContent, '선택 합계: ₩ 3,000');
    let checkouts = 0;
    document.querySelector('#checkout').addEventListener('click', () => checkouts++);
    document.querySelector('.kosteam-cart-buy-selected-btn').click();
    await settle();
    assert.equal(checkouts, 1);
    await page.update({ cart_feature_enabled: false });
    assert.equal(document.querySelectorAll('.kosteam-cart-bar, .kosteam-cart-controls').length, 0);
});
