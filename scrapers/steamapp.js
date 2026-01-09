import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'steamapp.json');
const EXISTING_FILE = OUTPUT_FILE;

const BASE_URL = 'https://steamapp.net';
const SECTIONS = ['_', '0', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z'];

const delay = ms => new Promise(r => setTimeout(r, ms));

async function loadExistingData() {
    try {
        const content = await fs.readFile(EXISTING_FILE, 'utf-8');
        return JSON.parse(content);
    } catch {
        return [];
    }
}

function extractAppId(steamLink) {
    if (!steamLink) return null;
    const match = steamLink.match(/\/app\/(\d+)/);
    return match ? match[1] : null;
}

function parseDescription(commentText) {
    if (!commentText) return '';
    const lines = commentText.split('\n').map(l => l.trim()).filter(Boolean);
    return lines[0] || '';
}

async function scrapeSection(section) {
    const url = `${BASE_URL}/hangul/${section}`;
    console.log(`Fetching: ${url}`);
    
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
    });
    
    if (!response.ok) {
        console.error(`Failed to fetch section ${section}: ${response.status}`);
        return [];
    }
    
    const html = await response.text();
    const $ = cheerio.load(html);
    const games = [];
    
    $('div.app').each((_, el) => {
        const $app = $(el);
        
        const nameEl = $app.find('a._app_name');
        const gameTitle = nameEl.attr('title') || nameEl.text().trim() || '';
        
        const steamLink = $app.find('a._app_header_image_link').attr('href') || '';
        const appId = extractAppId(steamLink);
        
        const typeEl = $app.find('em._app_hangul_USER, em._app_hangul_PUBLIC');
        const patchType = typeEl.hasClass('_app_hangul_USER') ? 'user' : 'official';
        
        const patchLinks = [];
        const descriptions = [];
        
        $app.find('div._app_hangul_patch').each((_, patchEl) => {
            const $patch = $(patchEl);
            const patchUrl = $patch.find('a._app_hangul_patch_url').attr('href') || '';
            if (patchUrl) patchLinks.push(patchUrl);
            
            const comment = $patch.find('p._app_hangul_patch_comment').text() || '';
            const desc = parseDescription(comment);
            if (desc) descriptions.push(desc);
        });
        
        if (gameTitle && steamLink) {
            games.push({
                source: 'steamapp',
                app_id: appId,
                game_title: gameTitle,
                steam_link: steamLink,
                patch_type: patchType,
                patch_links: patchLinks,
                description: descriptions.join(' | '),
                updated_at: new Date().toISOString()
            });
        }
    });
    
    return games;
}

async function scrapeAll() {
    const allGames = new Map();
    const failedSections = [];
    
    for (const section of SECTIONS) {
        try {
            const games = await scrapeSection(section);
            for (const game of games) {
                const key = game.app_id || game.steam_link;
                if (!allGames.has(key)) {
                    allGames.set(key, game);
                }
            }
            console.log(`Section ${section}: ${games.length} games`);
        } catch (err) {
            console.error(`Error in section ${section}:`, err.message);
            failedSections.push(section);
        }
        await delay(500);
    }
    
    const result = Array.from(allGames.values());
    console.log(`Total: ${result.length} games`);
    if (failedSections.length) {
        console.log(`Failed sections: ${failedSections.join(', ')}`);
    }
    
    return result;
}

async function main() {
    console.log('Starting steamapp.net scraper...');
    
    await fs.mkdir(DATA_DIR, { recursive: true });
    
    const existingData = await loadExistingData();
    const existingMap = new Map(existingData.map(g => [g.app_id || g.steam_link, g]));
    
    const newData = await scrapeAll();
    
    for (const game of newData) {
        const key = game.app_id || game.steam_link;
        existingMap.set(key, game);
    }
    
    const merged = Array.from(existingMap.values());
    
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(merged, null, 2), 'utf-8');
    console.log(`Saved ${merged.length} games to ${OUTPUT_FILE}`);
}

main().catch(console.error);
