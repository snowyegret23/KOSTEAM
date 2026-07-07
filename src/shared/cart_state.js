export function keySetsEqual(actualKeys, expectedKeys) {
    const actual = new Set(actualKeys.filter(Boolean));
    const expected = new Set(expectedKeys.filter(Boolean));
    if (actual.size !== expected.size) return false;
    for (const key of expected) {
        if (!actual.has(key)) return false;
    }
    return true;
}

export function waitForObservedCondition(options) {
    const {
        condition,
        observe,
        timeoutMs,
        stableMs = 0
    } = options;

    return new Promise(resolve => {
        let done = false;
        let stableTimer = null;
        let timeoutTimer = null;
        let disconnect = null;

        const finish = value => {
            if (done) return;
            done = true;
            if (stableTimer) clearTimeout(stableTimer);
            if (timeoutTimer) clearTimeout(timeoutTimer);
            if (disconnect) disconnect();
            resolve(value);
        };

        const clearStableTimer = () => {
            if (!stableTimer) return;
            clearTimeout(stableTimer);
            stableTimer = null;
        };

        const check = () => {
            if (done) return;
            if (!condition()) {
                clearStableTimer();
                return;
            }
            if (stableMs <= 0) {
                finish(true);
                return;
            }
            if (!stableTimer) {
                stableTimer = setTimeout(() => {
                    stableTimer = null;
                    if (condition()) {
                        finish(true);
                    } else {
                        check();
                    }
                }, stableMs);
            }
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
        timeoutMs,
        stableMs = 0
    } = options;

    return waitForObservedCondition({
        condition: () => keySetsEqual(getCurrentKeys(), expectedKeys),
        observe,
        timeoutMs,
        stableMs
    });
}
