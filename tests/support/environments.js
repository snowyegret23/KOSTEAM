export const environments = [
    { id: 'chrome', api: 'chrome', width: 1440, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/102.0.0.0 Safari/537.36' },
    { id: 'edge', api: 'chrome', width: 1440, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0' },
    { id: 'firefox', api: 'browser', width: 1440, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0' },
    { id: 'firefox-android', api: 'browser', width: 412, userAgent: 'Mozilla/5.0 (Android 14; Mobile; rv:142.0) Gecko/142.0 Firefox/142.0' },
    { id: 'steam-desktop', api: 'chrome', width: 1280, userAgent: 'Mozilla/5.0 Valve Steam Client Chrome/139.0.0.0 Safari/537.36' },
    { id: 'steam-gamepad', api: 'chrome', width: 1280, gamepad: true, userAgent: 'Mozilla/5.0 Valve Steam Gamepad Chrome/139.0.0.0 Safari/537.36' },
    { id: 'steam-tenfoot', api: 'chrome', width: 1920, gamepad: true, userAgent: 'Mozilla/5.0 Valve Steam Tenfoot Chrome/139.0.0.0 Safari/537.36' }
];

export const environment = environments.find(value => value.id === (process.env.KOSTEAM_TEST_ENV || 'chrome'));
if (!environment) throw new Error(`Unknown KOSTEAM_TEST_ENV: ${process.env.KOSTEAM_TEST_ENV}`);
