import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { main } from '../scrapers/stove.js';

function product(id, overrides = {}) {
    return { product_name: `Game ${id}`, game_no: id, product_no: 10000 + id, ...overrides };
}

function page(total, number = 1, overrides = {}) {
    const size = 36;
    const totalPages = Math.ceil(total / size);
    const offset = (number - 1) * size;
    return {
        code: 0, message: 'OK',
        value: {
            total_elements: total, total_pages: totalPages, page: number, size,
            first: number === 1, last: number === totalPages,
            contents: Array.from({ length: Math.max(0, Math.min(size, total - offset)) }, (_, i) => product(offset + i + 1)),
            ...overrides
        }
    };
}

function setup(t, pages, existing = []) {
    const requested = [];
    const writes = [];
    t.mock.method(console, 'log', () => {});
    t.mock.method(globalThis, 'setTimeout', callback => callback());
    t.mock.method(fs, 'mkdir', async () => {});
    t.mock.method(fs, 'readFile', async () => JSON.stringify(existing));
    t.mock.method(fs, 'writeFile', async (file, text) => writes.push(JSON.parse(text)));
    t.mock.method(globalThis, 'fetch', async url => {
        const parsed = new URL(url);
        assert.equal(parsed.origin, 'https://api.onstove.com');
        assert.equal(parsed.pathname, '/store/v1.0/products/search');
        assert.equal(parsed.searchParams.get('tags'), '99');
        assert.equal(parsed.searchParams.get('types'), 'GAME');
        assert.equal(parsed.searchParams.get('size'), '36');
        const number = Number(parsed.searchParams.get('page'));
        requested.push(number);
        const response = pages[number - 1];
        assert.notEqual(response, undefined, `Unexpected page ${number}`);
        if (response instanceof Error) throw response;
        return response instanceof Response ? response : Response.json(response);
    });
    return { requested, writes };
}

test('STOVE reads all advertised pages beyond the old ten-page limit', async t => {
    const { requested, writes } = setup(t, Array.from({ length: 11 }, (_, i) => page(361, i + 1)));
    await main();
    assert.deepEqual(requested, Array.from({ length: 11 }, (_, i) => i + 1));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].length, 361);
    assert.equal(new Set(writes[0].map(g => g.stove_product_no)).size, 361);
    assert.deepEqual(writes[0][0], {
        app_id: null, stove_game_no: '1', stove_product_no: '10001', game_title: 'Game 1',
        steam_link: '', patch_type: 'official', patch_links: ['exist'], patch_descriptions: [''],
        stove_url: 'https://store.onstove.com/ko/games/10001'
    });
});

test('STOVE replaces old entries and keeps Steam mappings when titles or product numbers change', async t => {
    const { requested, writes } = setup(t, [page(2, 1, {
        contents: [product(1), product(2, { product_no: 90002 })]
    })], [
        { stove_game_no: '1', stove_product_no: '10001', game_title: 'Old title', app_id: '42', steam_link: 'https://store.steampowered.com/app/42' },
        { stove_game_no: '2', stove_product_no: '10002', game_title: 'Old second title', app_id: '43', steam_link: 'https://store.steampowered.com/app/43' },
        { stove_game_no: '3', stove_product_no: '10003', game_title: 'Removed', app_id: '44' }
    ]);
    await main();
    assert.deepEqual(requested, [1]);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].length, 2);
    assert.deepEqual(writes[0].map(g => g.app_id), ['42', '43']);
    assert.deepEqual(writes[0].map(g => g.steam_link), ['https://store.steampowered.com/app/42', 'https://store.steampowered.com/app/43']);
    assert.equal(writes[0][0].game_title, 'Game 1');
    assert.equal(writes[0][1].stove_url, 'https://store.onstove.com/ko/games/90002');
});

