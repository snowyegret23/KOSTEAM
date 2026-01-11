import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'stove.json');

const BASE_URL = 'https://api.onstove.com/store/v1.0/products/search';
const MAX_PAGES = 10;

const delay = ms => new Promise(r => setTimeout(r, ms));

async function loadExistingData() {
    try {
        const content = await fs.readFile(OUTPUT_FILE, 'utf-8');
        return JSON.parse(content);
    } catch {
        return [];
    }
}

async function scrapePage(pageNum) {
    const params = new URLSearchParams({
        q: '',
        currency_code: 'KRW',
        page: pageNum.toString(),
        size: '36',
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
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://store.onstove.com/',
                'X-LANG': 'ko',
                'X-NATION': 'KR'
            }
        });

        if (!response.ok) {
            console.error(`Failed to fetch page ${pageNum}: ${response.status}`);
            return [];
        }

        const json = await response.json();
        console.log(`API Response: code=${json.code}, message=${json.message}, contents=${json.value?.contents?.length || 0}`);

        if (json.code !== 0) {
            console.error(`API error on page ${pageNum}: ${json.message}`);
            return [];
        }

        const games = [];
        const contents = json.value?.contents || [];

        for (const item of contents) {
            const gameTitle = item.product_name || '';
            const gameNo = item.game_no;
            const productNo = item.product_no;

            if (gameTitle && productNo) {
                const stoveUrl = `https://store.onstove.com/ko/games/${productNo}`;

                games.push({
                    app_id: null,
                    stove_game_no: gameNo?.toString() || '',
                    stove_product_no: productNo.toString(),
                    game_title: gameTitle,
                    steam_link: '',
                    patch_type: 'official',
                    patch_links: ['exist'],
                    patch_descriptions: [''],
                    stove_url: stoveUrl
                });
            }
        }

        return games;
    } catch (err) {
        console.error(`Error fetching page ${pageNum}:`, err.message);
        return [];
    }
}

async function scrapeAll() {
    const allGames = new Map();
    let consecutiveEmpty = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
        try {
            const games = await scrapePage(page);

            if (games.length === 0) {
                consecutiveEmpty++;
                console.log(`No games found on page ${page}`);
                if (consecutiveEmpty >= 2) {
                    console.log('Stopping due to consecutive empty pages.');
                    break;
                }
            } else {
                consecutiveEmpty = 0;
                for (const game of games) {
                    const key = game.stove_game_no || game.game_title;
                    if (!allGames.has(key)) {
                        allGames.set(key, game);
                    }
                }
                console.log(`Page ${page}: ${games.length} games`);
            }
        } catch (err) {
            console.error(`Error on page ${page}:`, err.message);
        }
        await delay(1000);
    }

    return Array.from(allGames.values());
}

async function main() {
    console.log('Starting STOVE scraper (API mode)...');

    await fs.mkdir(DATA_DIR, { recursive: true });

    const existingData = await loadExistingData();
    const existingMap = new Map(existingData.map(g => [g.stove_game_no || g.game_title, g]));

    const newData = await scrapeAll();

    for (const game of newData) {
        const key = game.stove_game_no || game.game_title;
        const existing = existingMap.get(key);

        if (existing) {
            existingMap.set(key, {
                ...game,
                steam_link: existing.steam_link || '',
                app_id: existing.app_id || null
            });
        } else {
            existingMap.set(key, game);
        }
    }

    const merged = Array.from(existingMap.values());

    await fs.writeFile(OUTPUT_FILE, JSON.stringify(merged, null, 2), 'utf-8');
    console.log(`Saved ${merged.length} games to ${OUTPUT_FILE}`);
}

main().catch(console.error);
