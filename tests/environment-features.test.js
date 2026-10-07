import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPage, settle } from './support/page.js';

const popupHtml = readFileSync(new URL('../src/static/popup.html', import.meta.url), 'utf8');
const samples = JSON.parse(readFileSync(new URL('./fixtures/store-samples.json', import.meta.url), 'utf8')).results;
const dataPermissions = ['authenticationInfo', 'locationInfo', 'websiteContent', 'websiteActivity'];
const pending = { transactionId: '97c2d3a4-9876-4321-8123-123456789abc', autoRestore: true,
    phase: 'checkout_started_unknown', recoveryRevision: 3, removedItems: [{ type: 'package', id: 100 }] };

test('popup: every source, bypass and banner setting persists and database refresh updates status', async t => {
    const page = createPage(t, { html: popupHtml, settings: { kr_patch_data: { _meta: {}, 42: {}, 43: {} } },
        respond: message => message.type === 'CHECK_UPDATE_STATUS'
            ? { success: true, needsUpdate: false } : { success: true, total: 2 } });
    await page.run('popup');
    assert.equal(page.document.querySelector('#gameCount').textContent, '2개');
    for (const id of ['source_steamapp', 'source_quasarplay', 'source_directg', 'source_stove', 'bypass_language_filter', 'disable_patch_info']) {
        const control = page.document.getElementById(id);
        for (let toggle = 0; toggle < 2; toggle++) {
            control.click();
            await settle();
            assert.equal(page.local[id], control.checked, id);
        }
    }
    page.document.querySelector('#refreshBtn').click();
    await settle();
    assert.equal(page.messages.filter(message => message.type === 'REFRESH_DATA').length, 1);
    assert.equal(page.document.querySelector('#refreshBtn').disabled, false);
    assert.equal(page.document.querySelector('#dbStatus').textContent, '최신 버전');
});

for (const [name, permissions, permissionGranted, enable] of [
    ['no optional permission API', {}, true, true],
    ['permission granted on request', { data_collection: [] }, true, true],
    ['permission denied', { data_collection: [] }, false, false],
    ['permission already granted', { data_collection: dataPermissions }, true, true],
    ['partial permission denied', { data_collection: ['authenticationInfo'] }, false, false]
]) {
    test(`popup cart consent: ${name}`, async t => {
        const page = createPage(t, { html: popupHtml, permissions, permissionGranted,
            respond: () => ({ success: true }) });
        await page.run('popup');
        const control = page.document.querySelector('#cart_feature_enabled');
        control.click();
        await settle();
        assert.equal(control.checked, enable);
        assert.equal(control.disabled, false);
        assert.equal(page.messages.some(message => message.type === 'SET_CART_FEATURE' && message.enabled === true), enable);
        if (page.permissionRequests.length) assert.deepEqual(Array.from(page.permissionRequests[0].data_collection), dataPermissions);
    });
}

for (const result of [{ success: false, error: 'Offline' }, null]) {
    test(`popup: failed refresh remains retryable (${result?.error || 'missing response'})`, async t => {
        const page = createPage(t, { html: popupHtml, respond: () => result });
        await page.run('popup');
        page.document.querySelector('#refreshBtn').click();
        await settle();
        assert.equal(page.document.querySelector('#refreshBtn').disabled, false);
        assert.equal(page.document.querySelector('#status').classList.contains('error'), true);
    });
}

for (let mask = 0; mask < 64; mask++) {
    test(`checkout receipt: visibility combination ${mask} cannot restore an unconfirmed purchase`, async t => {
        const visible = index => mask & (1 << index) ? '' : 'hidden';
        const page = createPage(t, { url: 'https://checkout.steampowered.com/checkout/',
            settings: { kosteam_pending_cart_restore: pending }, html: `<style>* {opacity:1}</style>
            <div id="cart_area" ${visible(2)}></div><div id="pending_receipt_area" ${visible(1)}></div>
            <div id="receipt_area" ${visible(0)}><div id="receipt_error_display" ${visible(3)}></div>
            <div id="purchase_summary_area" ${visible(4)}>Purchase summary</div>
            <div id="receipt_confirmation_code" ${visible(5)}>Confirmation</div></div>`,
            respond: () => ({ success: true }) });
        page.window.HTMLElement.prototype.getClientRects = function () {
            return this.closest('[hidden]') ? [] : [{ width: 100, height: 20 }];
        };
        await page.run('cart_restore');
        const expected = mask === 49;
        assert.equal(page.messages.length, Number(expected));
        if (expected) {
            assert.equal(page.messages[0].type, 'MARK_CART_PURCHASE_COMPLETE');
            assert.equal(page.messages[0].transactionId, pending.transactionId);
            assert.equal(page.messages[0].recoveryRevision, pending.recoveryRevision);
        }
        page.document.body.append('Later receipt update');
        await settle();
        assert.equal(page.messages.length, Number(expected));
    });
}

