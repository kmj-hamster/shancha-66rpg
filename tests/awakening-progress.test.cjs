const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element() {
    return {
        children: [], style: {}, dataset: {}, className: '',
        classList: { add() {}, remove() {}, toggle() {} },
        setAttribute() {},
        append(...children) { this.children.push(...children); },
        appendChild(child) { this.children.push(child); },
        querySelector(selector) {
            for (const child of this.children) {
                if (child.className === selector.slice(1)) return child;
                const nested = child.querySelector(selector);
                if (nested) return nested;
            }
            return null;
        }
    };
}

function setup(saved, lang = 'zh') {
    const storage = new Map([['gameLang', lang]]);
    if (saved) storage.set('gameState', saved);
    const output = element();
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        document: {
            body: element(), createElement: element, addEventListener() {},
            querySelector: selector => selector === '.system-output' ? output : null,
            querySelectorAll: () => []
        },
        localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
        setInterval() { throw new Error('Awakening must not start a countdown'); }
    });
    vm.runInContext('window = globalThis', context);
    for (const file of [`data/cards-data-${lang}.js`, 'js/state.js', 'js/cards.js', 'js/reading-lock.js', 'js/app.js', 'js/memory-decay.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
    }
    const run = code => vm.runInContext(code, context);
    run(`
        gameState = new GameState();
        if (!gameState.loadState()) gameState.beginAwakening();
        cardManager = new CardManager(); cardManager.loadCards();
        readingLockManager = new ReadingLockManager(gameState);
        readingLockManager.disableInteractions = () => {};
        readingLockManager.enableInteractions = () => {};
        var onRead;
        renderer = { onReadingComplete: callback => { onRead = callback; } };
        memoryDecay = new MemoryDecayEffect({ enabled: false });
        refreshUI = () => memoryDecay.renderAwakeningProgress();
        var endingCalls = 0;
        memoryDecay.startEndingSequence = () => { endingCalls++; };
        memoryDecay.startAwakeningProgress();
    `);
    return { run, output, saved: () => storage.get('gameState') };
}

for (const lang of ['zh', 'en']) {
    test(`${lang}: six completed memories advance 40% to 100%; only button starts ending`, () => {
        const h = setup(null, lang);
        const button = h.output.querySelector('.awakening-button');
        assert.equal(h.output.querySelector('.awakening-progress-percent').textContent, '40%');
        assert.equal(h.output.querySelector('.awakening-progress-blocks').textContent, '▮▮▮▮');
        assert.equal(button.hidden, true);
        button.onclick();
        assert.equal(h.run('endingCalls'), 0);
        const ids = h.run('AWAKENING_MEMORY_IDS');
        ids.forEach((id, index) => {
            h.run(`handleFileClick({target: {closest: () => ({getAttribute: () => '${id}'})}})`);
            assert.equal(h.run('gameState.getAwakeningProgress()'), 40 + index * 10);
            h.run(`onRead('${id}')`);
            assert.equal(h.run('gameState.getAwakeningProgress()'), 50 + index * 10);
            h.run(`onRead('${id}')`);
            assert.equal(h.run('gameState.getAwakeningProgress()'), 50 + index * 10);
            assert.equal(h.run(`cardManager.getCardById('${id}').is_read`), true);
        });
        assert.equal(h.output.querySelector('.awakening-progress-percent').textContent, '100%');
        assert.equal(button.hidden, false);
        assert.equal(h.run('endingCalls'), 0);
        button.onclick(); button.onclick();
        assert.equal(h.run('endingCalls'), 1);
        assert.equal(button.disabled, true);
    });
}

test('interrupted reading and reload preserve completed progress without counting opened memory', () => {
    const h = setup();
    h.run("gameState.markCardAsRead('mem_026'); handleFileClick({target:{closest:()=>({getAttribute:()=> 'mem_027'})}})");
    const restored = setup(h.saved());
    assert.equal(restored.run('gameState.getAwakeningProgress()'), 50);
    assert.equal(restored.run("cardManager.getCardById('mem_027').is_read"), false);
    restored.run("gameState.beginAwakening(); memoryDecay.startAwakeningProgress()");
    assert.equal(restored.run('gameState.getAwakeningProgress()'), 50);
    assert.equal(restored.run("memoryDecay.hiddenCards.has('mem_025')"), true);
});

test('100% save restores the button; unrelated memories do not increase progress', () => {
    const h = setup();
    h.run("gameState.markCardAsRead('mem_001')");
    assert.equal(h.run('gameState.getAwakeningProgress()'), 40);
    h.run('AWAKENING_MEMORY_IDS.forEach(id => gameState.markCardAsRead(id))');
    const restored = setup(h.saved());
    assert.equal(restored.output.querySelector('.awakening-button').hidden, false);
    assert.equal(restored.run('endingCalls'), 0);
});
