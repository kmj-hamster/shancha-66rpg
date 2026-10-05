/**
 * 解锁机制模块
 * 负责处理卡片的各种解锁逻辑（直接解锁、数量解锁、问答解锁）
 */

// 🌐 语言本地化支持（延迟初始化）
let UNLOCK_TEXT = {};

function initUnlockLocalization() {
    const lang = localStorage.getItem('gameLang') || 'en';
    UNLOCK_TEXT = {
        cardNotFound: lang === 'zh' ? '未找到' : 'Not found',
        cardUnlocked: lang === 'zh' ? '已解锁' : 'Unlocked',
        cardAlreadyUnlocked: lang === 'zh' ? '已解锁' : 'Already unlocked',
        cardUnlockedCount: lang === 'zh'
            ? '隔离解除。记忆解析完成。'
            : 'Isolation lifted. Memory parsing complete.',
        cardLockedCount: lang === 'zh'
            ? '检测到[隔离]。需发现{required}段记忆（已发现{current}）'
            : '[Isolation] detected. Required {required} memories (discovered: {current})',
        partialUnlock: lang === 'zh' ? '部分解锁。回答问题以完全解锁。' : 'Partial unlock. Answer the question to unlock fully.',
        invalidCardType: lang === 'zh' ? '无效类型' : 'Invalid type',
        cardNotAnswerable: lang === 'zh' ? '不在可回答状态' : 'Not in answerable state',
        correctAnswer: lang === 'zh' ? '解析成功' : 'Parsing successful',
        incorrectAnswer: lang === 'zh' ? '解析失败，请重试。' : 'Parsing failed. Try again.',
        newFileAvailable: lang === 'zh' ? '文件"{title}"已可解析' : 'File "{title}" is now parsable'
    };
}

class UnlockManager {
    /**
     * 构造函数
     * @param {CardManager} cardManager - 卡片管理器实例
     * @param {GameState} gameState - 游戏状态管理器实例
     */
    constructor(cardManager, gameState) {
        this.cardManager = cardManager;
        this.gameState = gameState;
        this.pendingQuestions = new Map(); // 存储待回答的问题

        // 🌐 初始化本地化文本
        initUnlockLocalization();
    }

    /**
     * 检查并处理卡片解锁
     * @param {string} cardId - 卡片ID
     * @returns {Object} 解锁结果
     */
    checkAndProcessUnlock(cardId) {
        const card = this.cardManager.getCardById(cardId);
        if (!card) {
            return { success: false, message: UNLOCK_TEXT.cardNotFound };
        }

        // 根据解锁类型处理
        switch (card.unlock_type) {
            case 'direct':
                return this.processDirectUnlock(cardId);
            case 'count':
                return this.processCountUnlock(cardId);
            case 'question':
                return this.processQuestionUnlock(cardId);
            default:
                return this.processDirectUnlock(cardId); // 默认为直接解锁
        }
    }

    /**
     * 处理直接解锁
     * @param {string} cardId - 卡片ID
     * @returns {Object} 解锁结果
     */
    processDirectUnlock(cardId) {
        // 直接解锁：发现即可阅读
        this.cardManager.updateCardStatus(cardId, 'unlocked');
        this.gameState.unlockCard(cardId);

        return {
            success: true,
            type: 'direct',
            message: UNLOCK_TEXT.cardUnlocked,
            status: 'unlocked'
        };
    }

    /**
     * 处理数量解锁
     * @param {string} cardId - 卡片ID
     * @returns {Object} 解锁结果
     */
    processCountUnlock(cardId) {
        const card = this.cardManager.getCardById(cardId);
        const discoveredCount = this.getDiscoveredMemoryCount();

        // 检查是否满足解锁条件
        const isUnlockable = this.cardManager.checkCountUnlockCondition(cardId, discoveredCount);

        if (isUnlockable) {
            // 满足条件，解锁卡片
            this.cardManager.updateCardStatus(cardId, 'unlocked');
            this.gameState.unlockCard(cardId);
            this.gameState.highlightCards([cardId]);

            return {
                success: true,
                type: 'count',
                message: UNLOCK_TEXT.cardUnlockedCount.replace('{count}', card.unlock_condition.required_cards),
                status: 'unlocked',
                required: card.unlock_condition.required_cards,
                current: discoveredCount
            };
        } else {
            // 不满足条件，保持锁定
            this.cardManager.updateCardStatus(cardId, 'locked');

            return {
                success: false,
                type: 'count',
                message: UNLOCK_TEXT.cardLockedCount
                    .replace('{required}', card.unlock_condition.required_cards)
                    .replace('{current}', discoveredCount),
                status: 'locked',
                required: card.unlock_condition.required_cards,
                current: discoveredCount
            };
        }
    }

