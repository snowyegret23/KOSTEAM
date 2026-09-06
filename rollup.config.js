/**
 * Rollup configuration for KOSTEAM browser extension
 * Builds for both Chrome and Firefox from shared source
 */

import terser from '@rollup/plugin-terser';
import { copyFile, cp } from 'node:fs/promises';

const isProduction = process.env.NODE_ENV === 'production';

// Shared input files
const inputs = ['background', 'content', 'popup', 'search_bypass', 'cart', 'cart_restore', 'community'];

/**
 * Create rollup config for a specific browser target
 * @param {'chrome' | 'firefox'} browser - Target browser
 * @returns {Object[]} Rollup configuration array
 */
function createConfig(browser) {
    const outputDir = browser === 'chrome' ? 'dist/chrome' : 'dist/firefox';
    const staticDir = 'src/static';

    return inputs.map(name => ({
        input: `src/${name}.js`,
        output: {
            file: `${outputDir}/${name}.js`,
            format: 'iife',
            sourcemap: !isProduction
        },
        plugins: [
            isProduction && terser({
                format: {
                    comments: false
                }
            }),
            // Only copy static files once per browser (on background.js build)
            name === 'background' && {
                name: 'copy-static',
                async writeBundle() {
                    await cp(staticDir, outputDir, { recursive: true });
                    await copyFile(`src/manifests/manifest.${browser}.json`, `${outputDir}/manifest.json`);
                }
            }
        ].filter(Boolean)
    }));
}

export default [
    ...createConfig('chrome'),
    ...createConfig('firefox')
];
