import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'quasarplay.json');

const BASE_URL = 'https://quasarplay.com/bbs/qp_korean';
const MAX_PAGES = 100;

puppeteer.use(StealthPlugin());

const delay = ms => new Promise(r => setTimeout(r, ms));

class CaptchaService {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.endpoint = 'https://api.2captcha.com';
    }

    async request(path, body = {}) {
        if (!body.clientKey) {
            body.clientKey = this.apiKey;
        }

        const response = await fetch(`${this.endpoint}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        const result = await response.json();
        if (result.errorId && result.errorId > 0) {
            throw new Error(`${result.errorId}: ${result.errorDescription}`);
        }
        return result;
    }

    async createTask(type, websiteURL, websiteKey) {
        return await this.request('/createTask', {
            task: { type, websiteURL, websiteKey }
        });
    }

    async getTaskResult(taskId) {
        return await this.request('/getTaskResult', { taskId });
    }

    async getBalance() {
        return await this.request('/getBalance');
    }

    async solve(type, websiteURL, websiteKey, retries = 30, timeout = 5000) {
        try {
            const { taskId } = await this.createTask(type, websiteURL, websiteKey);
            console.log(`Captcha task created: ${taskId}`);

            let response = null;
            while (!response && retries-- > 0) {
                await delay(timeout);
                const result = await this.getTaskResult(taskId);
                console.log(`Checking task ${taskId}: ${result.status}`);

                if (result.status === 'ready') {
                    response = result.solution.token || result.solution.gRecaptchaResponse;
                } else if (result.errorId > 0) {
                    throw new Error(`Captcha error: ${result.errorDescription}`);
                }
            }

            if (!response) {
                throw new Error('Captcha solve timed out');
            }

            return response;
        } catch (error) {
            console.error('Captcha solve failed:', error.message);
            return null;
        }
    }
}

async function loadExistingData() {
    try {
        const content = await fs.readFile(OUTPUT_FILE, 'utf-8');
        return JSON.parse(content);
    } catch {
        return [];
    }
}

function extractSteamAppId(onclickAttr) {
    if (!onclickAttr) return null;
    const match = onclickAttr.match(/store\.steampowered\.com\/app\/(\d+)/);
    return match ? match[1] : null;
}

async function findSiteKey(page) {
    try {
        const siteKey = await page.evaluate(() => {
            const el = document.querySelector('.cf-turnstile, .g-recaptcha');
            if (el) return el.getAttribute('data-sitekey');
            return null;
        });
        if (siteKey) return siteKey;
    } catch (e) { }

    const frames = page.frames();
    for (const frame of frames) {
        try {
            const src = frame.url();
            if (src.includes('challenges.cloudflare.com') || src.includes('recaptcha')) {
                const url = new URL(src);
                const key = url.searchParams.get('sitekey') || url.searchParams.get('k');
                if (key) return key;
            }
        } catch (e) { }
    }

    return null;
}

async function handleCaptcha(page, service) {
    if (!service) return false;

    console.log('Attempting to detect and solve CAPTCHA...');
    await delay(2000);

    const siteKey = await findSiteKey(page);

    if (siteKey) {
        console.log(`Found SiteKey: ${siteKey}`);

        const isTurnstile = await page.evaluate(() => !!document.querySelector('.cf-turnstile') || window.turnstile);
        const taskType = isTurnstile ? 'TurnstileTaskProxyless' : 'RecaptchaV2TaskProxyless';

        console.log(`Solving ${taskType}...`);
        const token = await service.solve(taskType, page.url(), siteKey);

        if (token) {
            console.log('Token obtained. Injecting...');

            await page.evaluate((token) => {
                const turnstileInput = document.querySelector('input[name="cf-turnstile-response"]');
                const challengeInput = document.querySelector('input[name="cf-challenge-response"]');
                const recaptchaInput = document.querySelector('input[name="g-recaptcha-response"]');

                if (turnstileInput) turnstileInput.value = token;
                if (challengeInput) challengeInput.value = token;
                if (recaptchaInput) recaptchaInput.value = token;

                [turnstileInput, challengeInput, recaptchaInput].forEach(el => {
                    if (el) {
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                });
            }, token);

            console.log('Waiting for redirection...');
            await delay(5000);

            return true;
        } else {
            console.log('Failed to get token from 2Captcha.');
        }
    } else {
        console.log('Could not find SiteKey on the page.');
        const frames = page.frames();
        console.log(`Debug: Found ${frames.length} frames.`);
        frames.forEach(f => console.log(`- Frame: ${f.url()}`));
    }

    return false;
}

function parseDetailInfo(infoHtml) {
    const patches = [];
    if (!infoHtml) return patches;

    const lines = infoHtml.split(/<\/?p>/).map(s => s.trim()).filter(Boolean);

    let currentPatch = null;

    for (const line of lines) {
        const cleanLine = line.replace(/<br\s*\/?>/gi, '').trim();
        if (!cleanLine) continue;

        if (cleanLine.startsWith('유저 한글 패치') || cleanLine.startsWith('공식 한글')) {
            if (currentPatch && currentPatch.link) {
                patches.push(currentPatch);
            }
            currentPatch = { desc: cleanLine, link: '' };
        } else {
            const linkMatch = cleanLine.match(/href="([^"]+)"/);
            if (linkMatch && currentPatch) {
                currentPatch.link = linkMatch[1];
                patches.push(currentPatch);
                currentPatch = { desc: '', link: '' };
            } else if (cleanLine.startsWith('http') && currentPatch) {
                currentPatch.link = cleanLine;
                patches.push(currentPatch);
                currentPatch = { desc: '', link: '' };
            }
        }
    }

    if (currentPatch && currentPatch.link) {
        patches.push(currentPatch);
    }

    return patches;
}

async function scrapePage(page, pageNum, captchaService) {
    const url = `${BASE_URL}?page=${pageNum}`;
    console.log(`Fetching: ${url}`);

    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        let title = await page.title();
        console.log(`Page Title: ${title}`);

        if (title.includes('Cloudflare') || title.includes('Attention Required') || title.includes('Just a moment')) {
            console.log('Cloudflare challenge detected! initiating solver...');
            await handleCaptcha(page, captchaService);

            await delay(5000);
            title = await page.title();
            console.log(`Page Title after solve attempt: ${title}`);
        }

        try {
            await page.waitForSelector('table tbody tr.item', { timeout: 10000 });
        } catch (e) {
            console.log(`No games found on page ${pageNum} (selector timeout).`);
            return [];
        }

        const html = await page.content();
        const $ = cheerio.load(html);
        const games = [];

        $('table tbody tr.item').each((_, el) => {
            const $row = $(el);

            const typeText = $row.find('td.type_area span.type').text().trim();
            const patchType = typeText.includes('유저') ? 'user' : 'official';

            const $details = $row.find('td.details-control');

            const $thumbnail = $details.find('.thumbnail_wrapper');
            const onclickAttr = $thumbnail.attr('onclick') || '';
            const steamAppId = extractSteamAppId(onclickAttr);

            const gameTitle = $details.find('p.title').text().trim() || '';

            const $downloadLink = $details.find('p.download_link a.forward');
            const mainPatchLink = $downloadLink.attr('href') || '';

            const producerSpans = $details.find('p.producer span').not('.colorGray3');
            const producer = producerSpans.text().trim() || '';

            const steamLink = steamAppId ? `https://store.steampowered.com/app/${steamAppId}` : '';

            const rowId = $row.attr('id');
            const korId = rowId ? rowId.replace('kr_', '') : '';
            const $detailRow = $(`#kr_detail_${korId}`);

            const patchLinks = [];
            const patchDescriptions = [];

            if ($detailRow.length) {
                const infoHtml = $detailRow.find('td.info').html() || '';
                const detailPatches = parseDetailInfo(infoHtml);

                for (const patch of detailPatches) {
                    if (patch.link) {
                        patchLinks.push(patch.link);
                        patchDescriptions.push(patch.desc || '');
                    }
                }
            }

            if (patchLinks.length === 0 && mainPatchLink) {
                patchLinks.push(mainPatchLink);
                patchDescriptions.push(producer ? `제작자: ${producer}` : '');
            }

            if (gameTitle) {
                games.push({
                    source: 'quasarplay',
                    app_id: steamAppId,
                    game_title: gameTitle,
                    steam_link: steamLink,
                    source_site_url: `${BASE_URL}?game_name=${encodeURIComponent(gameTitle)}`,
                    patch_type: patchType,
                    patch_links: patchLinks,
                    patch_descriptions: patchDescriptions,
                    description: '',
                    updated_at: new Date().toISOString()
                });
            }
        });

        return games;
    } catch (err) {
        console.error(`Error scraping page ${pageNum}:`, err.message);
        return [];
    }
}

