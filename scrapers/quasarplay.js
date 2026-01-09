import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'quasarplay.json');

const BASE_URL = 'https://quasarplay.com/bbs/qp_korean';
const MAX_PAGES = 100;

puppeteer.use(StealthPlugin());

const delay = ms => new Promise(r => setTimeout(r, ms));

async function loadExistingData() {
    try {
        const content = await fs.readFile(OUTPUT_FILE, 'utf-8');
        return JSON.parse(content);
    } catch {
        return [];
    }
}

function extractSteamAppId(onclickAttr) {
    if (!onclickAttr) return null;
    const match = onclickAttr.match(/store\.steampowered\.com\/app\/(\d+)/);
    return match ? match[1] : null;
}

async function scrapePage(page, pageNum) {
    const url = `${BASE_URL}?page=${pageNum}`;
    console.log(`Fetching: ${url}`);

    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        const title = await page.title();
        console.log(`Page Title: ${title}`);

        // Wait for the table to appear, or check for no results
        try {
            await page.waitForSelector('table tbody tr.item', { timeout: 10000 });
        } catch (e) {
            console.log(`No games found on page ${pageNum} (selector timeout).`);
            console.log('Taking debug screenshot...');
            await page.screenshot({ path: path.join(DATA_DIR, 'debug_screenshot.png') });
            await fs.writeFile(path.join(DATA_DIR, 'debug_page.html'), await page.content());
            console.log(`Saved debug info to ${DATA_DIR}`);
            return [];
        }

        const html = await page.content();
        const $ = cheerio.load(html);
        const games = [];

        $('table tbody tr.item').each((_, el) => {
            const $row = $(el);

            const typeText = $row.find('td.type_area span.type').text().trim();
            const patchType = typeText.includes('유저') ? 'user' : 'official';

            const $details = $row.find('td.details-control');

            const $thumbnail = $details.find('.thumbnail_wrapper');
            const onclickAttr = $thumbnail.attr('onclick') || '';
            const steamAppId = extractSteamAppId(onclickAttr);

            const gameTitle = $details.find('p.title').text().trim() || '';

            const $downloadLink = $details.find('p.download_link a.forward');
            const patchLink = $downloadLink.attr('href') || '';

            const producerSpans = $details.find('p.producer span').not('.colorGray3');
            const producer = producerSpans.text().trim() || '';

            const steamLink = steamAppId ? `https://store.steampowered.com/app/${steamAppId}` : '';

            if (gameTitle) {
                games.push({
                    source: 'quasarplay',
                    app_id: steamAppId,
                    game_title: gameTitle,
                    steam_link: steamLink,
                    patch_type: patchType,
                    patch_links: patchLink ? [patchLink] : [],
                    description: producer ? `제작자: ${producer}` : '',
                    updated_at: new Date().toISOString()
                });
            }
        });

        return games;
    } catch (err) {
        console.error(`Error scraping page ${pageNum}:`, err.message);
        return [];
    }
}

async function scrapeAll(existingMap) {
    const allGames = new Map();
    let consecutiveDuplicates = 0;
    const DUPLICATE_THRESHOLD = 3;

    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    // Set a realistic viewport
    await page.setViewport({ width: 1920, height: 1080 });

    try {
        for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
            const games = await scrapePage(page, pageNum);

            if (games.length === 0) {
                console.log(`No games found on page ${pageNum}, stopping.`);
                break;
            }

            let newGamesOnPage = 0;
            for (const game of games) {
                const key = game.app_id || game.game_title;
                if (!allGames.has(key) && !existingMap.has(key)) {
                    allGames.set(key, game);
                    newGamesOnPage++;
                } else if (!allGames.has(key)) {
                    allGames.set(key, game);
                }
            }

            console.log(`Page ${pageNum}: ${games.length} games (${newGamesOnPage} new)`);

            if (newGamesOnPage === 0) {
                consecutiveDuplicates++;
                if (consecutiveDuplicates >= DUPLICATE_THRESHOLD) {
                    console.log(`${DUPLICATE_THRESHOLD} consecutive pages with no new games, stopping.`);
                    break;
                }
            } else {
                consecutiveDuplicates = 0;
            }

            // Random delay between 1-3 seconds to behave like a human
            await delay(1000 + Math.random() * 2000);
        }
    } finally {
        await browser.close();
    }

    return Array.from(allGames.values());
}

async function main() {
    console.log('Starting quasarplay.com scraper (Puppeteer)...');

    await fs.mkdir(DATA_DIR, { recursive: true });

    const existingData = await loadExistingData();
    const existingMap = new Map(existingData.map(g => [g.app_id || g.game_title, g]));

    const newData = await scrapeAll(existingMap);

    for (const game of newData) {
        const key = game.app_id || game.game_title;
        existingMap.set(key, game);
    }

    const merged = Array.from(existingMap.values());

    await fs.writeFile(OUTPUT_FILE, JSON.stringify(merged, null, 2), 'utf-8');
    console.log(`Saved ${merged.length} games to ${OUTPUT_FILE}`);
}

main().catch(console.error);
