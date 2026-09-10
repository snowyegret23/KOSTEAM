import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'stove.json');

const BASE_URL = 'https://api.onstove.com/store/v1.0/products/search';
const PAGE_SIZE = 36;

const delay = ms => new Promise(r => setTimeout(r, ms));

async function loadExistingData() {
    try {
        const content = await fs.readFile(OUTPUT_FILE, 'utf-8');
        return JSON.parse(content);
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
}

async function scrapePage(pageNum) {
    const params = new URLSearchParams({
        q: '',
        currency_code: 'KRW',
        page: pageNum.toString(),
        size: PAGE_SIZE.toString(),
        direction: 'LATEST',
        types: 'GAME',
        tags: '99',
        'rating.board': 'GRAC',
        on_discount: 'false'
    });

    const url = `${BASE_URL}?${params}`;
    console.log(`Fetching page ${pageNum}...`);

    try {
        const response = await fetch(url, {
            signal: AbortSignal.timeout(25000),
            headers: {
                'User-Agent': 'KOSTEAM-Webscraper/1.0 (+https://github.com/snowyegret23/KOSTEAM)',
                'Referer': 'https://store.onstove.com/',
                'X-LANG': 'ko',
                'X-NATION': 'KR'
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch page ${pageNum}: ${response.status}`);
        }

        const json = await response.json();
        console.log(`API Response: code=${json.code}, message=${json.message}, contents=${json.value?.contents?.length || 0}`);

        if (json.code !== 0 || !Array.isArray(json.value?.contents)) {
            throw new Error(`Invalid STOVE API response on page ${pageNum}`);
        }

        const value = json.value;
        const totalElements = value.total_elements;
        const totalPages = value.total_pages;
        if (!Number.isSafeInteger(totalElements) || totalElements <= 0 ||
            !Number.isSafeInteger(totalPages) || totalPages !== Math.ceil(totalElements / PAGE_SIZE) ||
            value.size !== PAGE_SIZE || value.page !== pageNum || pageNum > totalPages ||
            value.first !== (pageNum === 1) || value.last !== (pageNum === totalPages)) {
            throw new Error(`Invalid STOVE pagination on page ${pageNum}`);
        }
        const expectedCount = Math.min(PAGE_SIZE, totalElements - (pageNum - 1) * PAGE_SIZE);
        if (value.contents.length !== expectedCount) {
            throw new Error(`STOVE page count mismatch on page ${pageNum}: ${value.contents.length}/${expectedCount}`);
        }

        const games = value.contents.map((item, index) => {
            const gameTitle = typeof item?.product_name === 'string' ? item.product_name.trim() : '';
            const gameNo = item?.game_no;
            const productNo = item?.product_no;
            if (!gameTitle || !Number.isSafeInteger(gameNo) || gameNo <= 0 ||
                !Number.isSafeInteger(productNo) || productNo <= 0) {
                throw new Error(`Invalid STOVE product on page ${pageNum}, item ${index + 1}`);
            }
            return {
                app_id: null,
                stove_game_no: gameNo.toString(),
                stove_product_no: productNo.toString(),
                game_title: gameTitle,
                steam_link: '',
                patch_type: 'official',
                patch_links: ['exist'],
                patch_descriptions: [''],
                stove_url: `https://store.onstove.com/ko/games/${productNo}`
            };
        });

        return { games, totalElements, totalPages };
    } catch (err) {
        throw new Error(`Error fetching page ${pageNum}: ${err.message}`);
    }
}

async function scrapeAll() {
    const allGames = new Map();
    let totalElements;
    let totalPages = 1;

    for (let page = 1; page <= totalPages; page++) {
        if (page > 1) await delay(1000);
        const result = await scrapePage(page);
        if (totalElements === undefined) {
            totalElements = result.totalElements;
            totalPages = result.totalPages;
        } else if (result.totalElements !== totalElements || result.totalPages !== totalPages) {
            throw new Error(`STOVE totals changed on page ${page}`);
        }

        for (const game of result.games) {
            const key = game.stove_product_no;
            if (allGames.has(key)) {
                throw new Error(`Duplicate STOVE product ${key} on page ${page}`);
            }
            allGames.set(key, game);
        }
        console.log(`Page ${page}/${totalPages}: ${result.games.length} products (total: ${allGames.size}/${totalElements})`);
    }

    if (allGames.size !== totalElements) {
        throw new Error(`STOVE count mismatch: ${allGames.size}/${totalElements}`);
    }
    return Array.from(allGames.values());
}

export async function main() {
    console.log('Starting STOVE scraper (API mode)...');

    await fs.mkdir(DATA_DIR, { recursive: true });

    const existingData = await loadExistingData();
    const existingByProduct = new Map(existingData.filter(g => g.stove_product_no)
        .map(g => [String(g.stove_product_no), g]));
    const existingByGame = new Map(existingData.map(g => [String(g.stove_game_no || g.game_title), g]));

    const newData = await scrapeAll();
    const merged = newData.map(game => {
        const existing = existingByProduct.get(game.stove_product_no) ||
            existingByGame.get(game.stove_game_no) || existingByGame.get(game.game_title);
        return {
            ...game,
            steam_link: existing?.steam_link || '',
            app_id: existing?.app_id || null
        };
    });

    await fs.writeFile(OUTPUT_FILE, JSON.stringify(merged, null, 2), 'utf-8');
    console.log(`Saved ${merged.length} games to ${OUTPUT_FILE}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(err => { console.error(err); process.exitCode = 1; });
}
