const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function boot({ sdk, userAgent = 'Desktop', nativeFullscreen, webkitFullscreen,
    fullscreenElement = null } = {}) {
    const listeners = new Map();
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        navigator: { userAgent },
        document: {
            documentElement: { requestFullscreen: nativeFullscreen, webkitRequestFullscreen: webkitFullscreen },
            fullscreenElement,
            addEventListener(type, handler, capture = false) {
                if (!listeners.has(type)) listeners.set(type, new Map());
                listeners.get(type).set(handler, capture);
            },
            removeEventListener(type, handler) { listeners.get(type)?.delete(handler); }
        },
        matchMedia: () => ({ matches: false }),
        localStorage: { getItem: () => null },
        setTimeout() {}
    });
    vm.runInContext('window = globalThis', context);
    context.LumiMakerSdk = sdk;
    for (const file of ['js/app.js', 'js/opening.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
    }
    return {
        context, run: source => vm.runInContext(source, context),
        click({ isTrusted = true, target = {} } = {}) {
            for (const [handler, capture] of [...listeners.get('click') || []]) {
                assert.equal(capture, true, 'Catch clicks before controls stop propagation');
                handler({ isTrusted, target });
            }
        }
    };
}

for (const userAgent of ['Desktop', 'iPhone', 'Android']) {
    test(`platform waits for the first real click and requests host fullscreen once (${userAgent})`, () => {
        let requested = 0;
        const h = boot({
            userAgent,
            // 即使游戏文档已全屏，也要让宿主决定播放器状态。
            fullscreenElement: {},
            sdk: { requestFullscreen() { requested++; return Promise.resolve(); } },
            nativeFullscreen() { assert.fail('Platform must fullscreen its host'); }
        });
        assert.equal(requested, 0, 'Loading game scripts must not request fullscreen');
        h.click({ isTrusted: false });
        assert.equal(requested, 0, 'Scripted clicks must not consume the first player click');
        h.click();
        assert.equal(requested, 1, 'Do not await anything before the fullscreen request');
        h.click();
        assert.equal(requested, 1, 'Later clicks must not re-enter fullscreen after the player exits');
    });
}

for (const synchronous of [false, true]) {
    test(`host fullscreen refusal is handled without a document fallback (sync=${synchronous})`, async () => {
        const error = Object.assign(new Error('denied'), { code: 'FULLSCREEN_DENIED' });
        const h = boot({
            sdk: { requestFullscreen() { if (synchronous) throw error; return Promise.reject(error); } },
            nativeFullscreen() { assert.fail('Refusal must not fullscreen the iframe'); }
        });
        assert.equal(await h.run('requestGameFullscreen()'), false);
    });
}

test('fullscreen button works while reading and preserves gameplay mode', () => {
    let requested = 0;
    const h = boot({ sdk: { requestFullscreen() { requested++; return Promise.resolve(); } } });
    h.click({ target: { closest(selector) {
        assert.equal(selector, '.func-btn[data-mode="fullscreen"]');
        return {};
    } } });
    assert.equal(requested, 0, 'The first click on the manual button must not make two requests');
    h.run(`
        readingLockManager = { isLocked: () => true };
        currentMode = 'delete';
        handleFuncBtnClick({ currentTarget: { dataset: { mode: 'fullscreen' } }, target: {} });
    `);
    assert.equal(requested, 1);
    assert.equal(h.run('currentMode'), 'delete');
    h.click();
    assert.equal(requested, 1);
    h.run(`handleFuncBtnClick({ currentTarget: { dataset: { mode: 'fullscreen' } } });`);
    assert.equal(requested, 2, 'Manual fullscreen remains usable after the first click');
});

test('SDK injected after game scripts load is used on the first player click', () => {
    const h = boot({ nativeFullscreen() { assert.fail('Must use late-injected SDK'); } });
    let requested = 0;
    h.context.LumiMakerSdk = { requestFullscreen() { requested++; return Promise.resolve(); } };
    h.click();
    assert.equal(requested, 1);
});

test('standalone preview supports standard and legacy fullscreen methods', async () => {
    for (const key of ['nativeFullscreen', 'webkitFullscreen']) {
        let requested = 0;
        const h = boot({ userAgent: 'Android', [key]() { requested++; } });
        h.click();
        assert.equal(requested, 1);
    }
    const unsupported = boot();
    assert.equal(await unsupported.run('requestGameFullscreen()'), false);
});

test('unsupported fullscreen cannot interrupt the opening animation', async () => {
    const h = boot({ userAgent: 'iPhone', sdk: { requestFullscreen: () => Promise.reject(new Error('unsupported')) } });
    h.click();
    h.run(`
        var transitions = [];
        var opening = new OpeningScreen({ onComplete: () => transitions.push('complete') });
        opening.fadeOutOpening = async () => transitions.push('fade');
        opening.disableCRT = () => transitions.push('crt');
        opening.delay = async () => {};
        opening.playBootSequence = async () => transitions.push('boot');
        opening.showMainApp = async () => transitions.push('game');
    `);
    await h.run('opening.handleLogin()');
    assert.deepEqual(Array.from(h.run('transitions')), ['fade', 'crt', 'boot', 'game', 'complete']);
});

test('starting the opening without a click does not fullscreen; the next player click does', async () => {
    let requested = 0;
    const h = boot({ sdk: { requestFullscreen() { requested++; return Promise.resolve(); } } });
    h.run(`
        var opening = new OpeningScreen();
        opening.fadeOutOpening = async () => {};
        opening.disableCRT = () => {};
        opening.delay = async () => {};
        opening.playBootSequence = async () => {};
        opening.showMainApp = async () => {};
    `);
    // Enter 开场和程序调用共用该方法，不应隐式请求全屏。
    await h.run('opening.handleLogin()');
    assert.equal(requested, 0);
    h.click();
    assert.equal(requested, 1);
});

test('failed automatic fullscreen is not retried by normal clicks and manual retry still works', async () => {
    let requested = 0;
    const h = boot({ sdk: { requestFullscreen() {
        requested++;
        return requested === 1 ? Promise.reject(new Error('denied')) : Promise.resolve();
    } } });
    h.click();
    await Promise.resolve();
    h.click();
    assert.equal(requested, 1);
    h.run(`handleFuncBtnClick({ currentTarget: { dataset: { mode: 'fullscreen' } } });`);
    assert.equal(requested, 2);
});

test('platform and embedded play do not register a game service worker', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const registration = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
    for (const { embedded, sdk, expected } of [
        { embedded: false, sdk: undefined, expected: 1 },
        { embedded: true, sdk: undefined, expected: 0 },
        { embedded: true, sdk: {}, expected: 0 },
        { embedded: false, sdk: {}, expected: 0 }
    ]) {
        let registered = 0;
        const window = { LumiMakerSdk: sdk };
        window.self = window;
        window.top = embedded ? {} : window;
        vm.runInNewContext(registration, {
            window,
            navigator: { serviceWorker: { register(url) {
                assert.equal(url, './sw.js'); registered++; return Promise.resolve();
            } } }
        });
        assert.equal(registered, expected);
    }
});
