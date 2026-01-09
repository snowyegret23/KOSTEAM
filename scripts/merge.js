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
                    if (!existing.patch_descriptions) existing.patch_descriptions = [];
                    if (!existing.patch_sources) existing.patch_sources = [];

                    const entryLinks = entry.patch_links || [];
                    const entryDescs = entry.patch_descriptions || [];
                    for (let i = 0; i < entryLinks.length; i++) {
                        existing.patch_links.push(entryLinks[i]);
                        existing.patch_descriptions.push(entryDescs[i] || '');
                        existing.patch_sources.push(source);
                    }

                    if (entry.patch_type === 'official' && existing.patch_type !== 'official') {
                        existing.patch_type = 'official';
                    }

                    if (entry.description) {
                        if (!existing.descriptions) existing.descriptions = [];
                        existing.descriptions.push(entry.description);
                    }

                    if (!existing.source_site_urls) existing.source_site_urls = {};
                    const siteUrl = entry.source_site_url || entry.stove_url || entry.directg_url;
                    const hasLinksFromSource = entryLinks.length > 0;
                    if (siteUrl && (entry.patch_type !== 'official' || hasLinksFromSource)) {
                        existing.source_site_urls[source] = siteUrl;
                    }
                } else {
                    const entryLinks = entry.patch_links || [];
                    const hasLinks = entryLinks.length > 0;
                    const siteUrl = entry.source_site_url || entry.stove_url || entry.directg_url;
                    const shouldIncludeSiteUrl = siteUrl && (entry.patch_type !== 'official' || hasLinks);

                    mergedByAppId.set(appId, {
                        app_id: appId,
                        game_title: entry.game_title,
                        steam_link: entry.steam_link || `https://store.steampowered.com/app/${appId}`,
                        patch_type: entry.patch_type || 'user',
                        patch_links: [...entryLinks],
                        patch_descriptions: [...(entry.patch_descriptions || [])],
                        patch_sources: entryLinks.map(() => source),
                        source_site_urls: shouldIncludeSiteUrl ? { [source]: siteUrl } : {},
                        sources: [source],
                        descriptions: entry.description ? [entry.description] : [],
                        updated_at: entry.updated_at || new Date().toISOString()
                    });
                }
            } else {
                const titleKey = entry.game_title.toLowerCase().trim();
                const existing = mergedByTitle.get(titleKey);

                if (existing) {
                    existing.sources.push(source);
                    if (!existing.patch_links) existing.patch_links = [];
                    if (!existing.patch_descriptions) existing.patch_descriptions = [];
                    if (!existing.patch_sources) existing.patch_sources = [];

                    const entryLinks = entry.patch_links || [];
                    const entryDescs = entry.patch_descriptions || [];
                    for (let i = 0; i < entryLinks.length; i++) {
                        existing.patch_links.push(entryLinks[i]);
                        existing.patch_descriptions.push(entryDescs[i] || '');
                        existing.patch_sources.push(source);
                    }

                    if (entry.description) {
                        if (!existing.descriptions) existing.descriptions = [];
                        existing.descriptions.push(entry.description);
                    }

                    if (!existing.source_site_urls) existing.source_site_urls = {};
                    const siteUrl = entry.source_site_url || entry.stove_url || entry.directg_url;
                    const hasLinksFromSource = entryLinks.length > 0;
                    if (siteUrl && (entry.patch_type !== 'official' || hasLinksFromSource)) {
                        existing.source_site_urls[source] = siteUrl;
                    }
                } else {
                    const entryLinks = entry.patch_links || [];
                    const hasLinks = entryLinks.length > 0;
                    const siteUrl = entry.source_site_url || entry.stove_url || entry.directg_url;
                    const shouldIncludeSiteUrl = siteUrl && (entry.patch_type !== 'official' || hasLinks);

                    noSteamLink.push({
                        game_title: entry.game_title,
                        patch_type: entry.patch_type || 'user',
                        patch_links: [...entryLinks],
                        patch_descriptions: [...(entry.patch_descriptions || [])],
                        patch_sources: entryLinks.map(() => source),
                        source_site_urls: shouldIncludeSiteUrl ? { [source]: siteUrl } : {},
                        sources: [source],
                        descriptions: entry.description ? [entry.description] : [],
                        updated_at: entry.updated_at || new Date().toISOString()
                    });
                    mergedByTitle.set(titleKey, noSteamLink[noSteamLink.length - 1]);
                }
            }
        }
    }

    const processDescriptions = (entry) => {
        if (entry.descriptions && entry.descriptions.length > 0) {
            const unique = [...new Set(entry.descriptions)];
            entry.description = unique.join(' // ');
            delete entry.descriptions;
        } else {
            entry.description = '';
            delete entry.descriptions;
        }
        return entry;
    };

    const deduplicateLinksWithDescriptions = (links, descriptions, sources) => {
        const seen = new Map();
        const resultLinks = [];
        const resultDescs = [];
        const resultSources = [];
        const sourcesWithLinks = new Set();

        for (let i = 0; i < links.length; i++) {
            const link = links[i];
            const desc = descriptions[i] || '';
            const source = sources[i] || '';

            sourcesWithLinks.add(source);

            if (!seen.has(link)) {
                seen.set(link, resultLinks.length);
                resultLinks.push(link);
                resultDescs.push(desc);
                resultSources.push(source);
            } else {
                if (desc && !resultDescs[seen.get(link)]) {
                    resultDescs[seen.get(link)] = desc;
                }
            }
        }

        return {
            links: resultLinks,
            descriptions: resultDescs,
            sources: resultSources,
            sourcesWithLinks: [...sourcesWithLinks]
        };
    };

    const withSteamLink = Array.from(mergedByAppId.values()).map(entry => {
        processDescriptions(entry);
        const deduplicated = deduplicateLinksWithDescriptions(
            entry.patch_links || [],
            entry.patch_descriptions || [],
            entry.patch_sources || []
        );
        return {
            ...entry,
            patch_links: deduplicated.links,
            patch_descriptions: deduplicated.descriptions,
            patch_sources: deduplicated.sources,
            sources_with_links: deduplicated.sourcesWithLinks,
            sources: [...new Set(entry.sources)]
        };
    });

    const withoutSteamLink = noSteamLink.map(entry => {
        processDescriptions(entry);
        const deduplicated = deduplicateLinksWithDescriptions(
            entry.patch_links || [],
            entry.patch_descriptions || [],
            entry.patch_sources || []
        );
        return {
            ...entry,
            patch_links: deduplicated.links,
            patch_descriptions: deduplicated.descriptions,
            patch_sources: deduplicated.sources,
            sources_with_links: deduplicated.sourcesWithLinks,
            sources: [...new Set(entry.sources)]
        };
    });

    const generatedAt = new Date().toISOString();

    const merged = {
        meta: {
            generated_at: generatedAt,
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

    const lookupByAppId = {
        _meta: {
            generated_at: generatedAt,
            total: withSteamLink.length
        }
    };

    for (const game of withSteamLink) {
        lookupByAppId[game.app_id] = {
            title: game.game_title,
            type: game.patch_type,
            sources: game.sources,
            links: game.patch_links,
            patch_descriptions: game.patch_descriptions || [],
            patch_sources: game.patch_sources || [],
            sources_with_links: game.sources_with_links || [],
            source_site_urls: game.source_site_urls || {},
            description: game.description || ''
        };
    }

    const lookupPath = path.join(DATA_DIR, 'lookup.json');
    await fs.writeFile(lookupPath, JSON.stringify(lookupByAppId, null, 2), 'utf-8');
    console.log(`Lookup table saved to ${lookupPath}`);

    const versionInfo = {
        generated_at: generatedAt,
        total: withSteamLink.length
    };
    const versionPath = path.join(DATA_DIR, 'version.json');
    await fs.writeFile(versionPath, JSON.stringify(versionInfo, null, 2), 'utf-8');
    console.log(`Version info saved to ${versionPath}`);
}

main().catch(console.error);
