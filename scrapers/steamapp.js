import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'steamapp.json');

const BASE_URL = 'https://steamapp.net';
const SECTIONS = ['_', '0', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z'];

const delay = ms => new Promise(r => setTimeout(r, ms));

async function loadExistingData() {
    try {
        const content = await fs.readFile(OUTPUT_FILE, 'utf-8');
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

function removeUrls(text) {
    if (!text) return '';
    // Remove URLs (http://, https://, www.)
    return text.replace(/https?:\/\/[^\s]+/g, '').replace(/www\.[^\s]+/g, '').replace(/\s+/g, ' ').trim();
}

async function scrapeSection(section) {
    const url = `${BASE_URL}/hangul/${section}`;
    console.log(`Fetching: ${url}`);

    const response = await fetch(url, {
        headers: {
            'User-Agent': 'KOSTEAM-Webscraper/1.0 (+https://github.com/snowyegret23/KOSTEAM)'
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
        const patchDescriptions = [];

        $app.find('div._app_hangul_patch').each((_, patchEl) => {
            const $patch = $(patchEl);
            const $linkAnchor = $patch.find('a._app_hangul_patch_url');

            const anchorText = $linkAnchor.text().trim();
            let directUrl = '';

            const httpIdx = anchorText.indexOf('http');
            if (httpIdx !== -1) {
                directUrl = anchorText.substring(httpIdx).trim();
            } else {
                const patchUrl = $linkAnchor.attr('href') || '';
                if (patchUrl && patchUrl !== '/') {
                    directUrl = patchUrl.startsWith('http') ? patchUrl : `${BASE_URL}${patchUrl}`;
                }
            }

            if (directUrl && directUrl !== BASE_URL && directUrl !== `${BASE_URL}/`) {
                patchLinks.push('exist');
                const comment = $patch.find('p._app_hangul_patch_comment').text().trim();
                const cleanComment = comment.replace(/^.*?<i class="xi-tags"><\/i>\s*/, '').trim();
                patchDescriptions.push(removeUrls(cleanComment) || '');
            }
        });

        if (gameTitle && steamLink) {
            games.push({
                app_id: appId,
                game_title: gameTitle,
                steam_link: steamLink,
                source_site_url: `${BASE_URL}/app/${appId || ''}`,
                patch_type: patchType,
                patch_links: patchLinks,
                patch_descriptions: patchDescriptions
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
