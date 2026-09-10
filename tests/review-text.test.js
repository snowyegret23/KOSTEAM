import { removeReviewUrls } from '../scripts/review-text.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { removeUrls, convertEntry } from '../scrapers/hanpe.js';

const mergeSource = readFileSync(new URL('../scripts/merge.js', import.meta.url), 'utf8');
const context = vm.createContext({ removeReviewUrls });
vm.runInContext(mergeSource.slice(mergeSource.indexOf('function convertCuratorData('), mergeSource.indexOf('\nfunction normalizeAppId(')), context);

const cases = [
    ['한글 패치 - ExampleTranslators', '한글 패치 - ExampleTranslators'],
    ['한글 패치 - ExampleTeamss', '한글 패치 - ExampleTeamss'],
    ['설치 안내 (https://example.com/patch)', '설치 안내'],
    ['https://example.com/patch(설치 설명)', '(설치 설명)'],
    ['https://example.com/patch,제작자: 번역팀', ',제작자: 번역팀'],
    ['한글 패치 HTTPS://example.com/patch', '한글 패치'],
    ['한글 패치 https://example.com/wiki/Patch_(game)', '한글 패치'],
    ['한글 패치 https://example.com/(사이트 폐쇄)', '한글 패치 (사이트 폐쇄)'],
    ['한글 패치 [HTTPS://example.com/patch]', '한글 패치'],
    ['한글 패치 WWW.example.com/patch', '한글 패치'],
];

for (const [input, expected] of cases) {
    test(`hanpe text: ${input}`, () => assert.equal(removeUrls(input), expected));
    test(`merged review: ${input}`, () => assert.equal(context.extractDescriptionFromReview(input), expected));
}

test('hanpe preserves HTML anchor text and decodes entities', () => {
    assert.equal(removeUrls('<a href="https://example.com" target="_blank">번역 그룹</a> 제작 &amp; 검수'), '번역 그룹 제작 & 검수');
});

test('hanpe preserves literal angle-bracket labels and separates HTML lines', () => {
    assert.equal(removeUrls('<DLC> 타이탄퀘스트<TitanQuest><br>제작자'), '<DLC> 타이탄퀘스트<TitanQuest> 제작자');
});

test('hanpe keeps patch identities and support while cleaning descriptions', () => {
    const input = { appid: 42, patches: [{ support: 'official', url: 'https://example.com/patch', comment: '<a href="https://example.com">ExampleTranslators</a>' }] };
    const result = convertEntry(input);
    assert.equal(result.patch_type, 'official');
    assert.equal(result.patch_links.length, 1);
    assert.deepEqual(result.patch_descriptions, ['ExampleTranslators']);
    assert.deepEqual(result.patch_links, convertEntry({ ...input, patches: [{ ...input.patches[0], comment: 'ExampleTranslators' }] }).patch_links);
});

test('legacy curator URL detection accepts uppercase schemes', () => {
    const [result] = context.convertCuratorData({ games: [{ appid: '42', review: '한글 패치 HTTPS://example.com/patch' }] }, 'quasarplay');
    assert.equal(result.patch_type, 'user');
    assert.equal(result.patch_descriptions[0], '한글 패치');
});

test('curator snapshots do not retain unprocessed review text', () => {
    for (const source of ['quasarplay', 'quasarzone']) {
        const data = JSON.parse(readFileSync(new URL(`../data/${source}.json`, import.meta.url), 'utf8'));
        assert.ok(data.games.every(game => !Object.hasOwn(game, 'review_raw')));
    }
});

test('Python curator sanitizer preserves names and surrounding descriptions', () => {
    const script = `
import ast, json, re, sys
from pathlib import Path
tree = ast.parse(Path('scrapers/steam_curator_dump.py').read_text(encoding='utf-8'))
nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ('sanitize_review_text', 'remove_review_urls')]
scope = {'re': re}
exec(compile(ast.Module(body=nodes, type_ignores=[]), '<review-test>', 'exec'), scope)
cases = json.loads(sys.stdin.read())
for raw, expected in cases:
    actual, has_url, count = scope['sanitize_review_text'](raw)
    assert actual == expected, (raw, actual, expected)
    assert has_url == ('https://' in raw.lower() or 'www.' in raw.lower()), (raw, has_url)
    assert count == int(has_url), (raw, count)
`;
    const result = spawnSync('python', ['-B', '-c', script], {
        cwd: new URL('..', import.meta.url), input: JSON.stringify(cases), encoding: 'utf8',
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
    });
    assert.equal(result.status, 0, result.stderr);
});