for (const [name, url, state, marker, expected] of [
    ['matched receipt', 'https://store.steampowered.com/app/42/', pending, pending.transactionId, true],
    ['missing receipt', 'https://store.steampowered.com/app/42/', pending, null, false],
    ['different transaction', 'https://store.steampowered.com/app/42/', pending, 'another', false],
    ['cart return', 'https://store.steampowered.com/cart/', pending, pending.transactionId, false],
    ['untrusted host', 'https://example.com/app/42/', pending, pending.transactionId, false],
    ['prepared transaction', 'https://store.steampowered.com/app/42/', { ...pending, phase: 'prepared' }, pending.transactionId, false],
    ['automatic restoration disabled', 'https://store.steampowered.com/app/42/', { ...pending, autoRestore: false }, pending.transactionId, false],
    ['nothing removed', 'https://store.steampowered.com/app/42/', { ...pending, removedItems: [] }, pending.transactionId, false]
]) {
    test(`store cart restoration: ${name}`, async t => {
        const page = createPage(t, { url, settings: { kosteam_pending_cart_restore: state,
            kosteam_purchase_completed_at: marker ? { transactionId: marker } : null }, respond: () => ({ success: true }) });
        await page.run('cart_restore');
        assert.equal(page.messages.length, Number(expected));
        if (expected) assert.equal(page.messages[0].type, 'RESTORE_PENDING_CART');
    });
}

const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
for (const condition of [...new Set(samples.map(sample => sample.expected))]) {
    const games = samples.filter(sample => sample.expected === condition);
    for (let mask = 0; mask < 32; mask++) {
        test(`cart: five ${condition} games, selection ${mask}, totals, wishlist, backup and guarded checkout`, async t => {
            const token = `e30.${Buffer.from(JSON.stringify({ sub: '76561198000000001' })).toString('base64url')}.fixture`;
            const page = createPage(t, { url: 'https://store.steampowered.com/cart/', settings: { cart_feature_enabled: true },
                html: `<style>* {opacity:1}</style><div id="application_config"></div><main id="page_root">${games.map((game, index) =>
                    `<article data-line-item-id="${index + 1}"><a href="/app/${game.appId}/"><img alt="${escape(game.title)}"></a><span id="product-${index}">${escape(game.title)}</span><span>₩ ${((index + 1) * 1000).toLocaleString('en-US')}</span><div><button role="button" id="add-${index}" title="Add another copy" aria-labelledby="add-${index} product-${index}">Add</button><button role="button" id="remove-${index}" aria-labelledby="remove-${index} product-${index}">Remove</button></div></article>`
                ).join('')}<a id="checkout" href="https://checkout.steampowered.com/checkout/">Continue</a></main>`,
                respond: () => ({ success: false, error: 'Isolated test: do not perform a transaction' }) });
            const { window, document } = page;
            const items = games.map((game, index) => ({ line_item_id: String(index + 1), packageid: 100 + index }));
            document.querySelector('#application_config').setAttribute('data-store_user_config', JSON.stringify({ webapi_token: token, accountcart: { cart: { line_items: items } } }));
            document.querySelector('#application_config').setAttribute('data-userinfo', JSON.stringify({ country_code: 'KR' }));
            document.cookie = 'sessionid=fixture-session';
            window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 0, width: 400, height: 50 });
            const alerts = [];
            window.alert = text => alerts.push(text);
            window.confirm = () => true;
            const wished = [];
            window.fetch = async (url, options) => {
                assert.equal(url, 'https://store.steampowered.com/api/addtowishlist');
                wished.push(options.body.get('appid'));
                return { ok: true, json: async () => ({ success: true }) };
            };
            const downloads = [];
            window.Blob = Blob;
            window.URL.createObjectURL = blob => { downloads.push(blob); return 'blob:https://store.steampowered.com/fixture'; };
            window.URL.revokeObjectURL = () => {};
            let checkouts = 0;
            document.addEventListener('click', event => {
                if (event.target.closest('a[download], #checkout')) event.preventDefault();
                if (event.target.closest('#checkout')) checkouts++;
            });
            await page.run('cart');
            await new Promise(resolve => window.requestAnimationFrame(resolve));
            const boxes = [...document.querySelectorAll('.kosteam-cart-checkbox')];
            assert.equal(boxes.length, 5);
            boxes.forEach((box, index) => { if (mask & (1 << index)) box.click(); });
            const selected = games.filter((game, index) => mask & (1 << index));
            const total = games.reduce((sum, game, index) => sum + (mask & (1 << index) ? (index + 1) * 1000 : 0), 0);
            assert.equal(document.querySelector('.kosteam-cart-total').textContent, mask ? `선택 합계: ₩ ${total.toLocaleString('en-US')}` : '선택 합계: -');
            document.querySelector('.kosteam-cart-wishlist-selected-btn').click();
            await settle();
            assert.deepEqual(wished, selected.map(game => String(game.appId)));
            document.querySelector('.kosteam-cart-json-btn').click();
            await settle();
            assert.equal(downloads.length, 1);
            const backup = JSON.parse(await downloads[0].text());
            assert.deepEqual(backup.items.map(item => item.packageId), [100, 101, 102, 103, 104]);
            document.querySelector('.kosteam-cart-buy-selected-btn').click();
            await settle();
            assert.equal(checkouts, Number(mask === 31));
            const saved = page.messages.find(message => message.type === 'SAVE_CART_RESTORE');
            if (mask > 0 && mask < 31) {
                assert.ok(saved, JSON.stringify({ alerts, messages: page.messages }));
                assert.equal(saved.items.length + saved.remainingItems.length, 5);
                assert.deepEqual(Array.from(saved.items, item => item.id), items.filter((item, index) => !(mask & (1 << index))).map(item => item.packageid));
            } else assert.equal(saved, undefined);
            assert.equal(document.querySelectorAll('article').length, 5);
        });
    }
}
