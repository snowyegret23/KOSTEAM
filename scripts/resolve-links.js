import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

const SOURCES = ['steamapp', 'quasarplay', 'directg', 'stove'];
const MAX_REDIRECTS = 5;
const REQUEST_DELAY = 300;

const delay = ms => new Promise(r => setTimeout(r, ms));

async function resolveUrl(url, maxRedirects = MAX_REDIRECTS) {
    if (!url || typeof url !== 'string') return { original: url, final: url, redirected: false };
    
    let currentUrl = url;
    let redirectCount = 0;
    let redirected = false;
    
    try {
        while (redirectCount < maxRedirects) {
            const response = await fetch(currentUrl, {
                method: 'HEAD',
                redirect: 'manual',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            
            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get('location');
                if (location) {
                    if (location.startsWith('/')) {
                        const urlObj = new URL(currentUrl);
                        currentUrl = `${urlObj.protocol}//${urlObj.host}${location}`;
                    } else if (!location.startsWith('http')) {
                        const urlObj = new URL(currentUrl);
                        currentUrl = `${urlObj.protocol}//${urlObj.host}/${location}`;
                    } else {
                        currentUrl = location;
                    }
                    redirected = true;
                    redirectCount++;
                } else {
                    break;
                }
            } else {
                break;
            }
        }
        
        return {
            original: url,
            final: currentUrl,
            redirected,
            redirect_count: redirectCount
        };
    } catch (err) {
        return {
            original: url,
            final: url,
            redirected: false,
            error: err.message
        };
    }
}

function extractSteamAppId(url) {
    if (!url) return null;
    const match = url.match(/store\.steampowered\.com\/app\/(\d+)/);
    return match ? match[1] : null;
}

async function resolveLinksForSource(sourceName) {
    const filePath = path.join(DATA_DIR, `${sourceName}.json`);
    
    let data;
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        data = JSON.parse(content);
    } catch (err) {
        console.log(`Skipping ${sourceName}: ${err.message}`);
        return { processed: 0, updated: 0 };
    }
    
    console.log(`\nProcessing ${sourceName}: ${data.length} entries`);
    
    let processed = 0;
    let updated = 0;
    
    for (const entry of data) {
        processed++;
        
        if (entry.steam_link && !entry.steam_link_resolved) {
            const result = await resolveUrl(entry.steam_link);
            
            if (result.redirected) {
                entry.steam_link_original = entry.steam_link;
                entry.steam_link = result.final;
                entry.steam_link_resolved = true;
                
                const newAppId = extractSteamAppId(result.final);
                if (newAppId && newAppId !== entry.app_id) {
                    entry.app_id_original = entry.app_id;
                    entry.app_id = newAppId;
                }
                
                updated++;
                console.log(`  [${processed}/${data.length}] Resolved: ${result.original} → ${result.final}`);
            }
            
            await delay(REQUEST_DELAY);
        }
        
        if (entry.patch_links && Array.isArray(entry.patch_links)) {
            const resolvedLinks = [];
            let linksUpdated = false;
            
            for (const link of entry.patch_links) {
                if (link.startsWith('http')) {
                    const result = await resolveUrl(link);
                    resolvedLinks.push(result.final);
                    
                    if (result.redirected) {
                        linksUpdated = true;
                        console.log(`  [${processed}/${data.length}] Patch link: ${link} → ${result.final}`);
                    }
                    
                    await delay(REQUEST_DELAY);
                } else {
                    resolvedLinks.push(link);
                }
            }
            
            if (linksUpdated) {
                entry.patch_links_original = entry.patch_links;
                entry.patch_links = resolvedLinks;
                updated++;
            }
        }
        
        if (processed % 50 === 0) {
            console.log(`  Progress: ${processed}/${data.length}`);
        }
    }
    
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`Saved ${sourceName}: ${updated} entries updated`);
    
    return { processed, updated };
}

async function verifyAllSteamLinks() {
    console.log('\n=== Monthly Steam Link Verification ===');
    
    const mergedPath = path.join(DATA_DIR, 'merged.json');
    let merged;
    
    try {
        const content = await fs.readFile(mergedPath, 'utf-8');
        merged = JSON.parse(content);
    } catch (err) {
        console.log('No merged.json found, skipping verification');
        return;
    }
    
    const games = merged.games || [];
    console.log(`Verifying ${games.length} Steam links...`);
    
    let verified = 0;
    let changed = 0;
    
    for (const game of games) {
        if (!game.steam_link) continue;
        
        verified++;
        
        try {
            const response = await fetch(game.steam_link, {
                method: 'HEAD',
                redirect: 'follow',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            
            const finalUrl = response.url;
            const finalAppId = extractSteamAppId(finalUrl);
            
            if (finalAppId && finalAppId !== game.app_id) {
                console.log(`  App ID changed: ${game.app_id} → ${finalAppId} (${game.game_title})`);
                game.app_id_previous = game.app_id;
                game.app_id = finalAppId;
                game.steam_link = finalUrl;
                changed++;
            }
            
            game.last_verified = new Date().toISOString();
            
        } catch (err) {
            console.log(`  Error verifying ${game.game_title}: ${err.message}`);
        }
        
        if (verified % 100 === 0) {
            console.log(`  Verified: ${verified}/${games.length}`);
        }
        
        await delay(REQUEST_DELAY);
    }
    
    merged.meta.last_verification = new Date().toISOString();
    merged.meta.verification_changes = changed;
    
    await fs.writeFile(mergedPath, JSON.stringify(merged, null, 2), 'utf-8');
    console.log(`\nVerification complete: ${changed} links changed out of ${verified}`);
}

async function main() {
    const args = process.argv.slice(2);
    const verifyOnly = args.includes('--verify');
    const sourceArg = args.find(a => a.startsWith('--source='));
    const specificSource = sourceArg ? sourceArg.split('=')[1] : null;
    
    console.log('=== Link Resolver ===');
    console.log(`Mode: ${verifyOnly ? 'Verification Only' : 'Full Resolution'}`);
    
    if (verifyOnly) {
        await verifyAllSteamLinks();
        return;
    }
    
    const sourcesToProcess = specificSource ? [specificSource] : SOURCES;
    const stats = { total_processed: 0, total_updated: 0 };
    
    for (const source of sourcesToProcess) {
        const result = await resolveLinksForSource(source);
        stats.total_processed += result.processed;
        stats.total_updated += result.updated;
    }
    
    console.log('\n=== Summary ===');
    console.log(`Total processed: ${stats.total_processed}`);
    console.log(`Total updated: ${stats.total_updated}`);
}

main().catch(console.error);