async function scrapeAll(existingMap) {
    const allGames = new Map();
    let consecutiveDuplicates = 0;
    const DUPLICATE_THRESHOLD = 3;

    const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox'];

    let proxyUrl = null;
    if (process.env.QUASARPLAY_PROXY) {
        try {
            proxyUrl = new URL(process.env.QUASARPLAY_PROXY);
            launchArgs.push(`--proxy-server=${proxyUrl.protocol}//${proxyUrl.host}`);
            console.log(`Using Proxy: ${proxyUrl.protocol}//${proxyUrl.host}`);
        } catch (e) {
            console.error('Invalid QUASARPLAY_PROXY URL:', e.message);
        }
    }

    let captchaService = null;
    if (process.env.TWO_CAPTCHA_API_KEY) {
        captchaService = new CaptchaService(process.env.TWO_CAPTCHA_API_KEY);
        console.log('2Captcha Manual Service Configured');
        try {
            const balance = await captchaService.getBalance();
            console.log(`2Captcha Balance: ${balance.balance}`);
        } catch (e) {
            console.error('Failed to check 2Captcha balance:', e.message);
        }
    }

    const browser = await puppeteer.launch({
        headless: "new",
        args: launchArgs
    });
    const page = await browser.newPage();

    if (proxyUrl && proxyUrl.username && proxyUrl.password) {
        await page.authenticate({
            username: decodeURIComponent(proxyUrl.username),
            password: decodeURIComponent(proxyUrl.password)
        });
    }

    if (process.env.QUASARPLAY_COOKIE) {
        const cookieStr = process.env.QUASARPLAY_COOKIE;
        const cookies = cookieStr.split(';')
            .map(part => part.trim())
            .filter(part => part.includes('='))
            .map(part => {
                const [name, ...valueParts] = part.split('=');
                return {
                    name: name.trim(),
                    value: valueParts.join('=').trim(),
                    domain: '.quasarplay.com'
                };
            });

        if (cookies.length > 0) {
            await page.setCookie(...cookies);
            console.log(`Loaded ${cookies.length} cookies from env.`);
        }
    }

    await page.setViewport({ width: 1920, height: 1080 });

    try {
        for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
            const games = await scrapePage(page, pageNum, captchaService);

            if (games.length === 0) {
                console.log(`No games found on page ${pageNum}, stopping.`);
                break;
            }

            let newGamesOnPage = 0;
            for (const game of games) {
                const key = game.app_id || game.game_title;
                if (!allGames.has(key) && !existingMap.has(key)) {
                    allGames.set(key, game);
                    newGamesOnPage++;
                } else if (!allGames.has(key)) {
                    allGames.set(key, game);
                }
            }

            console.log(`Page ${pageNum}: ${games.length} games (${newGamesOnPage} new)`);

            if (newGamesOnPage === 0) {
                consecutiveDuplicates++;
                if (consecutiveDuplicates >= DUPLICATE_THRESHOLD) {
                    console.log(`${DUPLICATE_THRESHOLD} consecutive pages with no new games, stopping.`);
                    break;
                }
            } else {
                consecutiveDuplicates = 0;
            }

            await delay(1000 + Math.random() * 2000);
        }
    } finally {
        await browser.close();
    }

    return Array.from(allGames.values());
}

async function main() {
    console.log('Starting quasarplay.com scraper (Puppeteer + Manual 2Captcha)...');

    await fs.mkdir(DATA_DIR, { recursive: true });

    const existingData = await loadExistingData();
    const existingMap = new Map(existingData.map(g => [g.app_id || g.game_title, g]));

    const newData = await scrapeAll(existingMap);

    for (const game of newData) {
        const key = game.app_id || game.game_title;
        existingMap.set(key, game);
    }

    const merged = Array.from(existingMap.values());

    await fs.writeFile(OUTPUT_FILE, JSON.stringify(merged, null, 2), 'utf-8');
    console.log(`Saved ${merged.length} games to ${OUTPUT_FILE}`);
}

main().catch(console.error);
