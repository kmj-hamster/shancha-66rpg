// 调试入口使用独立存档，重置和结局重玩也不会影响正式进度。
function getGameStorageKey(key) {
    return window.DEBUG_STORY_MODE ? key + '_debug' : key;
}

/**
 * 游戏状态管理器
 * 负责管理游戏的所有运行时状态
 */

// 存档版本号
const SAVE_VERSION = '1.2.0';
const AWAKENING_MEMORY_IDS = ['mem_026', 'mem_027', 'mem_028', 'mem_029', 'mem_031', 'mem_019'];
// 百分之一为单位，避免浮点累加误差；六段记忆共贡献 62.08%。
const AWAKENING_WEIGHTS = [983, 1127, 876, 1209, 947, 1066];
const STORY_PHASES = ['exploration', 'deletion1', 'after_deletion1', 'deletion2',
    'decay', 'final_memory', 'awakening', 'final_reading', 'ending', 'ended'];

// 默认状态模板（用于补全缺失字段）
const DEFAULT_STATE = {
    story_phase: null,
    awakening_started: false,
    // 卡片相关状态
    discovered_cards: [],
    unlocked_cards: [],
    read_cards: [],
    // 线索词相关状态
    discovered_clues: [],
    used_clues: [],
    // UI相关状态
    current_sort: 'default',
    current_tab: 'memory',
    current_card: null,
    show_year: false,
    // 统计信息
    total_discovered: 0,
    // 游戏进度
    game_started: false,
    game_completed: false,
    // 其他状态
    notes: {},
    blue_marked_cards: [],
    sort_year_used: false,
    // Delete系统状态
    delete_stage: 'inactive',
    deletion1_completed: false,
    deletion2_completed: false,
    // 指令解锁系统
    unlocked_commands: [],
    // 问答卡片预览状态
    preview_shown_cards: [],
    // 音频状态
    current_bgm: 'Atmosphere'  // 当前BGM: Atmosphere/1Mo/Delete 等
};

class GameState {
    constructor() {
        this.initializeState();
    }

    /**
     * 初始化游戏状态
     */
    initializeState() {
        this.state = {
            story_phase: 'exploration',
            awakening_started: false,
            // 卡片相关状态
            discovered_cards: [],      // 已发现的卡片ID列表
            unlocked_cards: [],        // 已解锁的卡片ID列表
            read_cards: [],            // 已阅读的卡片ID列表

            // 线索词相关状态
            discovered_clues: [],      // 已获得的线索词列表
            used_clues: [],            // 已使用的线索词列表

            // UI相关状态
            current_sort: 'default',   // 当前排序方式: default/time/year
            current_tab: 'memory',     // 当前选中的Tab: memory/file/clue
            current_card: null,        // 当前显示的卡片ID
            show_year: false,          // 是否在标题栏显示年份（默认隐藏，/sort year时显示）

            // 统计信息
            total_discovered: 0,       // 发现总数

            // 游戏进度
            game_started: false,       // 游戏是否已开始
            game_completed: false,     // 游戏是否已完成

            // 阅读状态
            is_reading: false,         // 是否正在阅读
            reading_card_id: null,     // 当前阅读的卡片ID

            // 其他状态
            notes: {},                 // 卡片笔记 {card_id: note_text}

            // 蓝色标记（用于/sort year功能）
            blue_marked_cards: [],     // 被标记为蓝色的卡片ID列表

            // 特殊解锁标记
            sort_year_used: false,     // 是否已经使用过/sort year命令

            // Delete系统状态
            delete_stage: 'inactive',  // Delete系统阶段: inactive/stage1/stage2
            pending_confirmation: null, // 待确认的操作: {type: 'delete1'|'delete2'|'name_input', data: {...}}
            deletion1_completed: false, // 删除动画1是否已播放
            deletion2_completed: false, // 删除动画2是否已播放

            // 指令解锁系统
            unlocked_commands: [],     // 已解锁的指令列表

            // 🔧 问答卡片预览状态
            preview_shown_cards: []    // 已显示过预览的问答类型卡片ID列表
        };
    }

