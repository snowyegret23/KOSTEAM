import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/shared/api.js', import.meta.url), 'utf8').replaceAll('export ', '');
function apiContext(promiseApi, method) {
    const api = { runtime: {}, storage: { local: {}, session: {} }, permissions: {}, alarms: {} };
    for (const [object, methods] of [[api.runtime, ['sendMessage']], [api.storage.local, ['get', 'set']],
        [api.storage.session, ['get', 'set', 'remove']], [api.permissions, ['getAll', 'request']], [api.alarms, ['create', 'clear']]]) {
        for (const name of methods) object[name] = (...args) => method(api, name, args);
    }
    const context = vm.createContext({ [promiseApi ? 'browser' : 'chrome']: api, AbortController, setTimeout, clearTimeout });
    vm.runInContext(source, context);
    return { api, call: expression => vm.runInContext(expression, context) };
}

const calls = [
    ['sendMessage({type:"GET_PATCH_INFO"})', 'sendMessage'],
    ['storageGet(["key"])', 'get'], ['storageSet({key:1})', 'set'],
    ['storageSessionGet(["key"])', 'get'], ['storageSessionSet({key:1})', 'set'], ['storageSessionRemove(["key"])', 'remove'],
    ['permissionsGetAll()', 'getAll'], ['permissionsRequest({permissions:[]})', 'request'], ['alarmClear("expiry")', 'clear']
];
for (const promiseApi of [false, true]) {
    for (const [expression, expectedMethod] of calls) {
        test(`${promiseApi ? 'Firefox promise' : 'Chromium callback'} API: ${expression}`, async () => {
            const fixture = apiContext(promiseApi, (api, method, args) => {
                assert.equal(method, expectedMethod);
                if (promiseApi) {
                    assert.ok(args.every(arg => typeof arg !== 'function'));
                    return Promise.resolve('response');
                }
                args.at(-1)('response');
            });
            assert.equal(await fixture.call(expression), 'response');
        });
    }
    for (const mode of ['synchronous exception', 'API rejection']) {
        test(`${promiseApi ? 'Firefox' : 'Chromium'} API: ${mode} propagates instead of hanging`, async () => {
            const fixture = apiContext(promiseApi, (api, method, args) => {
                if (mode === 'synchronous exception') throw new Error('test unavailable');
                if (promiseApi) return Promise.reject(new Error('test unavailable'));
                api.runtime.lastError = { message: 'test unavailable' };
                args.at(-1)();
                delete api.runtime.lastError;
            });
            await assert.rejects(fixture.call('sendMessage({})'), /test unavailable/);
        });
    }
    test(`${promiseApi ? 'Firefox' : 'Chromium'} API: optional startup and alarm listeners may be absent`, () => {
        const fixture = apiContext(promiseApi, () => {});
        delete fixture.api.alarms;
        assert.doesNotThrow(() => fixture.call('onStartup(() => {}); onAlarm(() => {})'));
    });
}

test('Chromium hybrid API settles once when both callback and promise respond', async () => {
    const fixture = apiContext(false, (api, method, args) => {
        args.at(-1)('callback');
        return Promise.reject(new Error('late rejection'));
    });
    assert.equal(await fixture.call('sendMessage({})'), 'callback');
});

for (const preAborted of [false, true]) {
    test(`request timeout respects ${preAborted ? 'parent cancellation' : 'its deadline'}`, async () => {
        const fixture = apiContext(true, () => {});
        const result = await fixture.call(`(() => {
            const parent = new AbortController();
            ${preAborted ? 'parent.abort();' : ''}
            return withRequestTimeout(signal => new Promise(resolve => {
                if (signal.aborted) resolve('aborted');
                else signal.addEventListener('abort', () => resolve('aborted'), {once:true});
            }), 5, parent.signal);
        })()`);
        assert.equal(result, 'aborted');
    });
}
