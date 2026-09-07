export function parseCartPrice(text) {
    const pattern = /([₩$€£])\s*(\d(?:[\d.,\s]*\d)?)|(\d(?:[\d.,\s]*\d)?)\s*([₩$€£])/g;
    let result = null;
    for (const match of String(text || '').matchAll(pattern)) {
        const currency = match[1] || match[4];
        const raw = (match[2] || match[3]).replace(/\s/g, '');
        const decimal = currency !== '₩' && /[.,]\d{1,2}$/.test(raw);
        const split = decimal ? Math.max(raw.lastIndexOf(','), raw.lastIndexOf('.')) : raw.length;
        const whole = raw.slice(0, split);
        if (!/^\d+$/.test(whole) && !/^\d{1,3}(?:,\d{3})+$/.test(whole) &&
            !/^\d{1,3}(?:\.\d{3})+$/.test(whole)) return null;
        const value = Number(whole.replace(/[.,]/g, '') + (decimal ? `.${raw.slice(split + 1)}` : ''));
        if (!Number.isFinite(value)) return null;
        result = { value, currency };
    }
    return result;
}

export function keySetsEqual(actualKeys, expectedKeys) {
    const actual = countKeys(actualKeys);
    const expected = countKeys(expectedKeys);
    if (actual.size !== expected.size) return false;
    for (const [key, count] of expected) {
        if (actual.get(key) !== count) return false;
    }
    return true;
}

function countKeys(keys) {
    const counts = new Map();
    for (const key of keys.filter(Boolean)) {
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
}

export function waitForObservedCondition(options) {
    const {
        condition,
        observe,
        timeoutMs
    } = options;

    return new Promise(resolve => {
        let done = false;
        let timeoutTimer = null;
        let disconnect = null;

        const finish = value => {
            if (done) return;
            done = true;
            if (timeoutTimer) clearTimeout(timeoutTimer);
            if (disconnect) disconnect();
            resolve(value);
        };

        const check = () => {
            if (done) return;
            if (condition()) finish(true);
        };

        disconnect = observe(check);
        timeoutTimer = setTimeout(() => finish(false), timeoutMs);
        check();
    });
}

export function waitForKeySet(options) {
    const {
        expectedKeys,
        getCurrentKeys,
        observe,
        timeoutMs
    } = options;

    return waitForObservedCondition({
        condition: () => keySetsEqual(getCurrentKeys(), expectedKeys),
        observe,
        timeoutMs
    });
}
