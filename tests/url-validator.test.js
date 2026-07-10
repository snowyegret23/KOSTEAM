import test from 'node:test';
import assert from 'node:assert/strict';

import { isValidCheckoutUrl, isValidSourceUrl } from '../src/shared/url-validator.js';

test('source URLs are restricted to each source HTTPS allowlist', () => {
    const valid = [
        ['steamapp', 'https://hanpe.net/game/1'],
        ['quasarplay', 'https://store.steampowered.com/app/1'],
        ['directg', 'https://www.directg.net/game/game_page.html?product_code=1'],
        ['stove', 'https://store.onstove.com/ko/games/1']
    ];
    for (const [source, url] of valid) {
        assert.equal(isValidSourceUrl(source, url), true, `${source}: ${url}`);
    }

    const invalid = [
        ['steamapp', 'http://hanpe.net/game/1'],
        ['steamapp', 'https://hanpe.net.evil.example/game/1'],
        ['steamapp', 'https://user:password@hanpe.net/game/1'],
        ['steamapp', 'https://hanpe.net:444/game/1'],
        ['unknown', 'https://hanpe.net/game/1'],
        ['stove', 'javascript:alert(1)']
    ];
    for (const [source, url] of invalid) {
        assert.equal(isValidSourceUrl(source, url), false, `${source}: ${url}`);
    }
});

test('checkout URLs require the exact trusted HTTPS host and path boundary', () => {
    assert.equal(isValidCheckoutUrl('https://checkout.steampowered.com/checkout'), true);
    assert.equal(isValidCheckoutUrl('https://checkout.steampowered.com/checkout/review?cart=1'), true);
    assert.equal(isValidCheckoutUrl('https://checkout.steampowered.com/checkout?purchasetype=self'), true);

    const invalid = [
        'https://store.steampowered.com/checkout',
        'https://checkout.steampowered.com.evil.example/checkout',
        'https://checkout.steampowered.com/checkout-now',
        'https://checkout.steampowered.com/checkout?purchasetype=',
        'https://checkout.steampowered.com/checkout/?purchasetype=updatebillinginfo&r=cart',
        'http://checkout.steampowered.com/checkout',
        'https://user:password@checkout.steampowered.com/checkout',
        'https://checkout.steampowered.com:444/checkout',
        'javascript:alert(1)'
    ];
    for (const url of invalid) {
        assert.equal(isValidCheckoutUrl(url), false, url);
    }
});