    /**
     * 获取当前游戏状态
     */
    getState() {
        return this.state;
    }

    /**
     * 发现新卡片
     * @param {string} cardId - 卡片ID
     */
    discoverCard(cardId) {
        if (!this.state.discovered_cards.includes(cardId)) {
            this.state.discovered_cards.push(cardId);
            this.state.total_discovered++;
            this.saveState();
            return true;
        }
        return false;
    }

    /**
     * 解锁卡片
     * @param {string} cardId - 卡片ID
     */
    unlockCard(cardId) {
        if (!this.state.unlocked_cards.includes(cardId)) {
            this.state.unlocked_cards.push(cardId);
            this.saveState();
            return true;
        }
        return false;
    }

    /**
     * 标记卡片已读
     * @param {string} cardId - 卡片ID
     */
    markCardAsRead(cardId) {
        if (!this.state.read_cards.includes(cardId)) {
            this.state.read_cards.push(cardId);
            this.reconcileDeleteProgress();
            this.saveState();
            return true;
        }
        return false;
    }

    /**
     * 添加蓝色标记
     * @param {string} cardId - 卡片ID
     */
    addBlueMarked(cardId) {
        if (!this.state.blue_marked_cards.includes(cardId)) {
            this.state.blue_marked_cards.push(cardId);
            this.saveState();
        }
    }

    /**
     * 移除蓝色标记
     * @param {string} cardId - 卡片ID
     */
    removeBlueMarked(cardId) {
        const index = this.state.blue_marked_cards.indexOf(cardId);
        if (index > -1) {
            this.state.blue_marked_cards.splice(index, 1);
            this.saveState();
        }
    }

    /**
     * 检查是否有蓝色标记
     * @param {string} cardId - 卡片ID
     * @returns {boolean}
     */
    isBlueMarked(cardId) {
        return this.state.blue_marked_cards.includes(cardId);
    }

    /**
     * 检查是否已经使用过/sort year命令
     * @returns {boolean}
     */
    hasSortYearUsed() {
        return this.state.sort_year_used;
    }

    /**
     * 标记已使用/sort year命令
     */
    setSortYearUsed() {
        this.state.sort_year_used = true;
        this.saveState();
    }

    /**
     * 添加新线索词
     * @param {string|Array} clues - 线索词或线索词数组
     */
    addClues(clues) {
        const clueArray = Array.isArray(clues) ? clues : [clues];
        let addedCount = 0;

        clueArray.forEach(clue => {
            // 统一转为小写，避免大小写重复
            const normalizedClue = clue.toLowerCase().trim();

            if (normalizedClue && !this.state.discovered_clues.includes(normalizedClue)) {
                this.state.discovered_clues.push(normalizedClue);
                addedCount++;
            }
        });

        if (addedCount > 0) {
            this.saveState();
        }
        return addedCount;
    }

    /**
     * 标记线索词已使用
     * @param {string} clue - 线索词
     */
    markClueAsUsed(clue) {
        // 统一转为小写，与discovered_clues保持一致
        const normalizedClue = clue.toLowerCase().trim();

        if (normalizedClue && !this.state.used_clues.includes(normalizedClue)) {
            this.state.used_clues.push(normalizedClue);
            this.saveState();
            return true;
        }
        return false;
    }

    /**
     * 设置当前排序方式
     * @param {string} sortType - 排序方式: default/time/year
     */
    setSort(sortType) {
        const validSorts = ['default', 'time', 'year'];
        if (validSorts.includes(sortType)) {
            this.state.current_sort = sortType;
            this.saveState();
            return true;
        }
        return false;
    }

