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
        'js/search.js', 'js/reading-lock.js', 'js/render.js', 'js/app.js', 'js/memory-decay.js', 'js/ending.js']) {
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
        refreshUI = () => {}; showFeedback = () => {}; clearConfirmationLock = () => {};
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
        if (phase === 'final_reading') assert.equal(h.run('gameState.getAwakeningProgress()'), 47.75);
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
    assert.equal(h.run('gameState.getAwakeningProgress()'), 37.92);
    assert.equal(h.save().discovered_cards.includes('mem_033'), false);
    h.run('animation.options.onComplete()');
    assert.equal(h.save().story_phase, 'final_reading');
    h.run("gameState.markCardAsRead('mem_026')");
    const restored = boot(h.save());
    restored.run('gameState.beginAwakening()');
    assert.equal(restored.run('gameState.getAwakeningProgress()'), 47.75);
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

for (const lang of ['zh', 'en']) {
    test(lang + ': tea clue postpones memory 7 without blocking the eight-memory gate', () => {
        const h = boot({discovered_cards: ['file_011'], unlocked_cards: ['file_011']}, lang);
        h.run('searchEngine = new SearchEngine(cardManager, gameState)');
        const search = id => h.run('searchEngine.search(cardManager.getCardById(' + JSON.stringify(id) + ').unlock_clue)');
        const read = id => h.run('gameState.completeCardReading(' + JSON.stringify(id) + ', cardManager.getAllCards(), COMMAND_UNLOCK_MAP); syncStateToCardManager()');
        read('file_011');
        search('mem_001'); read('mem_001');
        search('mem_002'); read('mem_002'); search('mem_003');
        search('mem_004'); read('mem_004'); search('mem_005');
        search('mem_006'); read('mem_006');
        assert.deepEqual(Array.from(search('mem_008').matchedCards, card => card.id), ['mem_008']);
        read('mem_008'); search('mem_009');
        assert.equal(h.run('unlockManager.getDiscoveredMemoryCount()'), 8);
        assert.equal(h.run('gameState.isCardUnlocked("mem_003")'), true);
        assert.equal(search('mem_007').success, false);
        read('mem_003'); search('mem_010'); read('mem_010');
        search('mem_011'); read('mem_011');
        assert.equal(h.run('unlockManager.verifyAnswer("mem_012", "memory").correct'), true);
        read('mem_012'); search('mem_013');
        assert.equal(search('mem_007').success, false);
        read('mem_013');
        assert.equal(search('mem_007').success, true);
        assert.equal(h.run('cardManager.getCardById("mem_007").status'), 'partial');
        assert.equal(h.run('unlockManager.verifyAnswer("mem_007", "Iron").correct'), true);
        read('mem_007'); assert.equal(search('mem_014').success, true);
    });

    test(lang + ': old tea saves restore the canonical clue and clicking its short text selects it', () => {
        const h = boot({discovered_cards: ['mem_013'], unlocked_cards: ['mem_013'], read_cards: ['mem_013']}, lang);
        const clue = lang === 'zh' ? '凉水' : 'cool water';
        const short = lang === 'zh' ? '凉' : 'cool';
        assert.ok(h.save().discovered_clues.includes(clue));
        assert.equal(h.save().discovered_clues.includes(short), false);
        h.run('memoryDecay = {isActive: false}; var selected, filled; window.switchToClueTab = value => selected = value; window.fillClueToInput = value => filled = value; var segment = cardManager.getCardById("mem_013").content.find(s => s.style === "clue"); var span = renderer.createTextElement(segment); span.onclick({stopPropagation(){}})');
        assert.equal(h.run('span.textContent'), short);
        assert.equal(h.run('selected'), clue);
        assert.equal(h.run('filled'), clue);
        assert.equal(h.run('span.dataset.clue'), clue);
    });
}

for (const lang of ['zh', 'en']) {
    test(lang + ': count threshold highlights once and clicks consume the hint', () => {
        const h = boot({discovered_cards: ['mem_001','mem_002','mem_003','mem_004','mem_005','mem_006','mem_008','mem_009']}, lang);
        assert.equal(h.run('gameState.highlightedCards.has("mem_003")'), true);
        h.run('gameState.clearCardHighlights("mem_003"); gameState.reconcileProgress(cardManager.getAllCards(), COMMAND_UNLOCK_MAP)');
        assert.equal(h.run('gameState.highlightedCards.has("mem_003")'), false);
        h.run('gameState.highlightCards(["mem_003", "mem_005"]); handleFileClick({target:{closest:()=>({getAttribute:()=>"mem_003"})}})');
        assert.equal(h.run('gameState.highlightedCards.has("mem_003")'), false);
        assert.equal(h.run('gameState.highlightedCards.has("mem_005")'), true);
    });

    test(lang + ': wrong answers replace highlights with hint targets; correct answers clear them', () => {
        const h = boot({discovered_cards: ['mem_007','mem_012','file_005','file_018']}, lang);
        for (const [id, targets] of Object.entries({mem_007:['mem_013'], mem_012:['mem_011'], file_005:['file_006'], file_018:['mem_005','mem_010','mem_021']})) {
            h.run('unlockManager.verifyAnswer(' + JSON.stringify(id) + ', "wrong")');
            assert.deepEqual(Array.from(h.run('gameState.highlightedCards')), targets);
        }
        h.run('unlockManager.verifyAnswer("file_018", "bookstore father")');
        assert.equal(h.run('gameState.highlightedCards.size'), 0);
    });

    test(lang + ': reading contradiction preview highlights 5, 10, 21 before any answer', () => {
        const h = boot({discovered_cards: ['file_018']}, lang);
        h.run('document.querySelector = selector => selector === ".text-content" ? document.createElement("div") : null; renderer.renderCardContent = () => { renderer.lineByLineController = {}; }; renderer.renderQuestionUI = () => {}; displayCard(cardManager.getCardById("file_018")); renderer.lineByLineController.onPreviewComplete()');
        assert.deepEqual(Array.from(h.run('gameState.highlightedCards')), ['mem_005','mem_010','mem_021']);
        assert.equal(h.save().unlocked_cards.includes('file_018'), false);
        assert.equal(h.save().read_cards.includes('file_018'), false);
    });
}

test('default sort restores ID order after time/year sorting and survives reload', () => {
    const h = boot({current_sort: 'year', show_year: true, sort_year_used: true});
    h.run('refreshFileList = () => {}; processSortModeInput("  DeFaUlT  ")');
    assert.equal(h.save().current_sort, 'default');
    assert.equal(h.save().show_year, false);
    assert.equal(h.save().sort_year_used, true);
    assert.deepEqual(Array.from(h.run('sortCards([cardManager.getCardById("mem_010"), cardManager.getCardById("mem_003"), cardManager.getCardById("mem_001")], gameState.getState().current_sort).map(c => c.id)')), ['mem_001', 'mem_003', 'mem_010']);
    const restored = boot(h.save());
    assert.equal(restored.save().current_sort, 'default');
    assert.equal(restored.save().show_year, false);
    h.run('gameState.setSort("time"); processSortModeInput("default")');
    assert.equal(h.save().current_sort, 'default');
});

test('year summary survives automatic return to search and rolls out with later output', () => {
    const h = boot({unlocked_commands: ['/sort year']});
    h.run(`
        var outputLines = [{textContent:'',style:{}},{textContent:'',style:{}}];
        document.querySelector = selector => selector === '.system-output' ? {querySelectorAll:()=>outputLines} : null;
        refreshFileList = () => {};
        isMobileLandscape = () => false;
        currentMode = 'sort';
        processSortModeInput('year');
    `);
    const before = h.run('JSON.stringify(systemOutputLines)');
    h.timers.find(timer => timer.ms === 2000).fn();
    assert.equal(h.run('currentMode'), 'search');
    assert.equal(h.run('inputLocked'), false);
    assert.equal(h.run('JSON.stringify(systemOutputLines)'), before);
    assert.match(h.run('outputLines[1].textContent'), /1945.*1995/);
    // boot replaces UI feedback with a stub; invoke the production implementation here.
    const source = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
    h.run(source.slice(source.indexOf('function showFeedback(message'), source.indexOf('\n/**', source.indexOf('function showFeedback(message'))));
    h.run('showFeedback("next command")');
    assert.match(h.run('outputLines[0].textContent'), /1945.*1995/);
    h.run('showFeedback("another command")');
    assert.equal(h.run('outputLines.some(line => line.textContent.includes("1945"))'), false);
});

for (const lang of ['zh', 'en']) {
    test(lang + ': Carol file appears only after the three diary entries are completed', () => {
        const h = boot({discovered_cards:['mem_024'], unlocked_cards:['mem_024']}, lang);
        const read = id => h.run('gameState.completeCardReading(' + JSON.stringify(id) + ', cardManager.getAllCards(), COMMAND_UNLOCK_MAP); syncStateToCardManager()');
        read('mem_024');
        assert.ok(h.save().unlocked_cards.includes('file_007'));
        assert.equal(h.save().discovered_cards.includes('file_005'), false);
        read('file_007');
        assert.ok(h.save().unlocked_cards.includes('file_008'));
        assert.equal(h.save().discovered_cards.includes('file_005'), false);
        read('file_008');
        assert.ok(h.save().unlocked_cards.includes('file_009'));
        assert.equal(h.save().discovered_cards.includes('file_005'), false);
        const interrupted = boot(h.save(), lang);
        interrupted.open('file_009');
        assert.equal(interrupted.save().discovered_cards.includes('file_005'), false);
        read('file_009');
        assert.ok(h.save().discovered_cards.includes('file_005'));
        assert.equal(h.save().unlocked_cards.includes('file_005'), false, 'still requires the question answer');
    });
}

for (const phase of ['deletion2', 'decay']) {
    test(phase + ': opening any music-triggering file cannot interrupt story BGM', () => {
        const h = boot({story_phase: phase, current_bgm: 'Error.m4a'});
        h.run(`
            var musicCalls = [];
            window.audioManager = {currentMusicId:'Error.m4a', switchMusic:id=>musicCalls.push(id)};
            memoryDecay = {isActive: false};
            Object.keys(CARD_BGM_MAP).forEach(id => displayCard(cardManager.getCardById(id)));
        `);
        assert.equal(h.run('musicCalls.length'), 0);
        assert.equal(h.run('gameState.getCurrentBGM()'), 'Error.m4a');
    });
}

test('active decay blocks card BGM until final memory phase restores normal switching', () => {
    const h = boot({current_bgm: 'Error.m4a'});
    h.run(`
        var musicCalls = [];
        window.audioManager = {currentMusicId:'Error.m4a', switchMusic:id=>musicCalls.push(id)};
        memoryDecay = {isActive: true};
        displayCard(cardManager.getCardById('file_018'));
    `);
    assert.equal(h.run('musicCalls.length'), 0);
    h.run('gameState.advanceStoryPhase("final_memory"); memoryDecay.isActive = false; displayCard(cardManager.getCardById("mem_025"))');
    assert.deepEqual(Array.from(h.run('musicCalls')), ['Dream']);
    assert.equal(h.run('gameState.getCurrentBGM()'), 'Dream');
});

for (const phase of ['deletion2', 'decay', 'active-effect']) {
    test(phase + ': existing memory clues cannot change tab or input during corruption', () => {
        const h = boot();
        h.run(`
            memoryDecay = {isActive: false};
            var clueInput = {value: 'unchanged'};
            document.querySelector = selector => selector === '.input-area .command-input' ? clueInput : null;
            gameState.setTab('memory');
            var span = renderer.createTextElement({style: 'clue', text: '凉', clue: '凉水'});
            var stopped = 0;
        `);
        if (phase === 'active-effect') h.run('memoryDecay = {isActive: true}');
        else h.run(`gameState.advanceStoryPhase('${phase}'); memoryDecay = {isActive: false}`);
        h.run(`
            span.onclick({stopPropagation(){stopped++;}});
            switchToClueTab('凉水');
            fillClueToInput('凉水');
        `);
        assert.equal(h.run('stopped'), 1);
        assert.equal(h.run('gameState.getState().current_tab'), 'memory');
        assert.equal(h.run('clueInput.value'), 'unchanged');
        h.run(`
            gameState.advanceStoryPhase('final_memory'); memoryDecay.isActive = false;
            var selected, filled;
            window.switchToClueTab = value => selected = value;
            window.fillClueToInput = value => filled = value;
            span.onclick({stopPropagation(){}});
        `);
        assert.equal(h.run('selected'), '凉水');
        assert.equal(h.run('filled'), '凉水');
    });
}