test('STOVE counts distinct products sharing a game number and prefers each product mapping', async t => {
    const { writes } = setup(t, [page(2, 1, {
        contents: [product(1), product(1, { product_no: 10002 })]
    })], [
        { stove_game_no: '1', stove_product_no: '10001', game_title: 'Same name', app_id: '42' },
        { stove_game_no: '1', stove_product_no: '10002', game_title: 'Same name', app_id: '43' }
    ]);
    await main();
    assert.deepEqual(writes[0].map(g => g.app_id), ['42', '43']);
    assert.deepEqual(writes[0].map(g => g.stove_product_no), ['10001', '10002']);
});

test('STOVE uses title fallback only for existing entries without game numbers', async t => {
    const { writes } = setup(t, [page(2)], [
        { game_title: 'Game 1', app_id: '42', steam_link: 'https://store.steampowered.com/app/42' },
        { stove_game_no: '99', stove_product_no: '10099', game_title: 'Game 2', app_id: '43' }
    ]);
    await main();
    assert.equal(writes[0][0].app_id, '42');
    assert.equal(writes[0][0].steam_link, 'https://store.steampowered.com/app/42');
    assert.equal(writes[0][1].app_id, null);
});

test('STOVE rejects incomplete API results before writing the data file', async t => {
    const cases = [
        ['API error', [{ code: 1, value: { contents: [] } }], /Invalid STOVE API response/],
        ['missing contents', [page(1, 1, { contents: null })], /Invalid STOVE API response/],
        ['missing total', [page(1, 1, { total_elements: undefined })], /Invalid STOVE pagination/],
        ['zero total', [page(0)], /Invalid STOVE pagination/],
        ['fractional total', [page(1, 1, { total_elements: 1.5 })], /Invalid STOVE pagination/],
        ['inconsistent page count', [page(1, 1, { total_pages: 2 })], /Invalid STOVE pagination/],
        ['wrong page number', [page(1, 1, { page: 2 })], /Invalid STOVE pagination/],
        ['wrong page size', [page(1, 1, { size: 10 })], /Invalid STOVE pagination/],
        ['wrong first flag', [page(1, 1, { first: false })], /Invalid STOVE pagination/],
        ['wrong last flag', [page(1, 1, { last: false })], /Invalid STOVE pagination/],
        ['empty first page', [page(1, 1, { contents: [] })], /STOVE page count mismatch/],
        ['empty middle page', [page(73), page(73, 2, { contents: [] })], /STOVE page count mismatch/],
        ['truncated last page', [page(38), page(38, 2, { contents: [product(37)] })], /STOVE page count mismatch/],
        ['excess products', [page(1, 1, { contents: [product(1), product(2)] })], /STOVE page count mismatch/],
        ['total changes between pages', [page(37), page(38, 2)], /STOVE totals changed/],
        ['duplicate products', [page(2, 1, { contents: [product(1), product(1)] })], /Duplicate STOVE product/],
        ['repeated page', [page(72), page(72, 2, { contents: page(72).value.contents })], /Duplicate STOVE product/],
        ['null item', [page(1, 1, { contents: [null] })], /Invalid STOVE product/],
        ['missing title', [page(1, 1, { contents: [product(1, { product_name: ' ' })] })], /Invalid STOVE product/],
        ['missing product number', [page(1, 1, { contents: [product(1, { product_no: undefined })] })], /Invalid STOVE product/],
        ['missing game number', [page(1, 1, { contents: [product(1, { game_no: undefined })] })], /Invalid STOVE product/],
        ['invalid product number', [page(1, 1, { contents: [product(1, { product_no: 0 })] })], /Invalid STOVE product/],
        ['later malformed product', [page(37), page(37, 2, { contents: [product(37, { product_name: '' })] })], /Invalid STOVE product/],
        ['HTTP error', [new Response('Unavailable', { status: 503 })], /503/],
        ['invalid JSON', [new Response('<html>Error</html>')], /JSON/],
        ['later network error', [page(37), new Error('Simulated timeout')], /Simulated timeout/]
    ];
    for (const [name, pages, error] of cases) {
        await t.test(name, async t => {
            const { writes } = setup(t, pages, [{ stove_game_no: '1', app_id: '42' }]);
            await assert.rejects(main(), error);
            assert.equal(writes.length, 0);
        });
    }
});
