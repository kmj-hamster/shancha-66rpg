const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function node() {
    const listeners = new Map();
    return {
        style: {}, dataset: {}, children: [], classList: { add() {}, remove() {}, toggle() {} },
        querySelector() { return null; }, querySelectorAll() { return []; },
        appendChild(child) { this.children.push(child); },
        addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
        removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
        dispatch(type, event) { for (const fn of [...(listeners.get(type) || [])]) fn(event); }
    };
}

function boot(saved, lang = 'zh') {
    const storage = new Map([['gameLang', lang]]), timers = [];
    if (saved) storage.set('gameState', JSON.stringify(saved));
    const document = node(); document.body = node(); document.createElement = node;
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} }, document,
        localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
        setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        clearTimeout() {}
    });
    vm.runInContext('window = globalThis', context);
    for (const file of [`data/cards-data-${lang}.js`, 'js/state.js', 'js/cards.js', 'js/unlock.js',
        'js/reading-lock.js', 'js/render.js', 'js/app.js', 'js/memory-decay.js', 'js/ending.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
    }
    const run = source => vm.runInContext(source, context);
    run(`
        gameState = new GameState(); gameState.loadState();
        cardManager = new CardManager(); cardManager.loadCards();
        unlockManager = new UnlockManager(cardManager, gameState);
        renderer = new Renderer();
        readingLockManager = new ReadingLockManager(gameState);
        readingLockManager.disableInteractions = () => {};
        readingLockManager.enableInteractions = () => {};
        refreshUI = () => {}; showFeedback = () => {}; clearConfirmPrompt = () => {};
        gameState.reconcileProgress(cardManager.getAllCards(), COMMAND_UNLOCK_MAP);
        gameState.saveState(); syncStateToCardManager();
    `);
    return {
        run, timers, context, document,
        save: () => JSON.parse(storage.get('gameState')),
        open(id) {
            run(`handleFileClick({target:{closest:()=>({getAttribute:()=> '${id}'})}});
                renderer.setCurrentCard('${id}');
                renderer.createReadingController([document.createElement('p'), document.createElement('p')], cardManager.getCardById('${id}'));
            `);
        }
    };
}

for (const lang of ['zh', 'en']) {
    const fixture = boot(null, lang).run('cardManager.getAllCards()');
    const edges = fixture.filter(card => card.type === 'file').flatMap(child =>
        (child.unlock_by || []).filter(id => fixture.some(card => card.id === id)).map(parent => [parent, child.id]));

    test(`${lang}: all ${fixture.length} cards remain unread if opened and interrupted`, () => {
        for (const card of fixture) {
            const h = boot({ discovered_cards: [card.id], unlocked_cards: [card.id] }, lang);
            h.open(card.id);
            assert.equal(h.save().read_cards.includes(card.id), false, card.id);
        }
    });

    test(`${lang}: repair all ${edges.length} read-triggered edges without bypassing questions`, () => {
        for (const [parent, child] of edges) {
            const h = boot({ read_cards: [parent], unlocked_cards: [parent], discovered_cards: [parent] }, lang);
            const saved = h.save();
            assert.ok(saved.discovered_cards.includes(child), `${parent} -> ${child}`);
            const isQuestion = fixture.find(card => card.id === child).unlock_type === 'question';
            assert.equal(saved.unlocked_cards.includes(child), !isQuestion, child);
            h.run('gameState.reconcileProgress(cardManager.getAllCards(), COMMAND_UNLOCK_MAP); gameState.saveState()');
            assert.deepEqual(h.save(), saved, 'repair must be idempotent');
        }
    });

    test(`${lang}: all reading edges recover after interruption and commit together on completion`, () => {
        for (const [parent, child] of edges) {
            const before = boot({ unlocked_cards: [parent], discovered_cards: [parent] }, lang);
            before.open(parent);
            assert.equal(before.save().read_cards.includes(parent), false);
            const h = boot(before.save(), lang);
            h.open(parent);
            h.run('renderer.lineByLineController.showNext()');
            const saved = h.save();
            assert.ok(saved.read_cards.includes(parent), parent);
            assert.ok(saved.discovered_cards.includes(child), child);
            assert.equal(h.run('readingLockManager.isLocked()'), false);
        }
    });

    test(`${lang}: all four questions resume after correct answer but before supplemental reading`, () => {
        for (const card of fixture.filter(card => card.unlock_type === 'question')) {
            const h = boot({ discovered_cards: [card.id] }, lang);
            const answer = Array.isArray(card.unlock_condition.answer) ? card.unlock_condition.answer[0] : card.unlock_condition.answer;
            assert.equal(h.run(`unlockManager.verifyAnswer('${card.id}', ${JSON.stringify(answer)}).correct`), true);
            assert.equal(h.save().read_cards.includes(card.id), false);
            const restored = boot(h.save(), lang);
            restored.open(card.id);
            restored.run('renderer.lineByLineController.showNext()');
            assert.ok(restored.save().read_cards.includes(card.id));
        }
    });
}

