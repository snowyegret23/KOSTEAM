import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPage, settle } from './support/page.js';
import { environment } from './support/environments.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/store-samples.json', import.meta.url), 'utf8'));
const cases = JSON.parse(readFileSync(new URL('./fixtures/store-cases.json', import.meta.url), 'utf8'));
const labels = {
    'official-steam': ['공식 한국어', 'rgb(76, 154, 42)'],
    'official-with-user': ['공식(추가정보 존재)', 'rgb(76, 154, 42)'],
    official: ['공식지원 추정', 'rgb(56, 193, 152)'],
    'official-directg': ['다이렉트 게임즈', 'rgb(12, 124, 237)'],
    'official-stove': ['스토브', 'rgb(255, 129, 38)'],
    user: ['유저패치', 'rgb(185, 33, 255)'],
    none: ['한국어 없음', 'rgb(231, 76, 60)']
};
const sources = ['steamapp', 'quasarplay', 'directg', 'stove'];
const sourceLabels = ['한패넷', '퀘이사존 큐레이터', '다이렉트 게임즈', '스토브'];
const layout = environment.gamepad ? 'gamepad' : 'desktop';

test('sample inventory contains five distinct verified real games per label and four captures per game', () => {
    assert.deepEqual(fixture.failures, []);
    assert.equal(fixture.results.length, 35);
    assert.equal(new Set(fixture.results.map(sample => sample.appId)).size, 35);
    for (const [expected, ids] of Object.entries(cases)) {
        assert.equal(ids.length, 5);
        assert.deepEqual(fixture.results.filter(sample => sample.expected === expected).map(sample => sample.appId), ids);
    }
    for (const sample of fixture.results) {
        assert.ok(sample.title);
        assert.equal(sample.pages.length, 4);
        assert.equal(new Set(sample.pages.map(page => `${page.layout}/${page.language}`)).size, 4);
        for (const page of sample.pages) {
            assert.match(page.sha256, /^[a-f0-9]{64}$/);
            assert.equal(new URL(page.url).pathname, `/app/${sample.appId}/`);
            assert.ok(Number.isFinite(Date.parse(page.capturedAt)));
        }
    }
});