    /**
     * 设置当前Tab
     * @param {string} tab - Tab类型: memory/file/clue
     */
    setTab(tab) {
        const validTabs = ['memory', 'file', 'clue'];
        if (validTabs.includes(tab)) {
            this.state.current_tab = tab;
            this.saveState();
            return true;
        }
        return false;
    }

    /**
     * 设置当前显示的卡片
     * @param {string} cardId - 卡片ID
     */
    setCurrentCard(cardId) {
        this.state.current_card = cardId;
        this.saveState();
    }

    /**
     * 设置是否显示年份
     * @param {boolean} showYear - 是否显示年份
     */
    setShowYear(showYear) {
        this.state.show_year = !!showYear;
        this.saveState();
    }

    /**
     * 设置阅读锁定状态
     * @param {boolean} isReading - 是否正在阅读
     * @param {string} cardId - 卡片ID（可选）
     */
    setReadingState(isReading, cardId = null) {
        this.state.is_reading = isReading;
        this.state.reading_card_id = cardId;
        // 不保存到localStorage，这是临时状态
    }

    /**
     * 获取阅读状态
     */
    getReadingState() {
        return {
            isReading: this.state.is_reading,
            cardId: this.state.reading_card_id
        };
    }

    /**
     * 添加或更新卡片笔记
     * @param {string} cardId - 卡片ID
     * @param {string} note - 笔记内容
     */
    setCardNote(cardId, note) {
        this.state.notes[cardId] = note;
        this.saveState();
    }

    /**
     * 检查卡片是否已发现
     * @param {string} cardId - 卡片ID
     */
    isCardDiscovered(cardId) {
        return this.state.discovered_cards.includes(cardId);
    }

    /**
     * 检查卡片是否已解锁
     * @param {string} cardId - 卡片ID
     */
    isCardUnlocked(cardId) {
        return this.state.unlocked_cards.includes(cardId);
    }

    /**
     * 检查卡片是否已读
     * @param {string} cardId - 卡片ID
     */
    isCardRead(cardId) {
        return this.state.read_cards.includes(cardId);
    }

    /**
     * 检查线索词是否已使用
     * @param {string} clue - 线索词
     */
    isClueUsed(clue) {
        const normalizedClue = clue.toLowerCase().trim();
        return this.state.used_clues.includes(normalizedClue);
    }

    /**
     * 获取未使用的线索词
     */
    getUnusedClues() {
        return this.state.discovered_clues.filter(
            clue => !this.state.used_clues.includes(clue)
        );
    }

    /**
     * 重置游戏状态
     */
    resetState() {
        this.initializeState();
        this.clearSavedState();
    }

    /**
     * 保存状态到localStorage
     */
    saveState() {
        try {
            // 创建状态副本，排除临时状态
            const stateCopy = { ...this.state };

            // 排除临时的UI状态（这些状态不应该持久化）
            delete stateCopy.is_reading;
            delete stateCopy.reading_card_id;
            delete stateCopy.pending_confirmation;

            // 添加版本号
            stateCopy._version = SAVE_VERSION;

            const stateJSON = JSON.stringify(stateCopy);
            localStorage.setItem(getGameStorageKey('gameState'), stateJSON);
            localStorage.setItem(getGameStorageKey('saveTime'), new Date().toISOString());
            return true;
        } catch (error) {
            console.error('[State] Failed to save:', error);
            return false;
        }
    }

    /**
     * 从localStorage加载状态
     */
    loadState() {
        try {
            const savedState = localStorage.getItem(getGameStorageKey('gameState'));
            if (!savedState) return false;

            let loaded;
            try {
                loaded = JSON.parse(savedState);
            } catch (parseError) {
                console.error('[State] JSON parse failed:', parseError);
                this.backupCorruptedSave(savedState);
                return false;
            }

            // 版本迁移
            loaded = this.migrateState(loaded);

            // 合并默认值（补全缺失字段）+ 加载的状态
            this.state = {
                ...JSON.parse(JSON.stringify(DEFAULT_STATE)),
                ...loaded,
                // 强制重置临时状态
                is_reading: false,
                reading_card_id: null,
                pending_confirmation: null
            };

            // 验证数据完整性
            this.validateState();

            const saveTime = localStorage.getItem(getGameStorageKey('saveTime'));
            console.log(`[State] Loaded from: ${saveTime}, version: ${loaded._version || 'unknown'}`);
            return true;
        } catch (error) {
            console.error('[State] Load failed:', error);
            return false;
        }
    }

