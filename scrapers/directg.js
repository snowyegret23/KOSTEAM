import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'directg.json');

const BASE_URL = 'https://www.directg.net/game/game_search_thumb.html';
const MAX_PAGES = 50;

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
            'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
        }
    });
    
    if (!response.ok) {
        console.error(`Failed to fetch page ${pageNum}: ${response.status}`);
        return [];
    }
    
    const html = await response.text();
    const $ = cheerio.load(html);
    const games = [];
    
    $('div.game-card, div.product-card, article.game-item, div[class*="game"]').each((_, el) => {
        const $card = $(el);
        
        const gameTitle = $card.find('h3, h4, .title, .game-title, .name').first().text().trim() ||
                         $card.find('a[title]').attr('title') || '';
        
        const productLink = $card.find('a').first().attr('href') || '';
        
        const priceText = $card.find('.price, .game-price, [class*="price"]').text().trim() || '';
        
        if (gameTitle && productLink) {
            games.push({
                source: 'directg',
                app_id: null,
                game_title: gameTitle,
                steam_link: '',
                patch_type: 'official',
                patch_links: [productLink.startsWith('http') ? productLink : `https://www.directg.net${productLink}`],
                description: priceText,
                directg_url: productLink.startsWith('http') ? productLink : `https://www.directg.net${productLink}`,
                last_verification_date: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });
        }
    });
    
    return games;
}

async function scrapeAll() {
    const allGames = new Map();
    
    for (let page = 1; page <= MAX_PAGES; page++) {
        try {
            const games = await scrapePage(page);
            
            if (games.length === 0) {
                console.log(`No games found on page ${page}, stopping.`);
                break;
            }
            
            for (const game of games) {
                const key = game.game_title;
                if (!allGames.has(key)) {
                    allGames.set(key, game);
                }
            }
            
            console.log(`Page ${page}: ${games.length} games`);
            
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
    console.log('Note: steam_link must be manually added for DirectG entries.');
}

main().catch(console.error);