for (const sample of fixture.results) {
    for (const snapshot of sample.pages.filter(page => page.layout === layout)) {
        test(`[${sample.expected}] ${sample.appId} ${sample.title} / ${snapshot.language}: label, color, links, all 16 source settings and visibility`, async t => {
            const page = createPage(t, { html: snapshot.html, lang: snapshot.lang, url: snapshot.url, info: sample.info });
            if (environment.gamepad) page.document.querySelector('#game_area_purchase').style.display = 'none';
            const assertBanner = () => {
                const banner = page.document.querySelector('.kr-patch-banner');
                assert.ok(banner);
                assert.equal(page.document.querySelectorAll('.kr-patch-banner').length, 1);
                assert.equal(banner.closest('aside'), null);
                const label = banner.querySelector('.kr-patch-type-label');
                assert.equal(label.textContent, labels[sample.expected][0]);
                assert.ok(label.classList.contains(sample.expected));
                assert.equal(label.style.backgroundColor, labels[sample.expected][1]);
                if (environment.gamepad) {
                    const carousel = page.document.querySelector('#gamepadPurchaseOptions').closest('.full_width_carousel_container');
                    assert.equal(carousel.previousElementSibling, banner);
                    assert.equal(banner.closest('#game_area_purchase, .full_width_carousel_container'), null);
                }
                return banner;
            };
            await page.run();
            assertBanner();
            assert.ok(page.messages.every(message => message.appId === String(sample.appId)));
            for (let mask = 0; mask < 16; mask++) {
                await page.update(Object.fromEntries(sources.map((source, index) => [`source_${source}`, !!(mask & (1 << index))])));
                const banner = assertBanner();
                const links = [...banner.querySelectorAll('.kr-patch-link-text')];
                const expectedSources = sources.filter((source, index) => mask & (1 << index))
                    .filter(source => sample.info?.source_site_urls?.[source] &&
                        (sample.info.patch_sources?.includes(source) || (sample.expected === 'official' && sample.info.sources?.includes(source))));
                assert.equal(links.length, expectedSources.length, `source mask ${mask}`);
                for (const link of links) {
                    const source = expectedSources.find(value => sample.info.source_site_urls[value] === link.href);
                    assert.ok(source, link.href);
                    assert.equal(link.textContent, `[ ${sourceLabels[sources.indexOf(source)]} ]`);
                    assert.equal(link.target, source === 'quasarplay' && environment.gamepad ? '_self' : '_blank');
                    assert.equal(link.rel, 'noopener noreferrer');
                    assert.ok(!link.textContent.includes('undefined'));
                }
            }
            await page.update({ disable_patch_info: true });
            assert.equal(page.document.querySelector('.kr-patch-banner'), null);
            await page.update({ disable_patch_info: false });
            assertBanner();
        });
    }
    for (const lang of ['ja', 'fr', 'de', 'zh-CN', '']) {
        test(`[store language] ${sample.appId} / ${lang || 'missing'}: notice only and reversible display toggle`, async t => {
            const snapshot = sample.pages.find(page => page.layout === layout);
            const page = createPage(t, { html: snapshot.html, lang, url: snapshot.url, info: sample.info });
            await page.run();
            const banner = page.document.querySelector('.kr-patch-banner');
            assert.equal(banner?.textContent, '한국어 패치 정보를 확인하려면 상점 언어를 한국어 또는 영어로 변경하세요.');
            assert.equal(banner.querySelector('a, .kr-patch-type-label'), null);
            await page.update({ disable_patch_info: true });
            assert.equal(page.document.querySelector('.kr-patch-banner'), null);
        });
    }
    test(`[community] ${sample.appId}: correct store destination and no duplicate link`, async t => {
        const page = createPage(t, { url: `https://steamcommunity.com/app/${sample.appId}/discussions/`,
            html: '<div class="apphub_OtherSiteInfo"></div>' });
        await page.run('community');
        const link = page.document.querySelector('.kosteam-store-link');
        assert.equal(new URL(link.href).pathname.replace(/\/$/, ''), `/app/${sample.appId}`);
        page.document.body.append('Late community content');
        await settle();
        assert.equal(page.document.querySelectorAll('.kosteam-store-link').length, 1);
    });
}

for (const sample of fixture.results.filter(sample => sample.expected === 'user')) {
    test(`[loading/retry] ${sample.appId}: pending, failed and recovered lookup never reports no patch`, async t => {
        const snapshot = sample.pages.find(page => page.layout === layout);
        const replies = [];
        const page = createPage(t, { html: snapshot.html, lang: 'ko', url: snapshot.url,
            respond: () => new Promise(resolve => replies.push(resolve)) });
        await page.run();
        assert.equal(page.document.querySelector('.kr-patch-type-label')?.textContent, '정보 조회 중');
        replies.shift()({ success: false });
        await settle();
        assert.equal(page.document.querySelector('.kr-patch-type-label')?.textContent, '정보 조회 실패');
        await page.update({ kr_patch_data: {} });
        replies.shift()({ success: true, info: sample.info });
        await settle();
        assert.equal(page.document.querySelector('.kr-patch-type-label')?.textContent, '유저패치');
    });
    test(`[late layout] ${sample.appId}: purchase area can arrive after the lookup or be replaced`, async t => {
        const snapshot = sample.pages.find(page => page.layout === layout);
        const page = createPage(t, { html: snapshot.html, lang: 'ko', url: snapshot.url, info: sample.info });
        const main = page.document.querySelector('main');
        main.remove();
        await page.run();
        assert.equal(page.document.querySelector('.kr-patch-banner'), null);
        page.document.body.prepend(main);
        await settle();
        assert.equal(page.document.querySelector('.kr-patch-type-label')?.textContent, '유저패치');
        main.outerHTML = snapshot.html.match(/<main>[\s\S]*?<\/main>/)[0];
        await settle();
        assert.equal(page.document.querySelectorAll('.kr-patch-banner').length, 1);
    });
}
