/**
 * Rollup configuration for KOSTEAM browser extension
 * Builds for both Chrome and Firefox from shared source
 */

import { nodeResolve } from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import copy from 'rollup-plugin-copy';

const isProduction = process.env.NODE_ENV === 'production';

// Shared input files
const inputs = ['background', 'content', 'popup', 'search_bypass', 'cart'];

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
            nodeResolve(),
            isProduction && terser({
                format: {
                    comments: false
                }
            }),
            // Only copy static files once per browser (on background.js build)
            name === 'background' && copy({
                targets: [
                    // Copy manifest (browser-specific)
                    {
                        src: `src/manifests/manifest.${browser}.json`,
                        dest: outputDir,
                        rename: 'manifest.json'
                    },
                    // Copy shared static files
                    { src: `${staticDir}/popup.html`, dest: outputDir },
                    { src: `${staticDir}/popup.css`, dest: outputDir },
                    { src: `${staticDir}/styles.css`, dest: outputDir },
                    { src: `${staticDir}/cart.css`, dest: outputDir },
                    { src: `${staticDir}/icons`, dest: outputDir }
                ],
                hook: 'writeBundle'
            })
        ].filter(Boolean)
    }));
}

export default [
    ...createConfig('chrome'),
    ...createConfig('firefox')
];
