import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { environments } from '../tests/support/environments.js';

await mkdir('test-results', { recursive: true });
const results = [];
for (const environment of environments) {
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap',
        'tests/dom-driven.test.js', 'tests/environment-features.test.js', 'tests/store-samples.test.js'], {
        env: { ...process.env, KOSTEAM_TEST_ENV: environment.id, KOSTEAM_TEST_BUILT: '1', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    await writeFile(`test-results/${environment.id}.tap`, output, 'utf8');
    const count = key => Number(output.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] || 0);
    const result = { environment: environment.id, validation: 'DOM and extension API simulation',
        tests: count('tests'), pass: count('pass'), fail: count('fail'), skipped: count('skipped'), code };
    results.push(result);
    console.log(JSON.stringify(result));
    if (code !== 0) console.error(output.split('\n').filter(line => /not ok|error:|expected:|actual:|location:/.test(line)).join('\n'));
}
await writeFile('test-results/matrix.json', JSON.stringify({ generatedAt: new Date().toISOString(),
    scope: 'Production Chrome/Firefox bundles in jsdom with simulated extension APIs, Steam events and viewport widths.',
    notExecuted: ['Native Chrome/Edge/Gecko extension loading', 'Android and Steam Deck devices',
        'Actual Steam/Extendium controller input and rendering', 'Real account purchases and cart mutations'], results }, null, 2) + '\n', 'utf8');
if (results.some(result => result.code !== 0 || result.tests === 0 || result.skipped !== 0)) process.exitCode = 1;
