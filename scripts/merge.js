import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

const SOURCES = ['steamapp', 'quasarplay', 'directg', 'stove'];

async function loadSourceData(source) {
    try {
        const filePath = path.join(DATA_DIR, `${source}.json`);
        const content = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(content);
    } catch (err) {
        console.log(`No data found for ${source}: ${err.message}`);
        return [];
    }
}

function normalizeAppId(appId) {
    if (!appId) return null;
    return String(appId).trim();
}

function extractAppIdFromLink(steamLink) {
    if (!steamLink) return null;
    const match = steamLink.match(/\/app\/(\d+)/);
    return match ? match[1] : null;
}

async function main() {
    console.log('Merging data from all sources...');
    
    const mergedByAppId = new Map();
    const mergedByTitle = new Map();
    const noSteamLink = [];
    
    for (const source of SOURCES) {
        const data = await loadSourceData(source);
        console.log(`Loaded ${data.length} entries from ${source}`);
        
        for (const entry of data) {
            const appId = normalizeAppId(entry.app_id) || extractAppIdFromLink(entry.steam_link);
            
            if (appId) {
                const existing = mergedByAppId.get(appId);
                
                if (existing) {
                    existing.sources.push(source);
                    if (!existing.patch_links) existing.patch_links = [];
                    existing.patch_links.push(...(entry.patch_links || []));
                    
                    if (entry.patch_type === 'official' && existing.patch_type !== 'official') {
                        existing.patch_type = 'official';
                    }
                    
                    if (entry.description && !existing.description) {
                        existing.description = entry.description;
                    }
                } else {
                    mergedByAppId.set(appId, {
                        app_id: appId,
                        game_title: entry.game_title,
                        steam_link: entry.steam_link || `https://store.steampowered.com/app/${appId}`,
                        patch_type: entry.patch_type || 'user',
                        patch_links: [...(entry.patch_links || [])],
                        sources: [source],
                        description: entry.description || '',
                        updated_at: entry.updated_at || new Date().toISOString()
                    });
                }
            } else {
                const titleKey = entry.game_title.toLowerCase().trim();
                const existing = mergedByTitle.get(titleKey);
                
                if (existing) {
                    existing.sources.push(source);
                    if (!existing.patch_links) existing.patch_links = [];
                    existing.patch_links.push(...(entry.patch_links || []));
                } else {
                    noSteamLink.push({
                        ...entry,
                        sources: [source]
                    });
                    mergedByTitle.set(titleKey, noSteamLink[noSteamLink.length - 1]);
                }
            }
        }
    }
    
    const withSteamLink = Array.from(mergedByAppId.values()).map(entry => ({
        ...entry,
        patch_links: [...new Set(entry.patch_links)],
        sources: [...new Set(entry.sources)]
    }));
    
    const withoutSteamLink = noSteamLink.map(entry => ({
        ...entry,
        patch_links: [...new Set(entry.patch_links || [])],
        sources: [...new Set(entry.sources)]
    }));
    
    const merged = {
        meta: {
            generated_at: new Date().toISOString(),
            total_with_steam_link: withSteamLink.length,
            total_without_steam_link: withoutSteamLink.length,
            sources: SOURCES
        },
        games: withSteamLink.sort((a, b) => a.game_title.localeCompare(b.game_title)),
        games_no_steam_link: withoutSteamLink.sort((a, b) => a.game_title.localeCompare(b.game_title))
    };
    
    const outputPath = path.join(DATA_DIR, 'merged.json');
    await fs.writeFile(outputPath, JSON.stringify(merged, null, 2), 'utf-8');
    
    console.log(`\nMerge complete!`);
    console.log(`- Games with Steam link: ${withSteamLink.length}`);
    console.log(`- Games without Steam link: ${withoutSteamLink.length}`);
    console.log(`Saved to ${outputPath}`);
    
    const lookupByAppId = {};
    for (const game of withSteamLink) {
        lookupByAppId[game.app_id] = {
            title: game.game_title,
            type: game.patch_type,
            sources: game.sources,
            links: game.patch_links
        };
    }
    
    const lookupPath = path.join(DATA_DIR, 'lookup.json');
    await fs.writeFile(lookupPath, JSON.stringify(lookupByAppId, null, 2), 'utf-8');
    console.log(`Lookup table saved to ${lookupPath}`);
}

main().catch(console.error);
