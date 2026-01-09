import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveUrl, extractSteamAppId, isIgnoredRedirect } from './resolve-links.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const MERGED_FILE = path.join(DATA_DIR, 'merged.json');
const ALIAS_FILE = path.join(DATA_DIR, 'alias.json');
const VERSION_FILE = path.join(DATA_DIR, 'version.json');

const REQUEST_DELAY = 100;

const delay = ms => new Promise(r => setTimeout(r, ms));

async function main() {
    console.log('=== AppID Alias Updater ===');

    let merged;
    try {
        const content = await fs.readFile(MERGED_FILE, 'utf-8');
        merged = JSON.parse(content);
    } catch (err) {
        console.error('Error: merged.json not found. Run merge.js first.');
        return;
    }

    let existingAlias = {};
    try {
        const content = await fs.readFile(ALIAS_FILE, 'utf-8');
        existingAlias = JSON.parse(content);
    } catch (err) {
        console.log('Starting with new alias table.');
    }

    const games = merged.games || [];
    console.log(`Checking ${games.length} games for redirects...`);

    const newAlias = { ...existingAlias };
    let foundCount = 0;
    let processed = 0;

    for (const game of games) {
        processed++;
        const originalAppId = game.app_id;
        if (!originalAppId || !game.steam_link) continue;

        const result = await resolveUrl(game.steam_link);

        if (result.redirected && !result.skipped_reason) {
            const finalAppId = extractSteamAppId(result.final);
            if (finalAppId && finalAppId !== originalAppId) {
                if (newAlias[finalAppId] !== originalAppId) {
                    console.log(`  [Found] New Redirect: ${originalAppId} → ${finalAppId} (${game.game_title})`);
                    newAlias[finalAppId] = originalAppId;
                    foundCount++;
                }
            }
        }

        if (processed % 100 === 0) {
            console.log(`  Progress: ${processed}/${games.length} (New aliases found: ${foundCount})`);
        }

        await delay(REQUEST_DELAY);
    }

    await fs.writeFile(ALIAS_FILE, JSON.stringify(newAlias, null, 2), 'utf-8');
    console.log(`\nSaved ${Object.keys(newAlias).length} aliases to ${ALIAS_FILE}`);

    let versionInfo = {};
    try {
        const content = await fs.readFile(VERSION_FILE, 'utf-8');
        versionInfo = JSON.parse(content);
    } catch (err) { }

    versionInfo.alias_updated_at = new Date().toISOString();
    await fs.writeFile(VERSION_FILE, JSON.stringify(versionInfo, null, 2), 'utf-8');
    console.log(`Updated version.json with alias_updated_at`);

    if (foundCount > 0) {
        console.log('\nAppID changes detected. You should run merge.js to update lookup.json.');
    }
}

main().catch(console.error);
