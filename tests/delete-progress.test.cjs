const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(saved) {
    const storage = new Map();
    const timers = [];
    if (saved) storage.set('gameState', JSON.stringify(saved));
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        window: {},
        document: { addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } },
        setTimeout(fn, ms) { timers.push({ fn, ms }); },
        localStorage: {
            getItem: key => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, value),
            removeItem: key => storage.delete(key)
        }
    });
    for (const file of ['data/cards-data-zh.js', 'js/state.js', 'js/cards.js', 'js/unlock.js', 'js/app.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
    }
    vm.runInContext('CARDS_DATA = window.CARDS_DATA; gameState = new GameState(); cardManager = new CardManager(); cardManager.loadCards(); unlockManager = new UnlockManager(cardManager, gameState)', context);
    return {
        timers,
        run: code => vm.runInContext(code, context),
        saved: () => JSON.parse(storage.get('gameState'))
    };
}

for (const [name, saved, expected] of [
    ['new game stays locked', {}, 'inactive'],
    ['interrupted old first reading', { read_cards: ['file_015'], delete_stage: 'inactive' }, 'stage1'],
    ['unlocked index with missing stage', { unlocked_commands: ['/delete index'] }, 'stage1'],
    ['invalid stage with word command', { unlocked_commands: ['/delete word'], delete_stage: 'invalid' }, 'stage2'],
    ['interrupted second reading', { read_cards: ['file_016'], delete_stage: 'stage1' }, 'stage2'],
    ['first animation does not unlock word stage', { deletion1_completed: true }, 'stage1'],
    ['completed second animation', { deletion2_completed: true }, 'stage2']
]) {
    test(name, () => {
        const h = harness(saved);
        assert.equal(h.run('gameState.loadState()'), true);
        assert.equal(h.run('gameState.getDeleteStage()'), expected);
        assert.equal(h.run("gameState.isCommandUnlocked('/delete index')"), expected !== 'inactive');
        assert.equal(h.run("gameState.isCommandUnlocked('/delete word')"), expected === 'stage2');
        h.run('gameState.saveState(); gameState = new GameState(); gameState.loadState()');
        assert.equal(h.run('gameState.getDeleteStage()'), expected);
    });
}

for (const [id, stage, input] of [['file_015', 'stage1', '18'], ['file_016', 'stage2', '山茶']]) {
    test(`${id}: interrupted reading resumes, completion enables deletion atomically`, () => {
        const h = harness();
        if (id === 'file_016') h.run("gameState.markCardAsRead('file_015')");
        h.run(`
            var card = cardManager.getCardById('${id}');
            gameState.discoverCard(card.id); gameState.unlockCard(card.id);
            syncStateToCardManager();
            var completion;
            readingLockManager = { isLocked: () => false, lock() {}, unlock() {} };
            renderer = { onReadingComplete: callback => { completion = callback; } };
            refreshUI = () => {};
            var click = { target: { closest: () => ({ getAttribute: () => card.id }) } };
            handleFileClick(click);
        `);
        assert.equal(h.saved().read_cards.includes(id), false);
        assert.notEqual(h.saved().delete_stage, stage);
        h.run('gameState = new GameState(); gameState.loadState(); handleFileClick(click); completion(card.id)');
        assert.equal(h.saved().read_cards.includes(id), true);
        assert.equal(h.saved().delete_stage, stage);
        assert.equal(h.saved().unlocked_commands.includes(stage === 'stage1' ? '/delete index' : '/delete word'), true);
        h.run(`
            showFeedback = message => { throw new Error('Unexpected error: ' + message); };
            showDeleteConfirmationModal = () => {};
            currentMode = 'delete';
            processCommand('${input}');
        `);
        assert.equal(h.run('gameState.getPendingConfirmation().type'), stage === 'stage1' ? 'delete1' : 'delete2');
    });
}

test('stage two never regresses when first instruction is read later', () => {
    const h = harness();
    h.run("gameState.markCardAsRead('file_016'); gameState.markCardAsRead('file_015')");
    assert.equal(h.saved().delete_stage, 'stage2');
});

for (const [stage, answer] of [['stage1', '18'], ['stage2', '山茶'], ['stage2', '珂赛特']]) {
    test(stage + ': cancel restores input; confirm and animation mode change never focus it', () => {
        const h = harness({delete_stage: stage, unlocked_commands: stage === 'stage1' ? ['/delete index'] : ['/delete index', '/delete word']});
        h.run(`
            gameState.loadState(); currentMode = 'delete'; currentLang = 'zh';
            var inputFocuses = 0, inputBlurs = 0;
            var input = {value: '  ${answer}  ', focus() {inputFocuses++;}, blur() {inputBlurs++;}};
            var screen = {appendChild(item){this.child = item;}};
            document.querySelector = selector => selector === '.command-input' ? input : selector === '.crt-screen' ? screen : null;
            document.createElement = () => ({children: [], setAttribute(){}, focus(){}, remove(){this.removed = true;}, append(...items){this.children.push(...items);}, appendChild(item){this.children.push(item);}});
            document.body = {appendChild(){}};
            updateDeleteModePrompt = () => {};
            switchMode = mode => { currentMode = mode; };
            var animations = 0;
            DeletionAnimation1 = class { run() { animations++; } };
            DeletionAnimation2 = class { run() { animations++; } };
            handleDeleteMode();
        `);
        assert.equal(h.run('screen.child === deleteConfirmationModal'), true);
        assert.match(h.run('deleteConfirmationModal.className'), /opening-screen/);
        assert.match(h.run('deleteConfirmationModal.children[0].children[2].children[0].className'), /opening-btn/);
        assert.equal(h.run('deleteConfirmationModal.children[0].children[0].textContent'), '删除');
        assert.equal(h.run('deleteConfirmationModal.children[0].children[1].textContent'), stage === 'stage1' ? '记忆18' : answer);
        h.run('processCommand("y"); processDeleteModeInput("yes")');
        assert.equal(h.run('animations'), 0);
        h.run('deleteConfirmationModal.children[0].children[2].children[1].onclick()');
        assert.equal(h.run('gameState.getPendingConfirmation()'), null);
        assert.equal(h.run('confirmationLocked'), false);
        assert.equal(h.run('currentMode'), 'delete');
        assert.equal(h.run('input.value'), '  ' + answer + '  ');
        assert.equal(h.run('inputFocuses'), 1, 'cancel returns focus for editing');
        h.run('handleDeleteMode(); var yes = deleteConfirmationModal.children[0].children[2].children[0]; yes.onclick(); yes.onclick()');
        assert.equal(h.run('deleteConfirmationModal'), null);
        assert.equal(h.run('input.value'), '');
        assert.equal(h.run('animations'), 1);
        assert.equal(h.run('gameState.getPendingConfirmation()'), null);
        assert.equal(h.run('inputFocuses'), 1, 'confirm must not reopen the keyboard');
        assert.equal(h.run('inputBlurs'), 1);
        assert.equal(h.run('inputLocked'), true);
        const modeTimers = h.timers.filter(timer => timer.ms === 2000);
        assert.equal(modeTimers.length, 1);
        modeTimers[0].fn();
        assert.equal(h.run('currentMode'), 'search');
        assert.equal(h.run('inputLocked'), false);
        assert.equal(h.run('inputFocuses'), 1, 'automatic mode change must not reopen the keyboard');
        h.run('switchToSearchMode()');
        assert.equal(h.run('inputFocuses'), 2, 'normal search mode still focuses the input');
    });
}
