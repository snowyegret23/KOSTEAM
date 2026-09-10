import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { main } from '../scrapers/directg.js';

function productUrl(sku, platform = '1') {
    return `https://www.directg.net/game/dlc_view.html?sku=${sku}&platform=${platform}`;
}

function card(sku, title = `Game ${sku}`, platform = '1') {
    return `<div class="card rounded-0">
        <a href="/game/dlc_view.html?sku=${sku}&amp;platform=${platform}">
            <div class="thumb-area"><img class="card-img-top" alt="${title}"></div>
        </a>
        <div class="content-area"><div class="title-area">
            <div class="product_name_area">${title}</div>
        </div></div>
    </div>`;
}

function page(total, cards) {
    return `<span> 총 <strong>${total}</strong>개</span><div id="thumb_list">${cards.join('')}</div>`;
}

function setup(t, pages, existing = []) {
    const requested = [];
    const writes = [];
    t.mock.method(console, 'log', () => {});
    t.mock.method(globalThis, 'setTimeout', callback => callback());
    t.mock.method(fs, 'mkdir', async () => {});
    t.mock.method(fs, 'readFile', async () => JSON.stringify(existing));
    t.mock.method(fs, 'writeFile', async (file, content) => writes.push(JSON.parse(content)));
    t.mock.method(globalThis, 'fetch', async url => {
        const parsed = new URL(url);
        assert.equal(parsed.origin, 'https://www.directg.net');
        assert.equal(parsed.pathname, '/game/game_search_thumb.html');
        assert.equal(parsed.searchParams.get('exclusive_korean'), 'Y');
        const number = Number(parsed.searchParams.get('page'));
        requested.push(number);
        const response = pages[number - 1];
        assert.notEqual(response, undefined, `Unexpected page ${number}`);
        if (response instanceof Error) throw response;
        return response instanceof Response ? response : new Response(response);
    });
    return { requested, writes };
}

test('DirectG reads every page until the advertised number of unique products is collected', async t => {
    const { requested, writes } = setup(t, [
        page(6, [card('a'), card('b')]),
        page(6, [card('c'), card('d')]),
        page(6, [card('e'), card('f')])
    ]);
    await main();
    assert.deepEqual(requested, [1, 2, 3]);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].length, 6);
    assert.deepEqual(writes[0][0], {
        app_id: null, game_title: 'Game a', steam_link: '',
        patch_type: 'official', patch_links: ['exist'], patch_descriptions: [''],
        directg_url: productUrl('a')
    });
});

test('DirectG replaces the old list and preserves Steam mappings across title and URL changes', async t => {
    const { writes } = setup(t, [page(1, [card('a', 'Renamed game')])], [
        { game_title: 'Old name', directg_url: 'https://www.directg.net/game/game_view.html?platform=1&product_id=old&sku=a', app_id: '42', steam_link: 'https://store.steampowered.com/app/42' },
        { game_title: 'Removed game', directg_url: productUrl('removed'), app_id: '99', steam_link: 'https://store.steampowered.com/app/99' }
    ]);
    await main();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].length, 1);
    assert.equal(writes[0][0].game_title, 'Renamed game');
    assert.equal(writes[0][0].directg_url, productUrl('a'));
    assert.equal(writes[0][0].app_id, '42');
    assert.equal(writes[0][0].steam_link, 'https://store.steampowered.com/app/42');
});

test('DirectG counts overlapping products only once while later pages make progress', async t => {
    const { writes } = setup(t, [page(3, [card('a'), card('b')]), page(3, [card('b'), card('c')])]);
    await main();
    assert.equal(writes[0].length, 3);
    assert.deepEqual(writes[0].map(g => g.directg_url), ['a', 'b', 'c'].map(sku => productUrl(sku)));
});

test('DirectG distinguishes products with the same title and SKUs on different platforms', async t => {
    const existing = [['a', '1', '42'], ['b', '1', '43'], ['a', '2', '44']].map(([sku, platform, appId]) => ({
        game_title: 'Same title', directg_url: productUrl(sku, platform),
        app_id: appId, steam_link: `https://store.steampowered.com/app/${appId}`
    }));
    const { writes } = setup(t, [page(3, [card('a', 'Same title'), card('b', 'Same title'), card('a', 'Same title', '2')])], existing);
    await main();
    assert.deepEqual(writes[0].map(g => g.app_id), ['42', '43', '44']);
    assert.deepEqual(writes[0].map(g => g.steam_link), existing.map(g => g.steam_link));
});

test('DirectG uses title fallback only for existing entries without a product identity', async t => {
    const { writes } = setup(t, [page(2, [card('new', 'Legacy game'), card('b', 'Same title')])], [
        { game_title: 'Legacy game', app_id: '42', steam_link: 'https://store.steampowered.com/app/42' },
        { game_title: 'Same title', directg_url: productUrl('a'), app_id: '43', steam_link: 'https://store.steampowered.com/app/43' }
    ]);
    await main();
    assert.equal(writes[0][0].app_id, '42');
    assert.equal(writes[0][0].steam_link, 'https://store.steampowered.com/app/42');
    assert.equal(writes[0][1].app_id, null);
    assert.equal(writes[0][1].steam_link, '');
});

test('DirectG never saves incomplete or invalid collection results', async t => {
    const cases = [
        ['empty first page', [page(1, [])], /Empty DirectG page/],
        ['missing total', [page('unknown', [card('a')])], /Invalid DirectG total/],
        ['conflicting total counters', [page(1, [card('a')]) + '<span>총 2개</span>'], /Invalid DirectG total/],
        ['zero total', [page(0, [card('a')])], /Invalid DirectG total/],
        ['too many products', [page(1, [card('a'), card('b')])], /DirectG count mismatch/],
        ['empty later page', [page(3, [card('a'), card('b')]), page(3, [])], /Empty DirectG page/],
        ['repeated page', [page(3, [card('a'), card('b')]), page(3, [card('a'), card('b')])], /No new DirectG products/],
        ['duplicate cards do not fill the count', [page(2, [card('a'), card('a')]), page(2, [card('a')])], /No new DirectG products/],
        ['total changes during collection', [page(3, [card('a')]), page(2, [card('b')])], /DirectG total changed/],
        ['missing title on first page', [page(2, [card('a'), card('b', '')])], /Invalid DirectG product/],
        ['missing title on later page', [page(3, [card('a')]), page(3, [card('b'), card('c', '')])], /Invalid DirectG product/],
        ['missing link', [page(2, [card('a'), '<div class="card"><div class="product_name_area">Game b</div></div>'])], /Invalid DirectG product/],
        ['missing SKU', [page(1, [card('')])], /Invalid DirectG product/],
        ['missing platform', [page(1, [card('a', 'Game a', '')])], /Invalid DirectG product/],
        ['untrusted product link', [page(1, [card('a').replace('/game/dlc_view.html', 'https://example.com/game/dlc_view.html')])], /Invalid DirectG product/],
        ['first request fails', [new Response('Unavailable', { status: 503 })], /Failed to fetch page 1: 503/],
        ['later request fails', [page(2, [card('a')]), new Response('Unavailable', { status: 503 })], /Failed to fetch page 2: 503/],
        ['later request times out', [page(2, [card('a')]), new Error('Simulated timeout')], /Simulated timeout/]
    ];
    for (const [name, pages, error] of cases) {
        await t.test(name, async t => {
            const { writes } = setup(t, pages, [{ game_title: 'Keep existing', app_id: '42' }]);
            await assert.rejects(main(), error);
            assert.equal(writes.length, 0);
        });
    }
});
