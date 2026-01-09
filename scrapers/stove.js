import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'stove.json');

const BASE_URL = 'https://store.onstove.com/ko/store/search';
const MAX_PAGES = 30;

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
    const url = `${BASE_URL}?direction=LATEST&features=99&page=${pageNum}`;
    console.log(`Fetching: ${url}`);
    
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ko-KR,ko;q=0.9'
        }
    });
    
    if (!response.ok) {
        console.error(`Failed to fetch page ${pageNum}: ${response.status}`);
        return [];
    }
    
    const html = await response.text();
    const games = [];
    
    const nuxtMatch = html.match(/window\.__NUXT__=\(function\([^)]+\)\{[^}]*return\s*(\{[\s\S]*?\})\}\([^)]+\)\)/);
    
    if (!nuxtMatch) {
        console.log(`No NUXT data found on page ${pageNum}`);
        return games;
    }
    
    try {
        const $ = cheerio.load(html);
        
        $('a[href*="/ko/games/"]').each((_, el) => {
            const $link = $(el);
            const href = $link.attr('href') || '';
            const gameNoMatch = href.match(/\/games\/(\d+)/);
            
            if (gameNoMatch) {
                const gameNo = gameNoMatch[1];
                const gameTitle = $link.find('span, p, div').first().text().trim() ||
                                 $link.text().trim() || '';
                
                if (gameTitle && !gameTitle.includes('할인') && !gameTitle.includes('%')) {
                    games.push({
                        source: 'stove',
                        app_id: null,
                        stove_game_no: gameNo,
                        game_title: gameTitle,
                        steam_link: '',
                        patch_type: 'official',
                        patch_links: [`https://store.onstove.com/ko/games/${gameNo}`],
                        description: '스토브 한글화',
                        stove_url: `https://store.onstove.com/ko/games/${gameNo}`,
                        last_verification_date: new Date().toISOString(),
                        updated_at: new Date().toISOString()
                    });
                }
            }
        });
        
    } catch (err) {
        console.error(`Error parsing page ${pageNum}:`, err.message);
    }
    
    return games;
}

async function scrapeGameList() {
    const allGames = new Map();
    
    for (let page = 1; page <= MAX_PAGES; page++) {
        try {
            const games = await scrapePage(page);
            
            if (games.length === 0 && page > 1) {
                console.log(`No games found on page ${page}, stopping.`);
                break;
            }
            
            for (const game of games) {
                const key = game.stove_game_no || game.game_title;
                if (!allGames.has(key)) {
                    allGames.set(key, game);
                }
            }
            
            console.log(`Page ${page}: ${games.length} games found`);
            
        } catch (err) {
            console.error(`Error on page ${page}:`, err.message);
        }
        await delay(1000);
    }
    
    return Array.from(allGames.values());
}

async function main() {
    console.log('Starting STOVE scraper...');
    console.log('Note: STOVE uses SPA, scraping may be limited.');
    
    await fs.mkdir(DATA_DIR, { recursive: true });
    
    const existingData = await loadExistingData();
    const existingMap = new Map(existingData.map(g => [g.stove_game_no || g.game_title, g]));
    
    const newData = await scrapeGameList();
    
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
    console.log('Note: steam_link must be manually added for STOVE entries.');
}

main().catch(console.error);
