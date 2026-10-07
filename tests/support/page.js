import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { rollup } from 'rollup';
import { environment } from './environments.js';

// Execute the actual extension bundles against DOM fixtures. Network and extension
// APIs are supplied by the fixture; rendering, events and observers run normally.
const bundles = Object.fromEntries(await Promise.all(
    ['content', 'search_bypass', 'community', 'popup', 'background', 'cart', 'cart_restore'].map(async name => {
        if (process.env.KOSTEAM_TEST_BUILT === '1') {
            const target = environment.api === 'browser' ? 'firefox' : 'chrome';
            return [name, readFileSync(new URL(`../../dist/${target}/${name}.js`, import.meta.url), 'utf8')];
        }
        const bundle = await rollup({ input: fileURLToPath(new URL(`../../src/${name}.js`, import.meta.url)) });
        try {
            const { output } = await bundle.generate({ format: 'iife' });
            return [name, output[0].code];
        } finally {
            await bundle.close();
        }
    })
));
export const settle = () => new Promise(resolve => setImmediate(resolve));

export function createPage(t, { html = '', lang = 'en', url = 'https://store.steampowered.com/app/42/',
    settings = {}, info = null, promiseApi = environment.api === 'browser', permissions = {}, permissionGranted = true, alarms = true, respond } = {}) {
    const dom = new JSDOM(`<!doctype html><html lang="${lang}"><body>${html}</body></html>`, {
        url, runScripts: 'outside-only', pretendToBeVisual: true
    });
    const { window } = dom;
    t.after(() => {
        window.dispatchEvent(new window.Event('pagehide'));
        window.close();
    });
    Object.defineProperty(window.navigator, 'userAgent', { value: environment.userAgent, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: environment.width, configurable: true });
    const local = { ...settings };
    const changes = [];
    const messages = [];
    const permissionRequests = [];
    const navigations = [];
    let messageHandler;
    const asynchronous = fn => (...args) => {
        if (promiseApi) return Promise.resolve(fn(...args));
        const callback = args.pop();
        Promise.resolve(fn(...args)).then(callback);
    };
    const api = {
        runtime: {
            id: 'test-extension',
            getURL: value => `chrome-extension://test-extension/${value}`,
            sendMessage: asynchronous(message => {
                messages.push(message);
                return respond ? respond(message) : { success: true, info };
            }),
            onMessage: { addListener: callback => { messageHandler = callback; } },
            onInstalled: { addListener() {} },
            onStartup: { addListener() {} }
        },
        storage: {
            local: {
                get: asynchronous(keys => Object.fromEntries(keys.map(key => [key, local[key]]))),
                set: asynchronous(values => Object.assign(local, values))
            },
            onChanged: { addListener: callback => changes.push(callback) }
        },
        ...(permissions === null ? {} : { permissions: {
            getAll: asynchronous(() => permissions),
            request: asynchronous(request => { permissionRequests.push(request); return permissionGranted; })
        } }),
        ...(alarms ? { alarms: { onAlarm: { addListener() {} } } } : {})
    };
    window[promiseApi ? 'browser' : 'chrome'] = api;
    window.console = { log() {}, error() {}, debug() {} };
    Object.assign(window, { TextEncoder, TextDecoder, AbortController });
    return {
        window, document: window.document, local, messages, navigations, permissionRequests,
        async run(script = 'content') {
            if (script === 'search_bypass') {
                // jsdom does not navigate. Capture replace() while retaining its DOM/events.
                vm.runInNewContext(bundles[script], {
                    window: {
                        location: Object.assign(new URL(url), { replace: value => navigations.push(value) }),
                        addEventListener: window.addEventListener.bind(window)
                    },
                    document: window.document, MutationObserver: window.MutationObserver,
                    URL, console: window.console, [promiseApi ? 'browser' : 'chrome']: api
                });
            } else {
                window.eval(bundles[script]);
            }
            await settle();
        },
        async update(values) {
            const updated = Object.fromEntries(Object.entries(values).map(([key, newValue]) =>
                [key, { oldValue: local[key], newValue }]));
            Object.assign(local, values);
            changes.forEach(callback => callback(updated, 'local'));
            await settle();
        },
        send: message => new Promise(resolve => messageHandler(message,
            { id: 'test-extension', url }, resolve))
    };
}