    /**
     * 处理问答解锁
     * @param {string} cardId - 卡片ID
     * @returns {Object} 解锁结果
     */
    processQuestionUnlock(cardId) {
        console.log(`[UnlockManager] processQuestionUnlock called for cardId: ${cardId}`);

        const card = this.cardManager.getCardById(cardId);
        console.log(`[UnlockManager] Card found:`, card);

        // 如果卡片已经完全解锁，直接返回
        if (card.status === 'unlocked') {
            console.log(`[UnlockManager] Card already unlocked`);
            return {
                success: true,
                type: 'question',
                message: UNLOCK_TEXT.cardAlreadyUnlocked,
                status: 'unlocked'
            };
        }

        // 设置为部分解锁状态
        this.cardManager.updateCardStatus(cardId, 'partial');
        console.log(`[UnlockManager] Card status updated to partial`);

        // 获取问题预览内容
        const preview = this.cardManager.getQuestionPreview(cardId);
        console.log(`[UnlockManager] Question preview obtained:`, preview);

        // 存储待回答的问题
        const questionData = {
            question: preview.question,
            answer: preview.answer,
            attempts: 0
        };
        console.log(`[UnlockManager] Storing question data:`, questionData);
        this.pendingQuestions.set(cardId, questionData);
        console.log(`[UnlockManager] Pending questions map after set:`, Array.from(this.pendingQuestions.entries()));

        return {
            success: true,
            type: 'question',
            message: UNLOCK_TEXT.partialUnlock,
            status: 'partial',
            question: preview.question,
            preview: preview.preview
        };
    }

    /**
     * 验证问答答案
     * @param {string} cardId - 卡片ID
     * @param {string} answer - 用户提供的答案
     * @returns {Object} 验证结果
     */
    verifyAnswer(cardId, answer) {
        this.gameState.clearCardHighlights();
        console.log(`[UnlockManager] verifyAnswer called for cardId: ${cardId}, answer: ${answer}`);

        // 🔧 修复：不依赖内存中的pendingQuestions，直接从卡片验证
        const card = this.cardManager.getCardById(cardId);

        // 检查卡片是否有效
        if (!card) {
            console.log(`[UnlockManager] ERROR: Card not found: ${cardId}`);
            return {
                success: false,
                message: UNLOCK_TEXT.cardNotFound
            };
        }

        // 检查卡片类型
        if (card.unlock_type !== 'question') {
            console.log(`[UnlockManager] ERROR: Card ${cardId} is not a question type`);
            return {
                success: false,
                message: UNLOCK_TEXT.invalidCardType
            };
        }

        // 检查卡片状态（只有partial状态可以回答）
        if (card.status === 'unlocked') {
            console.log(`[UnlockManager] Card ${cardId} is already unlocked`);
            return {
                success: true,
                correct: true,
                message: UNLOCK_TEXT.cardAlreadyUnlocked,
                status: 'unlocked'
            };
        }

        if (card.status !== 'partial') {
            console.log(`[UnlockManager] ERROR: Card ${cardId} is not in answerable state (status: ${card.status})`);
            return {
                success: false,
                message: UNLOCK_TEXT.cardNotAnswerable
            };
        }

        // 🔧 从内存获取或初始化尝试次数
        let pendingQuestion = this.pendingQuestions.get(cardId);
        if (!pendingQuestion) {
            // 如果内存中没有（退出重启后），从卡片数据重新初始化
            console.log(`[UnlockManager] No pending question in memory, initializing from card data`);
            const preview = this.cardManager.getQuestionPreview(cardId);
            pendingQuestion = {
                question: preview.question,
                answer: preview.answer,
                attempts: 0
            };
            this.pendingQuestions.set(cardId, pendingQuestion);
        }

        // 增加尝试次数
        pendingQuestion.attempts++;
        console.log(`[UnlockManager] Attempt #${pendingQuestion.attempts}`);

        // 验证答案（大小写不敏感）
        const isCorrect = this.cardManager.verifyQuestionAnswer(
            cardId,
            answer.toLowerCase().trim()
        );
        console.log(`[UnlockManager] Answer verification result: ${isCorrect}`);

        if (isCorrect) {
            // 答案正确，完全解锁卡片
            console.log(`[UnlockManager] Correct answer! Unlocking card...`);
            this.cardManager.updateCardStatus(cardId, 'unlocked');
            this.gameState.unlockCard(cardId);
            this.pendingQuestions.delete(cardId);

            return {
                success: true,
                correct: true,
                message: UNLOCK_TEXT.correctAnswer,
                status: 'unlocked',
                attempts: pendingQuestion.attempts
            };
        } else {
            // 答案错误
            this.gameState.highlightCards(card.unlock_condition.hint_cards);
            console.log(`[UnlockManager] Incorrect answer. Got: ${answer}`);
            return {
                success: false,
                correct: false,
                message: UNLOCK_TEXT.incorrectAnswer,
                status: 'partial',
                attempts: pendingQuestion.attempts,
                hint: pendingQuestion.attempts >= 1 ? this.getHint(cardId) : null
            };
        }
    }

