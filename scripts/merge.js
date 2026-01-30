import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const SOURCES = ['steamapp', 'quasarzone', 'quasarplay', 'directg', 'stove'];

async function loadSourceData(source) {
  try {
    const filePath = path.join(DATA_DIR, `${source}.json`);
    const content = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    if (data && data.games && data.curator_id) {
      return convertCuratorData(data, source);
    }
    return data;
  } catch (err) {
    console.log(`No data found for ${source}: ${err.message}`);
    return [];
  }
}

function convertCuratorData(curatorData, source) {
  return (curatorData.games || []).map(game => {
    const review = game.review || '';
    const urlPattern = /https?:\/\/[^\s"'<>]+/g;
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
      patch_descriptions: hasUrl ? [description] : []
    };
  });
}

function extractDescriptionFromReview(review) {
  const urlPattern = /https?:\/\/[^\s"'<>]+/g;
  let text = (review || '').replace(urlPattern, '');
  text = text.replace(/링크\s*:/g, '');
  text = text.replace(/^[\"']|[\"']$/g, '');
  text = text.replace(/\n+/g, '\n').trim();
  text = text.replace(/[,\\s]+$/g, '');
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

function deduplicateLinksWithDescriptions(links, descriptions, sources) {
  const seen = new Set();
  const resultLinks = [];
  const resultDescs = [];
  const resultSources = [];
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const desc = descriptions[i] || '';
    const source = sources[i] || '';
    const key = `${link}|${desc}|${source}`;
    if (!seen.has(key)) {
      seen.add(key);
      resultLinks.push(link);
      resultDescs.push(desc);
      resultSources.push(source);
    }
  }
  return { links: resultLinks, descriptions: resultDescs, sources: resultSources };
}

async function main() {
  console.log('Merging data from all sources...');
  const ALIAS_FILE = path.join(DATA_DIR, 'alias.json');
  let alias = {};
  try {
    const aliasContent = await fs.readFile(ALIAS_FILE, 'utf-8');
    alias = JSON.parse(aliasContent);
    console.log(`Loaded ${Object.keys(alias).length} aliases from alias.json`);
  } catch (err) {
    console.log('No alias.json found, skipping alias normalization.');
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
      const siteUrl = entry.source_site_url || entry.stove_url || entry.directg_url;
      const hasLinks = entryLinks.length > 0;
      const isCuratorSource = source === 'quasarplay';
      const shouldIncludeSiteUrl = !!(siteUrl && ((entry.patch_type || 'user') !== 'official' || hasLinks || isCuratorSource));

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
          if (!existing.patch_links) existing.patch_links = [];
          if (!existing.patch_descriptions) existing.patch_descriptions = [];
          if (!existing.patch_sources) existing.patch_sources = [];
          if (!existing.source_site_urls) existing.source_site_urls = {};
          for (let i = 0; i < entryLinks.length; i++) {
            existing.patch_links.push(entryLinks[i]);
            existing.patch_descriptions.push(entryDescs[i] || '');
            existing.patch_sources.push(source);
          }
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
            patch_links: [...entryLinks],
            patch_descriptions: [...entryDescs],
            patch_sources: entryLinks.map(() => source),
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
          if (!existing.patch_links) existing.patch_links = [];
          if (!existing.patch_descriptions) existing.patch_descriptions = [];
          if (!existing.patch_sources) existing.patch_sources = [];
          if (!existing.source_site_urls) existing.source_site_urls = {};
          for (let i = 0; i < entryLinks.length; i++) {
            existing.patch_links.push(entryLinks[i]);
            existing.patch_descriptions.push(entryDescs[i] || '');
            existing.patch_sources.push(source);
          }
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
            patch_links: [...entryLinks],
            patch_descriptions: [...entryDescs],
            patch_sources: entryLinks.map(() => source),
            source_site_urls: shouldIncludeSiteUrl ? { [source]: siteUrl } : {},
            sources: [source]
          };
          noSteamLink.push(obj);
          mergedByTitle.set(titleKey, obj);
        }
      }
    }
  }

  const withSteamLink = Array.from(mergedByAppId.values()).map(entry => {
    const d = deduplicateLinksWithDescriptions(entry.patch_links || [], entry.patch_descriptions || [], entry.patch_sources || []);
    return {
      ...entry,
      patch_links: d.links,
      patch_descriptions: d.descriptions,
      patch_sources: d.sources,
      sources: [...new Set(entry.sources || [])]
    };
  });

  const withoutSteamLink = noSteamLink.map(entry => {
    const d = deduplicateLinksWithDescriptions(entry.patch_links || [], entry.patch_descriptions || [], entry.patch_sources || []);
    return {
      ...entry,
      patch_links: d.links,
      patch_descriptions: d.descriptions,
      patch_sources: d.sources,
      sources: [...new Set(entry.sources || [])]
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
  await fs.writeFile(lookupPath, JSON.stringify(lookupByAppId, null, 2), 'utf-8');
  console.log(`Lookup table saved to ${lookupPath} (Games: ${withSteamLink.length})`);

  let aliasUpdatedAt = null;
  try {
    const aliasStats = await fs.stat(ALIAS_FILE);
    aliasUpdatedAt = aliasStats.mtime.toISOString();
  } catch (err) {}

  const versionInfo = {
    generated_at: generatedAt,
    total: withSteamLink.length,
    alias_updated_at: aliasUpdatedAt
  };

  const versionPath = path.join(DATA_DIR, 'version.json');
  await fs.writeFile(versionPath, JSON.stringify(versionInfo, null, 2), 'utf-8');
  console.log(`Version info saved to ${versionPath}`);
}

main().catch(console.error);
