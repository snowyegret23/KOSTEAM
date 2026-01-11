import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'directg.json');

const BASE_URL = 'https://www.directg.net/game/game_search_thumb.html';
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
    const url = `${BASE_URL}?page=${pageNum}&sort=release&exclusive_korean=Y`;
    console.log(`Fetching: ${url}`);

    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
            'Referer': 'https://www.directg.net/'
        }
    });

    if (!response.ok) {
        console.error(`Failed to fetch page ${pageNum}: ${response.status}`);
        return [];
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const games = [];

    $('#thumb_list div.card').each((_, el) => {
        const $card = $(el);

        const $titleLink = $card.find('.card-header a');
        const gameTitle = $titleLink.find('h5.card-title').text().trim() || '';
        const productLink = $titleLink.attr('href') || '';

        if (gameTitle && productLink) {
            const directgUrl = productLink.startsWith('http') ? productLink : `https://www.directg.net${productLink}`;

            games.push({
                app_id: null,
                game_title: gameTitle,
                steam_link: '',
                patch_type: 'official',
                patch_links: directgUrl ? [directgUrl] : [],
                patch_descriptions: [''],
                directg_url: directgUrl
            });
        }
    });

    return games;
}

async function getTotalCount(html) {
    const $ = cheerio.load(html);
    const countText = $('span:contains("총")').text();
    const match = countText.match(/총\s*(\d+)\s*개/);
    return match ? parseInt(match[1], 10) : 0;
}

async function scrapeAll() {
    const allGames = new Map();

    const firstResponse = await fetch(`${BASE_URL}?page=1&sort=release&exclusive_korean=Y`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ko-KR,ko;q=0.9',
            'Referer': 'https://www.directg.net/'
        }
    });
    const firstHtml = await firstResponse.text();
    const totalCount = await getTotalCount(firstHtml);
    console.log(`Total games found: ${totalCount}`);

    const $ = cheerio.load(firstHtml);
    $('#thumb_list div.card').each((_, el) => {
        const $card = $(el);
        const $titleLink = $card.find('.card-header a');
        const gameTitle = $titleLink.find('h5.card-title').text().trim() || '';
        const productLink = $titleLink.attr('href') || '';

        if (gameTitle && productLink) {
            const fullUrl = productLink.startsWith('http') ? productLink : `https://www.directg.net${productLink}`;
            allGames.set(gameTitle, {
                app_id: null,
                game_title: gameTitle,
                steam_link: '',
                patch_type: 'official',
                patch_links: [fullUrl],
                patch_descriptions: [''],
                directg_url: fullUrl
            });
        }
    });

    console.log(`Page 1: ${allGames.size} games`);

    const gamesPerPage = 20;
    const totalPages = Math.ceil(totalCount / gamesPerPage);
    const pagesToFetch = Math.min(totalPages, MAX_PAGES);

    for (let page = 2; page <= pagesToFetch; page++) {
        try {
            const games = await scrapePage(page);

            if (games.length === 0) {
                console.log(`No games found on page ${page}, stopping.`);
                break;
            }

            for (const game of games) {
                if (!allGames.has(game.game_title)) {
                    allGames.set(game.game_title, game);
                }
            }

            console.log(`Page ${page}: ${games.length} games (total: ${allGames.size})`);
        } catch (err) {
            console.error(`Error on page ${page}:`, err.message);
        }
        await delay(800);
    }

    return Array.from(allGames.values());
}

async function main() {
    console.log('Starting directg.net scraper...');

    await fs.mkdir(DATA_DIR, { recursive: true });

    const existingData = await loadExistingData();
    const existingMap = new Map(existingData.map(g => [g.game_title, g]));

    const newData = await scrapeAll();

    for (const game of newData) {
        const key = game.game_title;
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