    /**
     * 版本迁移
     * @param {Object} loaded - 加载的状态对象
     * @returns {Object} 迁移后的状态对象
     */
    migrateState(loaded) {
        const version = loaded._version || '1.0.0';
        console.log(`[State] Current save version: ${version}`);

        // 1.0.0 → 1.1.0: 确保新字段存在
        if (version === '1.0.0') {
            loaded.preview_shown_cards = loaded.preview_shown_cards || [];
            loaded.unlocked_commands = loaded.unlocked_commands || [];
            loaded._version = '1.1.0';
            console.log('[State] Migrated 1.0.0 → 1.1.0');
        }

        return loaded;
    }

    /**
     * 验证状态数据完整性
     */
    validateState() {
        // 确保数组字段是数组
        const arrayFields = [
            'discovered_cards', 'unlocked_cards', 'read_cards',
            'discovered_clues', 'used_clues', 'blue_marked_cards',
            'unlocked_commands', 'preview_shown_cards'
        ];

        arrayFields.forEach(field => {
            if (!Array.isArray(this.state[field])) {
                console.warn(`[State] Invalid ${field}, resetting to []`);
                this.state[field] = [];
            }
        });

        // 同步 total_discovered 与 discovered_cards.length
        if (this.state.total_discovered !== this.state.discovered_cards.length) {
            console.warn(`[State] Fixing total_discovered: ${this.state.total_discovered} → ${this.state.discovered_cards.length}`);
            this.state.total_discovered = this.state.discovered_cards.length;
        }

        // 验证 delete_stage
        const validStages = ['inactive', 'stage1', 'stage2'];
        if (!validStages.includes(this.state.delete_stage)) {
            console.warn(`[State] Invalid delete_stage: ${this.state.delete_stage}, resetting to 'inactive'`);
            this.state.delete_stage = 'inactive';
        }
        this.reconcileDeleteProgress();
        this.reconcileStoryProgress();

        // 确保 notes 是对象
        if (typeof this.state.notes !== 'object' || this.state.notes === null) {
            console.warn('[State] Invalid notes, resetting to {}');
            this.state.notes = {};
        }
    }

    /**
     * 备份损坏的存档
     * @param {string} data - 损坏的存档数据
     */
    backupCorruptedSave(data) {
        const backupKey = `gameState_corrupted_${Date.now()}`;
        try {
            localStorage.setItem(backupKey, data);
            console.log(`[State] Corrupted save backed up to: ${backupKey}`);
        } catch (e) {
            console.error('[State] Failed to backup corrupted save');
        }
        localStorage.removeItem(getGameStorageKey('gameState'));
        localStorage.removeItem(getGameStorageKey('saveTime'));
    }

    /**
     * 清除保存的状态
     */
    clearSavedState() {
        localStorage.removeItem(getGameStorageKey('gameState'));
        localStorage.removeItem(getGameStorageKey('saveTime'));
    }

    /**
     * 导出状态为JSON字符串（用于存档功能）
     */
    exportState() {
        return JSON.stringify({
            state: this.state,
            timestamp: new Date().toISOString(),
            version: '1.0.0'
        }, null, 2);
    }

    /**
     * 导入状态从JSON字符串（用于读档功能）
     * @param {string} stateJSON - 状态JSON字符串
     */
    importState(stateJSON) {
        try {
            const imported = JSON.parse(stateJSON);
            if (imported.state) {
                this.state = imported.state;
                this.saveState();
                return true;
            }
        } catch (error) {
            console.error('Failed to import state:', error);
        }
        return false;
    }