test('automatic sequence completion commits without another click; repeated callbacks are harmless', () => {
    const h = boot({ unlocked_cards: ['mem_023'], discovered_cards: ['mem_023'] });
    h.open('mem_023');
    h.run(`var c = renderer.lineByLineController; c.isAutoPlaying = true; c.blockInput = true; c.lastShowNextTime = Date.now();
        c.autoPlayQueue = []; c.playNextAuto(100);`);
    assert.ok(h.save().read_cards.includes('mem_023'));
    assert.ok(h.save().discovered_cards.includes('file_018'));
    const saved = h.save();
    h.run('renderer.triggerReadingComplete(); c.notifyCompletion()');
    assert.deepEqual(h.save(), saved);
});

test('preview completion and abandoned controller callbacks cannot mark a card read', () => {
    const h = boot({ discovered_cards: ['file_018', 'mem_001'], unlocked_cards: ['mem_001'] });
    h.open('file_018');
    h.run('var previewCalls = 0; var old = renderer.lineByLineController; old.onPreviewComplete = () => { previewCalls++; }; old.showNext()');
    assert.equal(h.save().read_cards.includes('file_018'), false);
    h.open('mem_001');
    for (const timer of h.timers) timer.fn();
    h.run('old.playNextAuto(100); old.notifyCompletion()');
    assert.equal(h.run('previewCalls'), 0);
    assert.equal(h.save().read_cards.includes('mem_001'), false);
});

test('Enter and click use the same completion path; stale key listeners are removed', () => {
    const h = boot({ discovered_cards: ['mem_001'], unlocked_cards: ['mem_001'] });
    h.open('mem_001');
    h.run("var container = document.createElement('div'); renderer.bindReadingControls(container, document.createElement('p'), renderer.lineByLineController)");
    h.document.dispatch('keydown', { key: 'Enter', target: { matches: () => false }, preventDefault() {} });
    assert.ok(h.save().read_cards.includes('mem_001'));
    h.run("renderer.setCurrentCard('mem_002')");
    h.document.dispatch('keydown', { key: 'Enter', target: { matches: () => false }, preventDefault() {} });
    assert.equal(h.save().read_cards.includes('mem_002'), false);
});

test('unlocking reading UI alone never marks a card read', () => {
    const h = boot();
    h.run("readingLockManager.lock('mem_001'); readingLockManager.unlock()");
    assert.equal(h.save().read_cards.includes('mem_001'), false);
});

test('first deletion completion saves next instruction before cosmetic notification timer', () => {
    const h = boot({ read_cards: ['file_015'], unlocked_cards: ['file_015'] });
    h.run('DeletionAnimation1 = class { run() { window.animation = this; } }; playDeletionAnimation1()');
    assert.equal(h.save().story_phase, 'deletion1');
    h.run('animation.onComplete()');
    const restored = boot(h.save());
    assert.equal(restored.save().story_phase, 'after_deletion1');
    assert.ok(restored.save().unlocked_cards.includes('file_016'));
});

test('final memory commits awakening checkpoint before the four-second pause', () => {
    const h = boot({ deletion2_completed: true, discovered_cards: ['mem_025'], unlocked_cards: ['mem_025'] });
    h.run('memoryDecay = { triggerAwakeningSequence() {} }');
    h.open('mem_025');
    h.run('renderer.lineByLineController.showNext()');
    assert.equal(h.save().story_phase, 'awakening');
    assert.ok(h.timers.some(timer => timer.ms === 4000));
    assert.equal(boot(h.save()).save().story_phase, 'awakening');
});

