import * as cheerio from 'cheerio';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'directg.json');

const BASE_URL = 'https://www.directg.net/game/game_search_thumb.html';
const USER_AGENT = 'KOSTEAM-Webscraper/1.0 (+https://github.com/snowyegret23/KOSTEAM)';

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

function getProductKey(directgUrl) {
    try {
        const url = new URL(directgUrl);
        if (url.origin !== new URL(BASE_URL).origin) return '';
        const sku = url.searchParams.get('sku')?.trim();
        const platform = url.searchParams.get('platform')?.trim();
        return sku && platform ? `${sku}:${platform}` : '';
    } catch {
        return '';
    }
}

async function scrapePage(pageNum) {
    const url = `${BASE_URL}?page=${pageNum}&sort=release&exclusive_korean=Y`;
    console.log(`Fetching: ${url}`);

    const response = await fetch(url, {
        signal: AbortSignal.timeout(25000),
        headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ko-KR,ko;q=0.9',
            'Referer': 'https://www.directg.net/'
        }
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch page ${pageNum}: ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const totalCount = getTotalCount($);
    const games = [];

    $('#thumb_list div.card').each((index, el) => {
        const $card = $(el);
        const $title = $card.find('.product_name_area');
        const gameTitle = $title.text().trim();
        const productLink = $card.find('a[href]').first().attr('href') || '';
        let directgUrl;
        try {
            directgUrl = new URL(productLink, BASE_URL).href;
        } catch {
            throw new Error(`Invalid DirectG product link on page ${pageNum}, card ${index + 1}`);
        }
        if ($title.length !== 1 || !gameTitle || !getProductKey(directgUrl)) {
            throw new Error(`Invalid DirectG product on page ${pageNum}, card ${index + 1}`);
        }
        games.push({
            app_id: null,
            game_title: gameTitle,
            steam_link: '',
            patch_type: 'official',
            patch_links: ['exist'],
            patch_descriptions: [''],
            directg_url: directgUrl
        });
    });

    if (games.length === 0) throw new Error(`Empty DirectG page ${pageNum}`);
    return { games, totalCount };
}

function getTotalCount($) {
    const counts = new Set($('span').toArray().flatMap(el => {
        const match = $(el).text().trim().match(/^총\s*(\d+|\d{1,3}(?:,\d{3})+)\s*개$/);
        return match ? [Number(match[1].replaceAll(',', ''))] : [];
    }));
    const [totalCount] = counts;
    if (counts.size !== 1 || !Number.isSafeInteger(totalCount) || totalCount <= 0) {
        throw new Error('Invalid DirectG total count');
    }
    return totalCount;
}

async function scrapeAll() {
    const allGames = new Map();
    let totalCount;

    for (let page = 1; ; page++) {
        if (page > 1) await delay(3000);
        const result = await scrapePage(page);
        if (totalCount === undefined) {
            totalCount = result.totalCount;
            console.log(`Total games found: ${totalCount}`);
        } else if (result.totalCount !== totalCount) {
            throw new Error(`DirectG total changed on page ${page}: ${totalCount} -> ${result.totalCount}`);
        }

        const previousCount = allGames.size;
        for (const game of result.games) {
            const key = getProductKey(game.directg_url);
            if (!allGames.has(key)) {
                allGames.set(key, game);
            }
        }
        console.log(`Page ${page}: ${result.games.length} games (total: ${allGames.size}/${totalCount})`);
        if (allGames.size === previousCount) {
            throw new Error(`No new DirectG products on page ${page}`);
        }
        if (allGames.size > totalCount) {
            throw new Error(`DirectG count mismatch: ${allGames.size}/${totalCount}`);
        }
        if (allGames.size === totalCount) {
            return Array.from(allGames.values());
        }
    }
}

export async function main() {
    console.log('Starting directg.net scraper...');
    console.log(`User-Agent: ${USER_AGENT}`);

    await fs.mkdir(DATA_DIR, { recursive: true });

    const existingData = await loadExistingData();
    const existingMap = new Map(existingData.map(g => [getProductKey(g.directg_url) || g.game_title, g]));

    const newData = await scrapeAll();
    const merged = newData.map(game => {
        const existing = existingMap.get(getProductKey(game.directg_url)) || existingMap.get(game.game_title);
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