    /**
     * 获取提示（1次尝试失败后）
     * @param {string} cardId - 卡片ID
     * @returns {string} 提示信息
     */
    getHint(cardId) {
        const pendingQuestion = this.pendingQuestions.get(cardId);
        if (!pendingQuestion) return null;

        const card = this.cardManager.getCardById(cardId);
        const lang = localStorage.getItem('gameLang') || 'en';

        // 首次答错即显示关联提示，不要求提示所指向的卡片已解锁。
        if (card && card.unlock_condition?.hint) {
            return card.unlock_condition.hint;
        }

        // 如果没有自定义提示，提供答案的首字母
        const answer = Array.isArray(pendingQuestion.answer)
            ? pendingQuestion.answer[0]
            : pendingQuestion.answer;
        return lang === 'zh'
            ? `答案首字母为"${answer.charAt(0).toUpperCase()}"`
            : `The answer starts with "${answer.charAt(0).toUpperCase()}"`;
    }

    /**
     * 批量检查数量解锁
     * 当发现新卡片时，检查所有数量解锁类型的卡片
     * @returns {Array} 新解锁的卡片ID数组
     */
    checkAllCountUnlocks() {
        const discoveredCount = this.getDiscoveredMemoryCount();
        const newlyUnlocked = [];

        // 获取所有已发现但未解锁的卡片
        const discoveredCards = this.gameState.getState().discovered_cards;

        discoveredCards.forEach(cardId => {
            const card = this.cardManager.getCardById(cardId);

            // 检查是否是数量解锁类型且尚未解锁
            if (card &&
                card.unlock_type === 'count' &&
                card.status === 'locked') {

                // 检查是否满足解锁条件
                if (this.cardManager.checkCountUnlockCondition(cardId, discoveredCount)) {
                    // 解锁卡片
                    this.cardManager.updateCardStatus(cardId, 'unlocked');
                    this.gameState.unlockCard(cardId);
                    newlyUnlocked.push(cardId);
                    this.gameState.highlightCards([cardId]);

                    // 触发解锁提醒（红→蓝）- 注释掉：游戏启动时不显示提示
                    // this.notifyCardUnlock(card);

                    console.log(`[UnlockManager] Card ${cardId} auto-unlocked (count condition met)`);
                }
            }
        });

        return newlyUnlocked;
    }