for (const [saved, phase] of [
    [{ deletion1_completed: true }, 'after_deletion1'],
    [{ deletion2_completed: true }, 'decay'],
    [{ discovered_cards: ['mem_025'] }, 'final_memory'],
    [{ read_cards: ['mem_025'] }, 'awakening'],
    [{ awakening_started: true, read_cards: ['mem_026'] }, 'final_reading'],
    [{ discovered_cards: ['mem_026'], read_cards: ['mem_026'] }, 'final_reading'],
    [{ game_completed: true }, 'ended']
]) {
    test(`legacy checkpoint migrates to ${phase}: ${JSON.stringify(saved)}`, () => {
        const h = boot(saved);
        assert.equal(h.save().story_phase, phase);
        assert.equal(boot(h.save()).save().story_phase, phase);
        if (phase === 'final_reading') assert.equal(h.run('gameState.getAwakeningProgress()'), 50);
    });
}

test('every story checkpoint dispatches to its matching recovery path', () => {
    for (const [phase, expected] of [['exploration', ''], ['deletion1', 'd1'], ['after_deletion1', ''],
        ['deletion2', 'd2'], ['decay', 'decay'], ['final_memory', 'final'], ['awakening', 'awake'],
        ['final_reading', 'read'], ['ending', 'read,end'], ['ended', 'ended']]) {
        const h = boot({ story_phase: phase });
        h.run(`var calls = []; playDeletionAnimation1 = () => calls.push('d1');
            playDeletionAnimation2 = () => calls.push('d2');
            memoryDecay = {start:()=>calls.push('decay'), unlockMem025Sequence:()=>calls.push('final'),
                triggerAwakeningSequence:()=>calls.push('awake'), startAwakeningProgress:()=>calls.push('read'),
                startEndingSequence:()=>calls.push('end')};
            EndingScreen = class {show(){calls.push('ended')}}; resumeStoryPhase();`);
        assert.equal(h.run("calls.join(',')"), expected, phase);
    }
});

test('awakening animation records its boundary and preserves progress on repeated restoration', () => {
    const h = boot({ story_phase: 'awakening', read_cards: ['mem_025'], unlocked_cards: ['mem_025'] });
    h.run(`memoryDecay = new MemoryDecayEffect({});
        memoryDecay.startAwakeningProgress = () => {};
        AwakeningAnimation = class { constructor(options) { this.options = options; } run() { window.animation = this; } };
        memoryDecay.triggerAwakeningSequence();`);
    assert.equal(h.save().story_phase, 'awakening');
    assert.equal(h.run('gameState.getAwakeningProgress()'), 40);
    assert.equal(h.save().discovered_cards.includes('mem_033'), false);
    h.run('animation.options.onComplete()');
    assert.equal(h.save().story_phase, 'final_reading');
    h.run("gameState.markCardAsRead('mem_026')");
    const restored = boot(h.save());
    restored.run('gameState.beginAwakening()');
    assert.equal(restored.run('gameState.getAwakeningProgress()'), 50);
});

test('ending is checkpointed before playback, shown once, and persisted as completed', async () => {
    const h = boot({ story_phase: 'final_reading', awakening_started: true });
    h.run(`var subtitles = [], shutdownCalls = 0;
        memoryDecay = new MemoryDecayEffect({}); memoryDecay.delay = async () => {};
        ShutdownSequence = class { async start() { shutdownCalls++; } };
        SubtitleSystem = class { show(text) { subtitles.push(text); } };
        EndingScreen.prototype.createScreen = () => document.createElement('div');`);
    const ending = h.run('memoryDecay.startEndingSequence()');
    assert.equal(h.save().story_phase, 'ending');
    h.run('memoryDecay.startEndingSequence()');
    await ending;
    assert.equal(h.run('shutdownCalls'), 1);
    assert.equal(h.run('subtitles.length'), 2);
    assert.equal(h.save().story_phase, 'ended');
    assert.equal(h.save().game_completed, true);
    assert.equal(boot(h.save()).save().story_phase, 'ended');
});

test('old saves recover command unlocks, startup files, count gates and sort-year reward', () => {
    const h = boot({ read_cards: ['file_013', 'file_014'], sort_year_used: true,
        discovered_cards: ['mem_003', ...Array.from({length: 9}, (_, i) => 'mem_' + String(i + 4).padStart(3, '0'))] });
    assert.ok(h.save().unlocked_cards.includes('file_010'));
    assert.ok(h.save().unlocked_cards.includes('mem_003'));
    assert.ok(h.save().unlocked_cards.includes('mem_024'));
    assert.ok(h.save().unlocked_commands.includes('/sort'));
    assert.ok(h.save().unlocked_commands.includes('/sort year'));
});
