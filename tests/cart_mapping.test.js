import test from 'node:test';
import assert from 'node:assert/strict';

import { mapCartEntries } from '../src/shared/cart-mapping.js';

test('maps live Steam cart identifiers without trusting DOM/API order', () => {
    const entries = [
        { appId: 4209630 },
        { appId: 1717940 },
        { bundleId: 43206 },
        { bundleId: 15759 },
        { appId: 1115050 },
        { appId: 200900 },
        { appId: 1717940 }
    ];
    const lineItems = [
        { line_item_id: '1', packageid: 615170 },
        { line_item_id: '2', packageid: 377472 },
        { line_item_id: '3', packageid: 12373 },
        { line_item_id: '4', packageid: 1474105 },
        { line_item_id: '5', bundleid: 43206 },
        { line_item_id: '6', bundleid: 15759 },
        { line_item_id: '7', packageid: 615170 }
    ];
    const packages = new Map([
        [4209630, [1474105]],
        [1717940, [615170]],
        [1115050, [377472]],
        [200900, [12373]]
    ]);

    assert.deepEqual(mapCartEntries(entries, lineItems, packages), [
        { id: 1474105, type: 'package' },
        { id: 615170, type: 'package' },
        { id: 43206, type: 'bundle' },
        { id: 15759, type: 'bundle' },
        { id: 377472, type: 'package' },
        { id: 12373, type: 'package' },
        { id: 615170, type: 'package' }
    ]);
});

test('fails closed when one app matches multiple remaining packages', () => {
    const result = mapCartEntries(
        [{ appId: 10 }, { appId: 20 }],
        [{ packageid: 100 }, { packageid: 200 }],
        new Map([[10, [100, 200]], [20, [200]]])
    );

    assert.equal(result[0], null);
    assert.deepEqual(result[1], { id: 200, type: 'package' });
});

test('prefers an exact line-item identifier when the DOM exposes it', () => {
    const result = mapCartEntries(
        [{ lineItemId: 'second', appId: 10 }, { lineItemId: 'first', appId: 20 }],
        [
            { line_item_id: 'first', packageid: 100 },
            { line_item_id: 'second', packageid: 200 }
        ]
    );

    assert.deepEqual(result, [
        { id: 200, type: 'package' },
        { id: 100, type: 'package' }
    ]);
});
