import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

// quasarzone이 quasarplay보다 최신 큐레이터이므로 먼저 처리 (중복 시 quasarzone 데이터 우선)
const SOURCES = ['steamapp', 'quasarzone', 'quasarplay', 'directg', 'stove'];

async function loadSourceData(source) {
    try {
        const filePath = path.join(DATA_DIR, `${source}.json`);
        const content = await fs.readFile(filePath, 'utf-8');
        const data = JSON.parse(content);

        // 큐레이터 덤프 형식인 경우 변환 (quasarplay, quasarzone)
        if (data.games && data.curator_id) {
            return convertCuratorData(data, source);
        }

        return data;
    } catch (err) {
        console.log(`No data found for ${source}: ${err.message}`);
        return [];
    }
}

function convertCuratorData(curatorData, source) {
    /**
     * 큐레이터 덤프 형식을 기존 스크래퍼 형식으로 변환
     *
     * 큐레이터 형식:
     * { appid, url, curator_url, review, type }
     *
     * 스크래퍼 형식:
     * { app_id, game_title, steam_link, source_site_url, patch_type, patch_links, patch_descriptions }
     */
    return curatorData.games.map(game => {
        const review = game.review || '';

        // 리뷰에 URL이 있는지 확인
        const urlPattern = /https?:\/\/[^\s"'<>]+/g;
        const hasUrl = urlPattern.test(review);

        // 리뷰에서 링크 제거한 설명 텍스트 추출
        const description = extractDescriptionFromReview(review);

        // URL이 없으면 공식 지원으로 판단
        const patchType = hasUrl ? 'user' : 'official';

        return {
            app_id: game.appid,
            game_title: '', // 큐레이터 덤프에는 타이틀이 없음
            steam_link: game.url || `https://store.steampowered.com/app/${game.appid}`,
            source_site_url: game.curator_url,
            patch_type: patchType,
            patch_links: hasUrl ? ['exist'] : [],
            patch_descriptions: hasUrl ? [description] : []
        };
    });
}

function extractDescriptionFromReview(review) {
    /**
     * 큐레이터 리뷰 텍스트에서 URL을 제거하고 나머지 텍스트만 반환
     */
    // URL 제거
    const urlPattern = /https?:\/\/[^\s"'<>]+/g;
    let text = review.replace(urlPattern, '');

    // "링크:" 문자열 제거 (URL 뒤에 남는 경우)
    text = text.replace(/링크\s*:/g, '');

    // 앞뒤 따옴표 제거
    text = text.replace(/^["']|["']$/g, '');

    // 여러 줄바꿈을 하나로, 앞뒤 공백 제거
    text = text.replace(/\n+/g, '\n').trim();

    // 끝에 남은 쉼표나 공백 정리
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

        // quasarzone -> quasarplay로 통합 (같은 퀘이사플레이 운영)
        const source = fileSource === 'quasarzone' ? 'quasarplay' : fileSource;

        for (const entry of data) {
            let appId = normalizeAppId(entry.app_id) || extractAppIdFromLink(entry.steam_link);

            if (appId && alias[appId]) {
                const originalId = alias[appId];
                console.log(`  [Alias] Normalizing ${appId} -> ${originalId}`);
                appId = originalId;
            }

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

                    if (!existing.source_site_urls) existing.source_site_urls = {};
                    const siteUrl = entry.source_site_url || entry.stove_url || entry.directg_url;
                    const hasLinksFromSource = entryLinks.length > 0;
                    // 큐레이터 소스는 official이어도 curator_url 보존 (확장프로그램에서 링크 표시용)
                    const isCuratorSource = source === 'quasarplay';
                    // 이미 존재하는 source_site_url은 덮어쓰지 않음 (첫 번째 것 유지)
                    if (siteUrl && !existing.source_site_urls[source] && (entry.patch_type !== 'official' || hasLinksFromSource || isCuratorSource)) {
                        existing.source_site_urls[source] = siteUrl;
                    }

                    // Preserve qp_appid from quasarplay source
                    if (source === 'quasarplay' && entry.qp_appid) {
                        existing.qp_appid = entry.qp_appid;
                    }
                } else {
                    const entryLinks = entry.patch_links || [];
                    const hasLinks = entryLinks.length > 0;
                    const siteUrl = entry.source_site_url || entry.stove_url || entry.directg_url;
                    // 큐레이터 소스는 official이어도 curator_url 보존
                    const isCuratorSource = source === 'quasarplay';
                    const shouldIncludeSiteUrl = siteUrl && (entry.patch_type !== 'official' || hasLinks || isCuratorSource);

                    const newEntry = {
                        app_id: appId,
                        game_title: entry.game_title,
                        steam_link: entry.steam_link || `https://store.steampowered.com/app/${appId}`,
                        patch_type: entry.patch_type || 'user',
                        patch_links: [...entryLinks],
                        patch_descriptions: [...(entry.patch_descriptions || [])],
                        patch_sources: entryLinks.map(() => source),
                        source_site_urls: shouldIncludeSiteUrl ? { [source]: siteUrl } : {},
                        sources: [source]
                    };

                    // Add qp_appid if available from quasarplay source
                    if (source === 'quasarplay' && entry.qp_appid) {
                        newEntry.qp_appid = entry.qp_appid;
                    }

                    mergedByAppId.set(appId, newEntry);
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

                    if (!existing.source_site_urls) existing.source_site_urls = {};
                    const siteUrl = entry.source_site_url || entry.stove_url || entry.directg_url;
                    const hasLinksFromSource = entryLinks.length > 0;
                    // 큐레이터 소스는 official이어도 curator_url 보존
                    const isCuratorSource = source === 'quasarplay';
                    // 이미 존재하는 source_site_url은 덮어쓰지 않음 (첫 번째 것 유지)
                    if (siteUrl && !existing.source_site_urls[source] && (entry.patch_type !== 'official' || hasLinksFromSource || isCuratorSource)) {
                        existing.source_site_urls[source] = siteUrl;
                    }
                } else {
                    const entryLinks = entry.patch_links || [];
                    const hasLinks = entryLinks.length > 0;
                    const siteUrl = entry.source_site_url || entry.stove_url || entry.directg_url;
                    // 큐레이터 소스는 official이어도 curator_url 보존
                    const isCuratorSource = source === 'quasarplay';
                    const shouldIncludeSiteUrl = siteUrl && (entry.patch_type !== 'official' || hasLinks || isCuratorSource);

                    noSteamLink.push({
                        game_title: entry.game_title,
                        patch_type: entry.patch_type || 'user',
                        patch_links: [...entryLinks],
                        patch_descriptions: [...(entry.patch_descriptions || [])],
                        patch_sources: entryLinks.map(() => source),
                        source_site_urls: shouldIncludeSiteUrl ? { [source]: siteUrl } : {},
                        sources: [source]
                    });
                    mergedByTitle.set(titleKey, noSteamLink[noSteamLink.length - 1]);
                }
            }
        }
    }

    const deduplicateLinksWithDescriptions = (links, descriptions, sources) => {
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

        return {
            links: resultLinks,
            descriptions: resultDescs,
            sources: resultSources
        };
    };

    const withSteamLink = Array.from(mergedByAppId.values()).map(entry => {
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
            sources: [...new Set(entry.sources)]
        };
    });

    const withoutSteamLink = noSteamLink.map(entry => {
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
        const lookupEntry = {
            type: game.patch_type,
            sources: game.sources,
            links: game.patch_links,
            patch_descriptions: game.patch_descriptions || [],
            patch_sources: game.patch_sources || [],
            source_site_urls: game.source_site_urls || {}
        };

        // Include qp_appid if available
        if (game.qp_appid) {
            lookupEntry.qp_appid = game.qp_appid;
        }

        lookupByAppId[game.app_id] = lookupEntry;
    }

    const lookupPath = path.join(DATA_DIR, 'lookup.json');
    await fs.writeFile(lookupPath, JSON.stringify(lookupByAppId, null, 2), 'utf-8');
    console.log(`Lookup table saved to ${lookupPath} (Games: ${withSteamLink.length})`);


    // Get alias.json modification time
    let aliasUpdatedAt = null;
    try {
        const aliasStats = await fs.stat(ALIAS_FILE);
        aliasUpdatedAt = aliasStats.mtime.toISOString();
    } catch (err) {
        console.log('No alias.json file, skipping alias timestamp');
    }

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
