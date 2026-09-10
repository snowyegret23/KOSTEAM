import { removeReviewUrls } from './review-text.js';
import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const SOURCES = ['steamapp', 'quasarzone', 'quasarplay', 'directg', 'stove'];

async function loadSourceData(source) {
  try {
    const filePath = path.join(DATA_DIR, `${source}.json`);
    const content = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    if (data && Array.isArray(data.games) && data.curator_id && data.games.length > 0) {
      return convertCuratorData(data, source);
    }
    if (!Array.isArray(data) || data.length === 0) throw new Error('Invalid or empty source data');
    return data;
  } catch (err) {
    throw new Error(`Cannot merge ${source}: ${err.message}`);
  }
}

function convertCuratorData(curatorData, source) {
  return (curatorData.games || []).map(game => {
    const review = game.review || '';
    const urlPattern = /(?:https?:\/\/|www\.)[^\s"'<>]+/gi;
    const hasUrl = (typeof game.review_has_url === 'boolean') ? game.review_has_url : urlPattern.test(review);
    const description = extractDescriptionFromReview(review);
    const patchType = hasUrl ? 'user' : 'official';
    const appId = String(game.appid || '').trim();
    return {
      app_id: appId,
      game_title: '',
      steam_link: game.url || `https://store.steampowered.com/app/${appId}`,
      source_site_url: game.curator_url,
      patch_type: patchType,
      patch_links: hasUrl ? ['exist'] : [],
      patch_descriptions: (hasUrl || description) ? [description] : []
    };
  });
}

function extractDescriptionFromReview(review) {
  let text = removeReviewUrls(review || '');
  text = text.replace(/링크\s*:/g, '');
  text = text.replace(/^[\"']|[\"']$/g, '');
  text = text.replace(/\n+/g, '\n').trim();
  text = text.replace(/[,\s]+$/g, '');
  return text;
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

function deduplicatePatchEntries(patches) {
  const seen = new Set();
  const resultLinks = [];
  const resultDescs = [];
  const resultSources = [];
  for (const { link, description, source } of patches) {
    const key = JSON.stringify([link, description, source]);
    if (!seen.has(key)) {
      seen.add(key);
      resultLinks.push(link);
      resultDescs.push(description);
      resultSources.push(source);
    }
  }
  // Legacy clients use a nonempty links array to classify additional patch information.
  const links = resultLinks.some(Boolean) ? resultLinks : [];
  return { links, descriptions: resultDescs, sources: resultSources };
}

async function main() {
  console.log('Merging data from all sources...');
  const ALIAS_FILE = path.join(DATA_DIR, 'alias.json');
  let alias = {};
  let aliasContent = null;
  try {
    alias = JSON.parse(await fs.readFile(ALIAS_FILE, 'utf-8'));
    aliasContent = JSON.stringify(alias, null, 2);
    console.log(`Loaded ${Object.keys(alias).length} aliases from alias.json`);
  } catch (err) {
    throw new Error(`Cannot load alias mappings: ${err.message}`);
  }

  const mergedByAppId = new Map();
  const mergedByTitle = new Map();
  const noSteamLink = [];

  for (const fileSource of SOURCES) {
    const data = await loadSourceData(fileSource);
    console.log(`Loaded ${data.length} entries from ${fileSource}`);
    const source = fileSource === 'quasarzone' ? 'quasarplay' : fileSource;

    for (const entry of data) {
      const entryLinks = entry.patch_links || [];
      const entryDescs = entry.patch_descriptions || [];
      const patches = Array.from({ length: Math.max(entryLinks.length, entryDescs.length) }, (_, i) => ({
        link: entryLinks[i] || '',
        description: entryDescs[i] || '',
        source
      }));
      const siteUrl = entry.source_site_url || entry.stove_url || entry.directg_url;
      const hasLinks = entryLinks.length > 0;
      const isCuratorSource = source === 'quasarplay';
      const isSteamapp = source === 'steamapp';
      const shouldIncludeSiteUrl = !!(siteUrl && ((entry.patch_type || 'user') !== 'official' || hasLinks || isCuratorSource || isSteamapp));

      let appId = normalizeAppId(entry.app_id) || extractAppIdFromLink(entry.steam_link);

      if (appId && alias[appId]) {
        const originalId = alias[appId];
        console.log(` [Alias] Normalizing ${appId} -> ${originalId}`);
        appId = originalId;
      }

      if (appId) {
        const existing = mergedByAppId.get(appId);
        if (existing) {
          existing.sources.push(source);
          if (!existing.source_site_urls) existing.source_site_urls = {};
          existing.patches.push(...patches);
          if ((entry.patch_type || 'user') === 'official' && existing.patch_type !== 'official') {
            existing.patch_type = 'official';
          }
          if (shouldIncludeSiteUrl && !existing.source_site_urls[source]) {
            existing.source_site_urls[source] = siteUrl;
          }
        } else {
          const newEntry = {
            app_id: appId,
            game_title: entry.game_title || '',
            steam_link: entry.steam_link || `https://store.steampowered.com/app/${appId}`,
            patch_type: entry.patch_type || 'user',
            patches,
            source_site_urls: shouldIncludeSiteUrl ? { [source]: siteUrl } : {},
            sources: [source]
          };
          mergedByAppId.set(appId, newEntry);
        }
      } else {
        const title = (entry.game_title || '').trim();
        if (!title) continue;
        const titleKey = title.toLowerCase();
        const existing = mergedByTitle.get(titleKey);
        if (existing) {
          existing.sources.push(source);
          if (!existing.source_site_urls) existing.source_site_urls = {};
          existing.patches.push(...patches);
          if ((entry.patch_type || 'user') === 'official' && existing.patch_type !== 'official') {
            existing.patch_type = 'official';
          }
          if (shouldIncludeSiteUrl && !existing.source_site_urls[source]) {
            existing.source_site_urls[source] = siteUrl;
          }
        } else {
          const obj = {
            game_title: title,
            patch_type: entry.patch_type || 'user',
            patches,
            source_site_urls: shouldIncludeSiteUrl ? { [source]: siteUrl } : {},
            sources: [source]
          };
          noSteamLink.push(obj);
          mergedByTitle.set(titleKey, obj);
        }
      }
    }
  }

  const withSteamLink = Array.from(mergedByAppId.values()).map(({ patches, source_site_urls, sources, ...entry }) => {
    const d = deduplicatePatchEntries(patches);
    return {
      ...entry,
      patch_links: d.links,
      patch_descriptions: d.descriptions,
      patch_sources: d.sources,
      source_site_urls,
      sources: [...new Set(sources)]
    };
  });

  const withoutSteamLink = noSteamLink.map(({ patches, source_site_urls, sources, ...entry }) => {
    const d = deduplicatePatchEntries(patches);
    return {
      ...entry,
      patch_links: d.links,
      patch_descriptions: d.descriptions,
      patch_sources: d.sources,
      source_site_urls,
      sources: [...new Set(sources)]
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
    games: withSteamLink.sort((a, b) => (a.game_title || '').localeCompare(b.game_title || '')),
    games_no_steam_link: withoutSteamLink.sort((a, b) => (a.game_title || '').localeCompare(b.game_title || ''))
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
      type: game.patch_type,
      sources: game.sources,
      links: game.patch_links,
      patch_descriptions: game.patch_descriptions || [],
      patch_sources: game.patch_sources || [],
      source_site_urls: game.source_site_urls || {}
    };
  }

  const lookupPath = path.join(DATA_DIR, 'lookup.json');
  const lookupContent = JSON.stringify(lookupByAppId, null, 2);
  await fs.writeFile(lookupPath, lookupContent, 'utf-8');
  console.log(`Lookup table saved to ${lookupPath} (Games: ${withSteamLink.length})`);

  const lookupSha256 = createHash('sha256').update(lookupContent, 'utf-8').digest('hex');
  const lookupSize = Buffer.byteLength(lookupContent, 'utf-8');
  const aliasSha256 = aliasContent === null
    ? null
    : createHash('sha256').update(aliasContent, 'utf-8').digest('hex');
  const aliasSize = aliasContent === null ? null : Buffer.byteLength(aliasContent, 'utf-8');

  let aliasUpdatedAt = null;
  try {
    const aliasStats = await fs.stat(ALIAS_FILE);
    aliasUpdatedAt = aliasStats.mtime.toISOString();
  } catch (err) {}

  let hanpeLastModified = null;
  try {
    const currentVersion = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'version.json'), 'utf-8'));
    hanpeLastModified = currentVersion.hanpe_last_modified || null;
  } catch (err) {}

  const versionInfo = {
    generated_at: generatedAt,
    total: withSteamLink.length,
    alias_updated_at: aliasUpdatedAt,
    hanpe_last_modified: hanpeLastModified,
    lookup_sha256: lookupSha256,
    lookup_size: lookupSize,
    alias_sha256: aliasSha256,
    alias_size: aliasSize
  };

  const versionPath = path.join(DATA_DIR, 'version.json');
  await fs.writeFile(versionPath, JSON.stringify(versionInfo, null, 2), 'utf-8');
  console.log(`Version info saved to ${versionPath}`);
}

main().catch(err => { console.error(err); process.exitCode = 1; });
