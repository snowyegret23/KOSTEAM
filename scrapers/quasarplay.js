import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'quasarplay.json');

const BASE_URL = 'https://quasarplay.com/bbs/qp_korean';
const MAX_PAGES = 100;

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

async function scrapePage(pageNum) {
    const url = `${BASE_URL}?page=${pageNum}`;
    console.log(`Fetching: ${url}`);
    
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1'
        }
    });
    
    if (!response.ok) {
        console.error(`Failed to fetch page ${pageNum}: ${response.status}`);
        return [];
    }
    
    const html = await response.text();
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
}

async function scrapeAll(existingMap) {
    const allGames = new Map();
    let consecutiveDuplicates = 0;
    const DUPLICATE_THRESHOLD = 3;
    
    for (let page = 1; page <= MAX_PAGES; page++) {
        try {
            const games = await scrapePage(page);
            
            if (games.length === 0) {
                console.log(`No games found on page ${page}, stopping.`);
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
            
            console.log(`Page ${page}: ${games.length} games (${newGamesOnPage} new)`);
            
            if (newGamesOnPage === 0) {
                consecutiveDuplicates++;
                if (consecutiveDuplicates >= DUPLICATE_THRESHOLD) {
                    console.log(`${DUPLICATE_THRESHOLD} consecutive pages with no new games, stopping.`);
                    break;
                }
            } else {
                consecutiveDuplicates = 0;
            }
            
        } catch (err) {
            console.error(`Error on page ${page}:`, err.message);
        }
        await delay(1000);
    }
    
    return Array.from(allGames.values());
}

async function main() {
    console.log('Starting quasarplay.com scraper...');
    
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