    /**
     * 获取游戏进度统计
     */
    getProgress() {
        return {
            discovered: this.state.discovered_cards.length,
            unlocked: this.state.unlocked_cards.length,
            read: this.state.read_cards.length,
            clues: this.state.discovered_clues.length,
            usedClues: this.state.used_clues.length,
            totalDiscovered: this.state.total_discovered
        };
    }

    /**
     * 解锁指令
     * @param {string|Array} commands - 指令或指令数组
     */
    unlockCommands(commands) {
        const commandArray = Array.isArray(commands) ? commands : [commands];
        let addedCount = 0;

        commandArray.forEach(cmd => {
            if (!this.state.unlocked_commands.includes(cmd)) {
                this.state.unlocked_commands.push(cmd);
                addedCount++;
                console.log(`[Command Unlock] Unlocked: ${cmd}`);
            }
        });

        if (addedCount > 0) {
            this.reconcileDeleteProgress();
            this.saveState();
        }
        return addedCount;
    }

    /**
     * 检查指令是否已解锁
     * @param {string} command - 指令名称
     * @returns {boolean}
     */
    isCommandUnlocked(command) {
        return this.state.unlocked_commands.includes(command);
    }

    /**
     * 获取所有已解锁的指令
     * @returns {Array}
     */
    getUnlockedCommands() {
        return [...this.state.unlocked_commands];
    }

    /**
     * 标记问答卡片的预览已显示
     * @param {string} cardId - 卡片ID
     */
    addPreviewShown(cardId) {
        if (!this.state.preview_shown_cards.includes(cardId)) {
            this.state.preview_shown_cards.push(cardId);
            this.saveState();
            console.log(`[State] Preview shown marked for card: ${cardId}`);
        }
    }

    /**
     * 检查问答卡片的预览是否已显示
     * @param {string} cardId - 卡片ID
     * @returns {boolean}
     */
    isPreviewShown(cardId) {
        return this.state.preview_shown_cards.includes(cardId);
    }

    /** 开始最终阅读阶段，一次性保存六段记忆和阶段标记。 */
    beginAwakening() {
        if (this.state.awakening_started) return;
        this.state.awakening_started = true;
        for (const id of AWAKENING_MEMORY_IDS) {
            if (!this.state.discovered_cards.includes(id)) this.state.discovered_cards.push(id);
            if (!this.state.unlocked_cards.includes(id)) this.state.unlocked_cards.push(id);
        }
        this.state.read_cards = this.state.read_cards.filter(id => !AWAKENING_MEMORY_IDS.includes(id));
        this.state.total_discovered = this.state.discovered_cards.length;
        this.state.current_tab = 'memory';
        this.state.show_year = true;
        this.advanceStoryPhase('awakening', false);
        this.saveState();
    }

    getAwakeningProgress() {
        const earned = AWAKENING_MEMORY_IDS.reduce((sum, id, index) =>
            sum + (this.state.read_cards.includes(id) ? AWAKENING_WEIGHTS[index] : 0), 3792);
        return earned / 100;
    }

    getStoryPhase() {
        return this.state.story_phase || 'exploration';
    }

    advanceStoryPhase(phase, save = true) {
        if (!STORY_PHASES.includes(phase)) return;
        if (STORY_PHASES.indexOf(phase) > STORY_PHASES.indexOf(this.getStoryPhase())) {
            this.state.story_phase = phase;
        }
        this.reconcileStoryProgress();
        if (save) this.saveState();
    }

