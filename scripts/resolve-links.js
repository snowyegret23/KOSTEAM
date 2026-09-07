import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

const SOURCES = ['steamapp', 'quasarplay', 'quasarzone', 'directg', 'stove'];
const MAX_REDIRECTS = 5;
const REQUEST_DELAY = 300;

function isSteamStoreUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname === 'store.steampowered.com' &&
            !url.username && !url.password && !url.port;
    } catch {
        return false;
    }
}

export function isIgnoredRedirect(originalUrl, redirectedUrl) {
    return !!extractSteamAppId(originalUrl) && isSteamStoreUrl(redirectedUrl) &&
        /^\/(?:agecheck|login|age)(?:\/|$)/.test(new URL(redirectedUrl).pathname);
}

const delay = ms => new Promise(r => setTimeout(r, ms));

export async function resolveUrl(url, maxRedirects = MAX_REDIRECTS) {
    if (!url || typeof url !== 'string') return { original: url, final: url, redirected: false };

    let currentUrl = url;
    let redirectCount = 0;
    let redirected = false;

    try {
        if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) {
            throw new Error('Invalid redirect limit');
        }
        const visited = new Set();
        while (true) {
            if (!isSteamStoreUrl(currentUrl)) throw new Error('Untrusted Steam redirect URL');
            if (visited.has(currentUrl)) throw new Error('Redirect loop');
            visited.add(currentUrl);
            const response = await fetch(currentUrl, {
                method: 'HEAD',
                redirect: 'manual',
                signal: AbortSignal.timeout(15000),
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get('location');
                if (location) {
                    const nextUrl = new URL(location, currentUrl).href;
                    if (!isSteamStoreUrl(nextUrl)) throw new Error('Untrusted Steam redirect URL');
                    if (redirectCount >= maxRedirects) throw new Error('Too many redirects');

                    if (isIgnoredRedirect(url, nextUrl)) {
                        return {
                            original: url,
                            final: url,
                            redirected: false,
                            skipped_reason: 'steam_agecheck_or_login'
                        };
                    }

                    currentUrl = nextUrl;
                    redirected = true;
                    redirectCount++;
                } else {
                    throw new Error('Redirect is missing its location');
                }
            } else {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                break;
            }
        }

        if (isIgnoredRedirect(url, currentUrl)) {
            return {
                original: url,
                final: url,
                redirected: false,
                skipped_reason: 'steam_agecheck_or_login'
            };
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

export function extractSteamAppId(url) {
    if (!isSteamStoreUrl(url)) return null;
    const match = new URL(url).pathname.match(/^\/app\/(\d+)(?:\/|$)/);
    return match ? match[1] : null;
}

async function resolveLinksForSource(sourceName) {
    const filePath = path.join(DATA_DIR, `${sourceName}.json`);

    let data;
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        data = JSON.parse(content);
    } catch (err) {
        throw new Error(`Cannot load ${sourceName}: ${err.message}`);
    }
    const entries = Array.isArray(data) ? data : data.games;
    if (!Array.isArray(entries)) throw new Error(`Invalid source data: ${sourceName}`);
    const linkKey = Array.isArray(data) ? 'steam_link' : 'url';
    const appKey = Array.isArray(data) ? 'app_id' : 'appid';
    console.log(`\nProcessing ${sourceName}: ${entries.length} entries`);

    let processed = 0;
    let updated = 0;
    let skipped = 0;

    for (const entry of entries) {
        processed++;

        if (entry[linkKey] && !entry.steam_link_resolved) {
            const result = await resolveUrl(entry[linkKey]);

            if (result.skipped_reason) {
                skipped++;
            } else if (result.redirected) {
                entry.steam_link_original = entry[linkKey];
                entry[linkKey] = result.final;
                entry.steam_link_resolved = true;

                const newAppId = extractSteamAppId(result.final);
                if (newAppId && newAppId !== entry[appKey]) {
                    entry.app_id_original = entry[appKey];
                    entry[appKey] = newAppId;
                }

                updated++;
                console.log(`  [${processed}/${entries.length}] Resolved: ${result.original} → ${result.final}`);
            }

            await delay(REQUEST_DELAY);
        }

        if (entry.patch_links && Array.isArray(entry.patch_links)) {
            const resolvedLinks = [];
            let linksUpdated = false;

            for (const link of entry.patch_links) {
                if (isSteamStoreUrl(link)) {
                    const result = await resolveUrl(link);

                    if (result.skipped_reason) {
                        resolvedLinks.push(link);
                        skipped++;
                    } else {
                        resolvedLinks.push(result.final);

                        if (result.redirected) {
                            linksUpdated = true;
                            console.log(`  [${processed}/${entries.length}] Patch link: ${link} → ${result.final}`);
                        }
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
            console.log(`  Progress: ${processed}/${entries.length} (updated: ${updated}, skipped: ${skipped})`);
        }
    }

    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`Saved ${sourceName}: ${updated} updated, ${skipped} skipped (agecheck/login)`);

    return { processed, updated, skipped };
}

async function verifyAllSteamLinks() {
    console.log('\n=== Monthly Steam Link Verification ===');

    const mergedPath = path.join(DATA_DIR, 'merged.json');
    let merged;

    try {
        const content = await fs.readFile(mergedPath, 'utf-8');
        merged = JSON.parse(content);
    } catch (err) {
        throw new Error(`Cannot load merged data: ${err.message}`);
    }

    const games = merged.games || [];
    console.log(`Verifying ${games.length} Steam links...`);

    let verified = 0;
    let changed = 0;
    let skipped = 0;

    for (const game of games) {
        if (!game.steam_link) continue;

        verified++;

        try {
            const result = await resolveUrl(game.steam_link);
            if (result.error) throw new Error(result.error);
            const finalUrl = result.final;

            if (isIgnoredRedirect(game.steam_link, finalUrl)) {
                skipped++;
                game.last_verified = new Date().toISOString();
                continue;
            }

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
    console.log(`\nVerification complete: ${changed} changed, ${skipped} skipped (agecheck/login)`);
}

async function main() {
    const args = process.argv.slice(2);
    const verifyOnly = args.includes('--verify');
    const sourceArg = args.find(a => a.startsWith('--source='));
    const specificSource = sourceArg ? sourceArg.split('=')[1] : null;
    if (specificSource && !SOURCES.includes(specificSource)) throw new Error('Unknown source');

    console.log('=== Link Resolver ===');
    console.log(`Mode: ${verifyOnly ? 'Verification Only' : 'Full Resolution'}`);

    if (verifyOnly) {
        await verifyAllSteamLinks();
        return;
    }

    const sourcesToProcess = specificSource ? [specificSource] : SOURCES;
    const stats = { total_processed: 0, total_updated: 0, total_skipped: 0 };

    for (const source of sourcesToProcess) {
        const result = await resolveLinksForSource(source);
        stats.total_processed += result.processed;
        stats.total_updated += result.updated;
        stats.total_skipped += result.skipped;
    }

    console.log('\n=== Summary ===');
    console.log(`Total processed: ${stats.total_processed}`);
    console.log(`Total updated: ${stats.total_updated}`);
    console.log(`Total skipped (agecheck/login): ${stats.total_skipped}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(err => { console.error(err); process.exitCode = 1; });
}