    /**
     * 通知卡片解锁（红色变蓝色的提醒）
     * @param {Object} card - 卡片对象
     */
    notifyCardUnlock(card) {
        // 1. 文件项闪烁效果
        const fileItem = document.querySelector(`[data-card-id="${card.id}"]`);
        if (fileItem) {
            fileItem.classList.add('unlocking');
            setTimeout(() => {
                fileItem.classList.remove('unlocking');
                // 更新颜色类
                fileItem.classList.remove('locked-red');
                fileItem.classList.add('unread');
            }, 3000);
        }

        // 2. 显示反馈消息（根据 card.type 区分 Memory/File）
        const lang = localStorage.getItem('gameLang') || 'en';
        const feedbackArea = document.querySelector('.feedback-text');
        if (feedbackArea) {
            if (lang === 'zh') {
                const typeText = card.type === 'file' ? '文件' : '记忆';
                feedbackArea.textContent = `${typeText}"${card.title}"已可解析`;
            } else {
                const typeText = card.type === 'file' ? 'File' : 'Memory';
                feedbackArea.textContent = `${typeText} "${card.title}" is now parsable`;
            }
            feedbackArea.classList.add('highlight');
            setTimeout(() => {
                feedbackArea.classList.remove('highlight');
            }, 3000);
        }

        // 3. Tab小点脉冲效果
        const tabBtn = document.querySelector(`.tab-btn[data-type="${card.type}"]`);
        if (tabBtn) {
            const dot = tabBtn.querySelector('.unread-dot');
            if (dot) {
                dot.classList.add('pulse-strong');
                setTimeout(() => {
                    dot.classList.remove('pulse-strong');
                }, 3000);
            }
        }

        // 4. 播放音效（如果音频管理器存在）
        if (window.audioManager && window.audioManager.playSFX) {
            window.audioManager.playSFX('unlock');
        }
    }

    /**
     * 获取卡片解锁状态描述
     * @param {string} cardId - 卡片ID
     * @returns {string} 状态描述
     */
    getUnlockStatusDescription(cardId) {
        const card = this.cardManager.getCardById(cardId);
        if (!card) return 'Unknown card';

        switch (card.status) {
            case 'locked':
                if (card.unlock_type === 'count') {
                    const required = card.unlock_condition.required_cards;
                    const current = this.getDiscoveredMemoryCount();
                    return `Locked (Need ${required} memory cards, have ${current})`;
                }
                return 'Locked';

            case 'partial':
                const pending = this.pendingQuestions.get(cardId);
                if (pending) {
                    return `Partially unlocked (Answer question to unlock fully)`;
                }
                return 'Partially unlocked';

            case 'unlocked':
                return 'Fully unlocked';

            default:
                return 'Unknown status';
        }
    }

    /**
     * 获取待回答的问题
     * @param {string} cardId - 卡片ID
     * @returns {Object|null} 问题信息
     */
    getPendingQuestion(cardId) {
        return this.pendingQuestions.get(cardId) || null;
    }

    /**
     * 获取所有待回答的问题
     * @returns {Array} 问题列表
     */
    getAllPendingQuestions() {
        const questions = [];
        this.pendingQuestions.forEach((value, key) => {
            questions.push({
                cardId: key,
                question: value.question,
                attempts: value.attempts
            });
        });
        return questions;
    }

    /**
     * 清空所有待回答的问题（用于重置游戏）
     */
    clearPendingQuestions() {
        this.pendingQuestions.clear();
        console.log('[UnlockManager] Pending questions cleared');
    }

    /**
     * 获取已发现的memory类型卡片数量
     * @returns {number} 已发现的memory卡片数量
     */
    getDiscoveredMemoryCount() {
        const discoveredCards = this.gameState.getState().discovered_cards;
        let count = 0;
        discoveredCards.forEach(cardId => {
            const card = this.cardManager.getCardById(cardId);
            if (card && card.type === 'memory') {
                count++;
            }
        });
        return count;
    }

    /**
     * 获取解锁统计
     * @returns {Object} 统计信息
     */
    getUnlockStats() {
        const allCards = this.cardManager.getAllCards();
        const stats = {
            total: allCards.length,
            locked: 0,
            partial: 0,
            unlocked: 0,
            byType: {
                direct: { total: 0, unlocked: 0 },
                count: { total: 0, unlocked: 0 },
                question: { total: 0, unlocked: 0 }
            }
        };

        allCards.forEach(card => {
            // 统计状态
            switch (card.status) {
                case 'locked':
                    stats.locked++;
                    break;
                case 'partial':
                    stats.partial++;
                    break;
                case 'unlocked':
                    stats.unlocked++;
                    break;
            }

            // 统计解锁类型
            const type = card.unlock_type || 'direct';
            if (stats.byType[type]) {
                stats.byType[type].total++;
                if (card.status === 'unlocked') {
                    stats.byType[type].unlocked++;
                }
            }
        });

        return stats;
    }

