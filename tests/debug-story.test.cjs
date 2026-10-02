const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function boot(query, storage = new Map([['gameState', 'original save'], ['saveTime', 'original time']])) {
    const listeners = [], children = [];
    const context = vm.createContext({URL, URLSearchParams, console,
        location: {search: query, href: 'http://localhost/index.html' + query},
        history: {replaceState(a,b,url) { context.location.search = url.search; context.location.href = url.href; }},
        document: {addEventListener(event, cb) {listeners.push(cb);}, body: {appendChild(el) {children.push(el);}},
            createElement() {return {style: {}, children: [], appendChild(el) {this.children.push(el);}};}},
        localStorage: {getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k)}
    });
    vm.runInContext('window = globalThis', context);
    for (const file of ['js/state.js', 'js/debug-skip.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
    return {storage, context, children, listeners, run: code => vm.runInContext(code, context)};
}
test('normal play has no debug panel and cannot seed a checkpoint', () => {
    const h = boot('');
    assert.equal(h.listeners.length, 0);
    assert.throws(() => h.run('seedDebugStory("ready")'));
    assert.equal(h.storage.get('gameState'), 'original save');
});
for (const [stage, phase, progress] of [['awakening','awakening',37.92], ['reading','final_reading',37.92], ['reading90','final_reading',89.34], ['ready','final_reading',100], ['ending','ending',100]]) {
    test(stage + ' checkpoint resumes with isolated progress and survives refresh', () => {
        const h = boot('?debug=1&debugStage=' + stage);
        h.run('var s = new GameState(); s.loadState()');
        assert.equal(h.run('s.getStoryPhase()'), phase);
        assert.equal(h.run('s.getAwakeningProgress()'), progress);
        assert.equal(h.context.location.search, '?debug=1');
        const saved = h.storage.get('gameState_debug');
        boot('?debug=1', h.storage);
        assert.equal(h.storage.get('gameState_debug'), saved);
        h.listeners[0]();
        const buttons = h.children[0].children.slice(1);
        assert.equal(buttons.length, 6);
        buttons[5].onclick();
        assert.equal(h.context.location.href, 'http://localhost/index.html');
        h.run('s.clearSavedState()');
        assert.equal(h.storage.has('gameState_debug'), false);
        assert.equal(h.storage.get('gameState'), 'original save');
        assert.equal(h.storage.get('saveTime'), 'original time');
    });
}