    // 不依赖动画定时器的持久化结果，可重复执行而不重置阅读进度。
    reconcileStoryProgress() {
        const s = this.state;
        const reveal = id => {
            if (!s.discovered_cards.includes(id)) s.discovered_cards.push(id);
            if (!s.unlocked_cards.includes(id)) s.unlocked_cards.push(id);
        };
        if (!STORY_PHASES.includes(s.story_phase)) {
            if (s.game_completed) s.story_phase = 'ended';
            else if (s.awakening_started) s.story_phase = 'final_reading';
            else if (AWAKENING_MEMORY_IDS.some(id => id !== 'mem_019' && s.discovered_cards.includes(id))) {
                s.story_phase = 'final_reading';
                s.awakening_started = true;
            } else if (s.read_cards.includes('mem_025')) s.story_phase = 'awakening';
            else if (s.discovered_cards.includes('mem_025')) s.story_phase = 'final_memory';
            else if (s.deletion2_completed) s.story_phase = 'decay';
            else if (s.deletion1_completed || s.read_cards.includes('file_016') ||
                s.unlocked_commands.includes('/delete word')) s.story_phase = 'after_deletion1';
            else s.story_phase = 'exploration';
        }
        const atLeast = phase => STORY_PHASES.indexOf(s.story_phase) >= STORY_PHASES.indexOf(phase);
        if (s.deletion1_completed || atLeast('after_deletion1')) {
            s.deletion1_completed = true;
            reveal('file_016');
        }
        if (s.deletion2_completed || atLeast('decay')) s.deletion2_completed = true;
        if (atLeast('final_memory')) reveal('mem_025');
        if (s.awakening_started || atLeast('final_reading')) {
            s.awakening_started = true;
            AWAKENING_MEMORY_IDS.forEach(reveal);
            s.show_year = true;
        }
        if (atLeast('ended')) s.game_completed = true;
        s.total_discovered = s.discovered_cards.length;
        this.reconcileDeleteProgress();
    }

    /** 根据已保存的事实补齐派生解锁；问答仅发现，不跳过答案校验。 */
    reconcileProgress(cards, commandMap) {
        const s = this.state;
        const byId = new Map(cards.map(card => [card.id, card]));
        const add = (field, value) => { if (!s[field].includes(value)) s[field].push(value); };
        for (const field of ['discovered_cards', 'unlocked_cards', 'read_cards', 'blue_marked_cards', 'preview_shown_cards']) {
            s[field] = [...new Set(s[field].filter(id => byId.has(id)))];
        }
        // 不将问答预览或异常的已读标记误当作回答正确。
        s.read_cards = s.read_cards.filter(id => byId.get(id).unlock_type !== 'question' || s.unlocked_cards.includes(id));
        for (const id of s.read_cards) {
            add('discovered_cards', id);
            add('unlocked_cards', id);
            for (const command of commandMap[id] || []) add('unlocked_commands', command);
            const card = byId.get(id);
            const clues = [...(card.new_clues || []), ...(card.content || [])
                .filter(segment => segment.style === 'clue' && segment.text)
                .map(segment => (segment.clue || segment.text).replace(/[.,!?]/g, ''))];
            for (const clue of clues) {
                const normalized = clue.toLowerCase().trim();
                if (normalized) add('discovered_clues', normalized);
            }
        }
        if (s.sort_year_used) {
            add('discovered_cards', 'mem_024');
            add('unlocked_cards', 'mem_024');
        }
        for (const card of cards.filter(card => card.type === 'file')) {
            const parents = Array.isArray(card.unlock_by) ? card.unlock_by : [card.unlock_by].filter(Boolean);
            if (!parents.length || parents.some(id => s.read_cards.includes(id))) add('discovered_cards', card.id);
        }
        for (const id of s.unlocked_cards) add('discovered_cards', id);
        const count = s.discovered_cards.filter(id => byId.get(id)?.type === 'memory').length;
        for (const id of s.discovered_cards) {
            const card = byId.get(id);
            if (card?.unlock_type === 'direct' ||
                (card?.unlock_type === 'count' && count >= card.unlock_condition.required_cards)) {
                add('unlocked_cards', id);
            }
        }
        this.reconcileStoryProgress();
    }