    /**
     * 检查阅读触发的file解锁
     * 当一个卡片被阅读完成时调用，检查是否有file需要解锁
     * @param {string} cardId - 被阅读的卡片ID
     * @returns {Array} 新解锁的file列表
     */
    checkReadTriggeredUnlocks(cardId) {
        console.log(`[UnlockManager] Checking read-triggered unlocks for card: ${cardId}`);

        // 查找所有被此卡片触发解锁的file
        const triggeredFiles = this.cardManager.getFilesByUnlockBy(cardId);
        console.log(`[UnlockManager] Found ${triggeredFiles.length} files to unlock:`, triggeredFiles.map(f => f.id));

        const newlyUnlocked = [];

        triggeredFiles.forEach(file => {
            // 检查file是否已经被发现
            if (!this.gameState.isCardDiscovered(file.id)) {
                // 发现file
                this.gameState.discoverCard(file.id);
                this.cardManager.updateCardDiscoveredStatus(file.id, true);
                console.log(`[UnlockManager] 🎉 File discovered: ${file.id} (${file.title})`);
                // 注意：音效播放移到 notifyFileUnlock 中，确保与UI刷新同步
            }

            // 检查file是否已经解锁（包括partial状态，避免重复通知）
            if (file.status !== 'unlocked' && file.status !== 'partial') {
                // 🔧 根据 unlock_type 正确处理解锁状态
                if (file.unlock_type === 'question') {
                    // 问答类型：调用 checkAndProcessUnlock 设置为 partial 状态
                    const unlockResult = this.checkAndProcessUnlock(file.id);
                    if (unlockResult.status === 'partial') {
                        newlyUnlocked.push(file);
                        console.log(`[UnlockManager] File unlocked as partial (question): ${file.id} (${file.title})`);
                        // 触发解锁通知
                        this.notifyFileUnlock(file);
                    }
                } else {
                    // 其他类型：直接解锁
                    this.cardManager.updateCardStatus(file.id, 'unlocked');
                    this.gameState.unlockCard(file.id);
                    newlyUnlocked.push(file);
                    console.log(`[UnlockManager] File unlocked: ${file.id} (${file.title})`);
                    // 触发解锁通知
                    this.notifyFileUnlock(file);
                }
            }
        });

        return newlyUnlocked;
    }

    /**
     * 通知file解锁（显示提示信息）
     * @param {Object} file - file对象
     */
    notifyFileUnlock(file) {
        console.log(`[UnlockManager] Notifying file unlock: ${file.id}`);

        // 1. 显示反馈消息（使用蓝色）
        if (typeof showFeedback === 'function') {
            showFeedback(UNLOCK_TEXT.newFileAvailable.replace('{title}', file.title), 'success');
        }

        // 2. 刷新UI（刷新左侧列表和Tab指示器）
        setTimeout(() => {
            if (typeof refreshUI === 'function') {
                console.log('[UnlockManager] Refreshing UI after file unlock');
                refreshUI();
            } else {
                console.warn('[UnlockManager] refreshUI function not available');
            }

            // 🎵 3. UI刷新后立即播放发现音效（确保视听同步）
            if (window.audioManager) {
                console.log(`[UnlockManager] Playing discover sound for ${file.id} after UI refresh`);
                audioManager.playSFX('discover', 0.5, true);
            } else {
                console.warn(`[UnlockManager] ⚠️ audioManager not available!`);
            }
        }, 50);
    }

    /**
     * 初始化时检查所有直接解锁的file
     * 对于unlock_by为空数组的file，直接发现并解锁
     */
    initializeDirectUnlockFiles() {
        console.log(`[UnlockManager] Initializing direct unlock files...`);

        const allCards = this.cardManager.getAllCards();
        let count = 0;

        allCards.forEach(card => {
            // 只处理file类型
            if (card.type !== 'file') return;

            // 检查unlock_by是否为空
            const unlockBy = card.unlock_by;
            if (!unlockBy || (Array.isArray(unlockBy) && unlockBy.length === 0)) {
                // 直接解锁的file
                if (!this.gameState.isCardDiscovered(card.id)) {
                    this.gameState.discoverCard(card.id);
                    this.cardManager.updateCardDiscoveredStatus(card.id, true);
                    count++;
                }

                if (card.status !== 'unlocked') {
                    this.cardManager.updateCardStatus(card.id, 'unlocked');
                    this.gameState.unlockCard(card.id);
                }

                console.log(`[UnlockManager] Direct unlock file initialized: ${card.id}`);
            }
        });

        console.log(`[UnlockManager] Initialized ${count} direct unlock files`);
        return count;
    }
}

// 导出类（如果使用模块系统）
// export default UnlockManager;
