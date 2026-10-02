const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element() {
    return {
        children: [], style: {}, dataset: {}, className: '',
        classList: { add() {}, remove() {}, toggle() {} },
        setAttribute() {}, focus() {}, remove() { this.removed = true; },
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
    const output = element(), inputLine = element();
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        document: {
            body: element(), createElement: element, addEventListener() {},
            querySelector: selector => selector === '.system-output' ? output : selector === '.input-line' ? inputLine : selector === '.input-line .awakening-button' ? inputLine.querySelector('.awakening-button') : null,
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
    return { run, output, inputLine, saved: () => storage.get('gameState') };
}

for (const lang of ['zh', 'en']) {
    test(`${lang}: six completed memories advance 37.92% to 100%; only confirmation starts ending`, () => {
        const h = setup(null, lang);
        const button = h.inputLine.querySelector('.awakening-button');
        assert.equal(h.output.querySelector('.awakening-progress-percent').textContent, '37.92%');
        assert.equal(h.output.querySelector('.awakening-progress-blocks').textContent, '▮▮▮▮');
        assert.equal(button.hidden, true);
        button.onclick();
        assert.equal(h.run('endingCalls'), 0);
        const ids = h.run('AWAKENING_MEMORY_IDS');
        const expected = [37.92, 47.75, 59.02, 67.78, 79.87, 89.34, 100];
        ids.forEach((id, index) => {
            h.run(`handleFileClick({target: {closest: () => ({getAttribute: () => '${id}'})}})`);
            assert.equal(h.run('gameState.getAwakeningProgress()'), expected[index]);
            h.run(`onRead('${id}')`);
            assert.equal(h.run('gameState.getAwakeningProgress()'), expected[index + 1]);
            h.run(`onRead('${id}')`);
            assert.equal(h.run('gameState.getAwakeningProgress()'), expected[index + 1]);
            assert.equal(h.run(`cardManager.getCardById('${id}').is_read`), true);
        });
        assert.equal(h.output.querySelector('.awakening-progress-percent').textContent, '100.00%');
        assert.equal(button.hidden, false);
        assert.equal(h.run('endingCalls'), 0);
        button.onclick(); button.onclick();
        assert.equal(h.run('endingCalls'), 0);
        h.run('memoryDecay.awakeningModal.children[0].children[1].children[1].onclick()');
        assert.equal(h.run('endingCalls'), 0);
        assert.equal(button.disabled, undefined);
        button.onclick();
        h.run('var confirm = memoryDecay.awakeningModal.children[0].children[1].children[0]; confirm.onclick(); confirm.onclick()');
        assert.equal(h.run('memoryDecay.awakeningModal'), null);
        assert.equal(h.run('endingCalls'), 1);
        assert.equal(button.disabled, true);
    });
}

test('interrupted reading and reload preserve completed progress without counting opened memory', () => {
    const h = setup();
    h.run("gameState.markCardAsRead('mem_026'); handleFileClick({target:{closest:()=>({getAttribute:()=> 'mem_027'})}})");
    const restored = setup(h.saved());
    assert.equal(restored.run('gameState.getAwakeningProgress()'), 47.75);
    assert.equal(restored.run("cardManager.getCardById('mem_027').is_read"), false);
    restored.run("gameState.beginAwakening(); memoryDecay.startAwakeningProgress()");
    assert.equal(restored.run('gameState.getAwakeningProgress()'), 47.75);
    assert.equal(restored.run("memoryDecay.hiddenCards.has('mem_025')"), true);
});

test('100% save restores the button; unrelated memories do not increase progress', () => {
    const h = setup();
    h.run("gameState.markCardAsRead('mem_001')");
    assert.equal(h.run('gameState.getAwakeningProgress()'), 37.92);
    h.run('AWAKENING_MEMORY_IDS.forEach(id => gameState.markCardAsRead(id))');
    const restored = setup(h.saved());
    assert.equal(restored.inputLine.querySelector('.awakening-button').hidden, false);
    assert.equal(restored.run('endingCalls'), 0);
});


test('confirmed ending shuts down, holds black for four seconds, then shows subtitles', async () => {
    const h = setup();
    await h.run(`
        var events = [];
        window.ShutdownSequence = class { async start() { events.push('shutdown'); } };
        window.SubtitleSystem = class { show(text) { events.push(text); } };
        memoryDecay.delay = async ms => { events.push(ms); };
        memoryDecay.startEndingSequence = MemoryDecayEffect.prototype.startEndingSequence;
        memoryDecay.startEndingSequence();
    `);
    assert.deepEqual(Array.from(h.run('events')), ['shutdown', 4000, '山茶？', 3600, '是你吗……珂赛特？', 5800]);
    assert.equal(h.inputLine.querySelector('.awakening-button').disabled, true);
});

test('reading final memories in reverse order still reaches exactly 100 once each', () => {
    const h = setup();
    h.run('AWAKENING_MEMORY_IDS.slice().reverse().forEach(id => {gameState.markCardAsRead(id); gameState.markCardAsRead(id);})');
    assert.equal(h.run('gameState.getAwakeningProgress()'), 100);
});
