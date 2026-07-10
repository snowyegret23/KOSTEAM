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
