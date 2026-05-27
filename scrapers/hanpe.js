import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'steamapp.json');

const API_URL = 'https://hanpe.net/api/hanguls';
const VERSION_FILE = path.join(DATA_DIR, 'version.json');

async function getStoredLastModified() {
    try {
        const version = JSON.parse(await fs.readFile(VERSION_FILE, 'utf-8'));
        return version.hanpe_last_modified || null;
    } catch {
        return null;
    }
}

function removeUrls(text) {
    if (!text) return '';
    return text.replace(/https?:\/\/[^\s]+/g, '').replace(/www\.[^\s]+/g, '').replace(/\s+/g, ' ').trim();
}

function convertEntry(entry) {
    const appId = String(entry.appid);
    const patches = entry.patches || [];

    const hasOfficial = patches.some(p => p.support === 'official');
    const patchType = hasOfficial ? 'official' : 'user';

    const patchLinks = [];
    const patchDescriptions = [];

    const extraComments = [];
    for (const patch of patches) {
        const comment = removeUrls(patch.comment) || '';
        if (patch.url) {
            // 원본 URL의 MD5 해시값 8자리를 생성하여 고유 식별자로 사용
            const urlHash = crypto.createHash('md5').update(patch.url).digest('hex').substring(0, 8);
            patchLinks.push(urlHash);
            patchDescriptions.push(comment || '제작자 : 정보없음');
        } else if (comment) {
            extraComments.push(comment);
        }
    }
    // URL 없는 comment를 기존 description에 합침
    if (extraComments.length > 0) {
        if (patchDescriptions.length > 0) {
            patchDescriptions[0] = [patchDescriptions[0], ...extraComments].filter(Boolean).join(' // ');
        } else {
            // 패치 링크 없이 comment만 있는 경우 extra_descriptions로 저장
            patchDescriptions.push(extraComments.join(' // '));
        }
    }

    return {
        app_id: appId,
        game_title: entry.name || '',
        steam_link: `https://store.steampowered.com/app/${appId}`,
        source_site_url: entry.url || '',
        patch_type: patchType,
        patch_links: patchLinks,
        patch_descriptions: patchDescriptions
    };
}

async function main() {
    console.log('Fetching hanpe.net API...');

    await fs.mkdir(DATA_DIR, { recursive: true });

    const storedLastModified = await getStoredLastModified();

    const response = await fetch(API_URL, {
        headers: {
            'User-Agent': 'KOSTEAM/1.0 (+https://github.com/snowyegret23/KOSTEAM)'
        }
    });

    if (!response.ok) {
        throw new Error(`API request failed: ${response.status}`);
    }

    const json = await response.json();
    const lastModified = json.last_modified;
    const results = json.results || [];

    console.log(`API last_modified: ${lastModified}`);
    console.log(`Stored last_modified: ${storedLastModified || '(none)'}`);

    if (storedLastModified && storedLastModified === lastModified) {
        console.log('No changes detected, skipping update.');
        return;
    }

    console.log(`Received ${results.length} entries`);

    const data = results
        .filter(entry => entry.appid)
        .map(convertEntry)
        .sort((a, b) => Number(a.app_id) - Number(b.app_id));

    await fs.writeFile(OUTPUT_FILE, JSON.stringify(data, null, 2), 'utf-8');

    // Save last_modified to version.json (will be overwritten by merge, but keeps it for next scraper run)
    try {
        const version = JSON.parse(await fs.readFile(VERSION_FILE, 'utf-8'));
        version.hanpe_last_modified = lastModified;
        await fs.writeFile(VERSION_FILE, JSON.stringify(version, null, 2), 'utf-8');
    } catch {
        await fs.writeFile(VERSION_FILE, JSON.stringify({ hanpe_last_modified: lastModified }, null, 2), 'utf-8');
    }

    console.log(`Saved ${data.length} games to ${OUTPUT_FILE}`);
}

main().catch(console.error);