    /** 阅读完成及其派生解锁在同一份存档中提交。 */
    completeCardReading(cardId, cards, commandMap) {
        const card = cards.find(card => card.id === cardId);
        if (!card || !this.isCardUnlocked(cardId)) return false;
        if (!this.state.read_cards.includes(cardId)) this.state.read_cards.push(cardId);
        if (cardId === 'mem_025') this.advanceStoryPhase('awakening', false);
        this.reconcileProgress(cards, commandMap);
        this.saveState();
        return true;
    }

    /**
     * 将删除阶段和指令与已读进度同步，兼容曾在阅读中途退出的旧存档。
     * 只推进阶段，避免重新阅读第一份说明时回退第二阶段。
     */
    reconcileDeleteProgress() {
        const state = this.state;
        const hasWord = state.delete_stage === 'stage2' ||
            state.read_cards.includes('file_016') ||
            state.unlocked_commands.includes('/delete word') || state.deletion2_completed;
        const hasIndex = hasWord || state.delete_stage === 'stage1' ||
            state.read_cards.includes('file_015') ||
            state.unlocked_commands.includes('/delete index') || state.deletion1_completed;

        state.delete_stage = hasWord ? 'stage2' : hasIndex ? 'stage1' : 'inactive';
        if (hasIndex && !state.unlocked_commands.includes('/delete index')) {
            state.unlocked_commands.push('/delete index');
        }
        if (hasWord && !state.unlocked_commands.includes('/delete word')) {
            state.unlocked_commands.push('/delete word');
        }
    }

    /**
     * 设置Delete系统阶段
     * @param {string} stage - 阶段: inactive/stage1/stage2
     */
    setDeleteStage(stage) {
        const validStages = ['inactive', 'stage1', 'stage2'];
        if (validStages.includes(stage)) {
            this.state.delete_stage = stage;
            this.saveState();
            return true;
        }
        return false;
    }

    /**
     * 获取Delete系统阶段
     * @returns {string}
     */
    getDeleteStage() {
        return this.state.delete_stage;
    }

    /**
     * 设置待确认操作
     * @param {Object} confirmation - 确认对象: {type, data}
     */
    setPendingConfirmation(confirmation) {
        this.state.pending_confirmation = confirmation;
        // 不保存到localStorage，这是临时状态
    }

    /**
     * 获取待确认操作
     * @returns {Object|null}
     */
    getPendingConfirmation() {
        return this.state.pending_confirmation;
    }

    /**
     * 清除待确认操作
     */
    clearPendingConfirmation() {
        this.state.pending_confirmation = null;
    }

    /**
     * 设置删除动画1已完成
     */
    setDeletion1Completed() {
        this.state.deletion1_completed = true;
        this.advanceStoryPhase('after_deletion1');
    }

    /**
     * 设置删除动画2已完成
     */
    setDeletion2Completed() {
        this.state.deletion2_completed = true;
        this.advanceStoryPhase('decay');
    }

    /**
     * 检查删除动画1是否已完成
     * @returns {boolean}
     */
    isDeletion1Completed() {
        return this.state.deletion1_completed;
    }

    /**
     * 检查删除动画2是否已完成
     * @returns {boolean}
     */
    isDeletion2Completed() {
        return this.state.deletion2_completed;
    }

    /**
     * 设置当前BGM
     * @param {string} bgmId - BGM名称，如 'Atmosphere', '1Mo', 'Delete'
     */
    setCurrentBGM(bgmId) {
        if (this.state.current_bgm !== bgmId) {
            this.state.current_bgm = bgmId;
            this.saveState();
            console.log(`[State] BGM saved: ${bgmId}`);
        }
    }

    /**
     * 获取当前BGM
     * @returns {string}
     */
    getCurrentBGM() {
        return this.state.current_bgm || 'Atmosphere';
    }
}

// 导出给其他模块使用
if (typeof module !== 'undefined' && module.exports) {
    module.exports = GameState;
}
