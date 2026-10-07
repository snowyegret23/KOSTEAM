import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { load } from 'cheerio';

const cases = JSON.parse(await readFile('tests/fixtures/store-cases.json', 'utf8'));
const lookupBytes = await readFile('data/lookup.json');
const lookup = JSON.parse(lookupBytes);
const hash = value => createHash('sha256').update(value).digest('hex');
const refresh = process.argv.includes('--refresh');
const rawDirectory = 'test-results/live-store';
await mkdir(rawDirectory, { recursive: true });
const results = [];
const failures = [];

for (const [expected, appIds] of Object.entries(cases)) {
    if (appIds.length !== 5) throw new Error(`${expected}: exactly five distinct games are required`);
    for (const appId of appIds) {
        const sample = { appId, expected, info: lookup[appId] || null, pages: [] };
        for (const layout of ['desktop', 'gamepad']) {
            for (const language of ['koreana', 'english']) {
                const url = `https://store.steampowered.com/app/${appId}/?l=${language}&cc=kr`;
                const file = `${rawDirectory}/${appId}-${layout}-${language}`;
                try {
                    let raw, metadata;
                    if (!refresh) {
                        try { raw = await readFile(`${file}.html`, 'utf8'); metadata = JSON.parse(await readFile(`${file}.json`, 'utf8')); } catch {}
                    }
                    if (!raw || !metadata) {
                        await delay(600);
                        const response = await fetch(url, { signal: AbortSignal.timeout(25000), headers: {
                            'User-Agent': `Mozilla/5.0${layout === 'gamepad' ? ' Valve Steam Gamepad' : ' Chrome/140.0.0.0 Safari/537.36'} KOSTEAM-Tests/1.0 (+https://github.com/snowyegret23/KOSTEAM)`
                        } });
                        if (!response.ok) throw new Error(`HTTP ${response.status}`);
                        raw = await response.text();
                        metadata = { url: response.url, capturedAt: new Date().toISOString(), sha256: hash(raw) };
                        await writeFile(`${file}.html`, raw, 'utf8');
                        await writeFile(`${file}.json`, JSON.stringify(metadata), 'utf8');
                    }
                    if (metadata.sha256 !== hash(raw)) throw new Error('Raw capture does not match its SHA-256');
                    if (!new URL(metadata.url).pathname.startsWith(`/app/${appId}/`)) throw new Error(`Redirected to ${metadata.url}`);
                    const $ = load(raw);
                    const nativeTable = $('.game_language_options').first();
                    const cache = $('[data-featuretarget="apppage-store-browse-cache"]').first();
                    const payload = cache.length ? JSON.parse(cache.attr('data-props')) : null;
                    const storeItem = payload?.rgPayloads?.flatMap(value => value.rgStoreItems || []).find(value => value.item_type === 0 && String(value.id) === String(appId));
                    sample.title ||= storeItem?.name || $('.apphub_AppName').first().text().trim();
                    const koreanRow = nativeTable.find('tr').filter((index, row) => ['Korean', '한국어'].includes($(row).find('td').first().text().trim()));
                    const koreanFlags = storeItem?.supported_languages?.filter(value => value.elanguage === 4) || [];
                    const nativeKorean = layout === 'desktop'
                        ? !koreanRow.hasClass('unsupported') && koreanRow.find('td').slice(1).text().includes('✔')
                        : koreanFlags.some(value => ['supported', 'full_audio', 'subtitles'].some(key => value[key] === true || value[key] === 1));
                    if ($('html').attr('lang') !== (language === 'koreana' ? 'ko' : 'en')) throw new Error('Unexpected store language');
                    if (layout === 'desktop' && nativeTable.find('tr').length < 2) throw new Error('Desktop language table missing');
                    if (layout === 'gamepad' && (storeItem?.success !== 1 || !Array.isArray(storeItem.supported_languages) || !$('#gamepadPurchaseOptions').length)) throw new Error('Gamepad language data or purchase area missing');
                    const info = sample.info;
                    const observed = nativeKorean ? (info?.links?.length ? 'official-with-user' : 'official-steam')
                        : info?.sources?.includes('directg') ? 'official-directg'
                        : info?.sources?.includes('stove') ? 'official-stove'
                        : info?.type === 'official' ? 'official' : info ? 'user' : 'none';
                    if (observed !== expected) throw new Error(`Expected ${expected}, current evidence is ${observed}`);

                    // Retain Steam's actual insertion hierarchy and language markup, dropping unrelated page contents.
                    const legacy = $('#game_area_purchase').first().clone();
                    legacy.find('script, iframe, img, video').remove();
                    legacy.find('*').each((index, element) => {
                        for (const name of Object.keys(element.attribs || {})) {
                            if (!['id', 'class', 'style', 'hidden', 'href'].includes(name)) $(element).removeAttr(name);
                        }
                    });
                    let purchase = $.html(legacy);
                    if (layout === 'gamepad') {
                        const marker = $('#gamepadPurchaseOptions').first().clone().removeAttr('data-props');
                        const parent = $('#gamepadPurchaseOptions').parent().clone().empty().append(marker);
                        purchase = `<div class="game_background_glow">${$.html(parent)}</div>${purchase}`;
                    }
                    let languageMarkup = $.html(nativeTable);
                    if (cache.length && storeItem) {
                        const reducedCache = cache.clone().attr('data-props', JSON.stringify({ rgPayloads: [{ rgStoreItems: [{
                            item_type: storeItem.item_type, id: storeItem.id, success: storeItem.success,
                            supported_languages: storeItem.supported_languages
                        }] }] }));
                        languageMarkup += $.html(reducedCache);
                    }
                    sample.pages.push({ ...metadata, layout, language, lang: $('html').attr('lang'), nativeKorean,
                        html: `<main>${purchase}</main><aside>${languageMarkup}</aside>` });
                } catch (error) {
                    failures.push({ appId, layout, language, error: error.message });
                    console.error(JSON.stringify(failures.at(-1)));
                }
            }
        }
        results.push(sample);
        console.log(`${expected}: ${appId} ${sample.title || ''} (${sample.pages.length}/4)`);
    }
}
const report = { capturedAt: new Date().toISOString(), lookupSha256: hash(lookupBytes), results, failures };
await writeFile('test-results/live-store-report.json', JSON.stringify(report, null, 2) + '\n', 'utf8');
if (failures.length) process.exitCode = 1;
else await writeFile('tests/fixtures/store-samples.json', JSON.stringify(report, null, 2).replace(/\n/g, '\r\n') + '\r\n', 'utf8');
