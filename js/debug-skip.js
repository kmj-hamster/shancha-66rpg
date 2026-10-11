/** 用 ?debug=1 开启剧情测试，测试存档与正式存档隔离。 */
window.DEBUG_SKIP_OPENING = false;
window.DEBUG_STORY_MODE = new URLSearchParams(window.location.search).get('debug') === '1';

function seedDebugStory(stage) {
    if (!window.DEBUG_STORY_MODE) throw new Error('Enable ?debug=1 first');
    if (!['delete1', 'delete2', 'awakening', 'reading', 'reading90', 'ready', 'ending'].includes(stage)) throw new Error('Unknown debug stage');
    const state = new GameState();
    state.state.game_started = true;
    if (stage === 'delete1' || stage === 'delete2') {
        // 删除前的完整探索进度；不提前暴露最终恢复的记忆19、25及以后。
        const memories = Array.from({length: 24}, (_, i) => 'mem_' + String(i + 1).padStart(3, '0'))
            .filter(id => id !== 'mem_019');
        const files = Array.from({length: 18}, (_, i) => 'file_' + String(i + 1).padStart(3, '0'))
            .filter(id => id !== 'file_016' || stage === 'delete2');
        state.state.discovered_cards = [...memories, ...files];
        state.state.unlocked_cards = [...state.state.discovered_cards];
        state.state.read_cards = [...state.state.discovered_cards];
        state.state.sort_year_used = true;
        state.state.show_year = true;
        state.state.current_bgm = 'Atmosphere';
        state.state.unlocked_commands = ['/sort time', '/sort year', '/delete index'];
        if (stage === 'delete2') {
            state.state.unlocked_commands.push('/delete word');
            state.advanceStoryPhase('after_deletion1', false);
        }
        state.reconcileStoryProgress();
        if (!state.saveState()) throw new Error('Unable to save debug checkpoint');
        return;
    }
    state.state.read_cards = ['file_010', 'mem_025'];
    state.state.discovered_cards = ['file_010', 'mem_025'];
    state.state.unlocked_cards = ['file_010', 'mem_025'];
    state.beginAwakening();
    if (stage !== 'awakening') state.advanceStoryPhase('final_reading', false);
    const count = stage === 'reading90' ? 5 : ['ready', 'ending'].includes(stage) ? 6 : 0;
    state.state.read_cards.push(...AWAKENING_MEMORY_IDS.slice(0, count));
    if (stage === 'ending') state.advanceStoryPhase('ending', false);
    if (!state.saveState()) throw new Error('Unable to save debug checkpoint');
}

if (window.DEBUG_STORY_MODE) {
    const url = new URL(window.location.href);
    const stage = url.searchParams.get('debugStage');
    // 显式跳转只消费一次，普通刷新继续测试进度。
    if (stage || !localStorage.getItem(getGameStorageKey('gameState'))) {
        seedDebugStory(stage || 'awakening');
        url.searchParams.delete('debugStage');
        window.history.replaceState(null, '', url);
    }
    document.addEventListener('DOMContentLoaded', () => {
        const panel = document.createElement('details');
        panel.open = true;
        panel.style.cssText = 'position:fixed;right:8px;top:8px;z-index:2147483647;background:#101810;color:#b6ffb6;border:1px solid #648664;padding:10px;font:13px monospace;max-width:260px';
        const title = document.createElement('summary');
        title.textContent = '剧情测试 · 独立存档';
        panel.appendChild(title);
        for (const [target, label] of [
            ['delete1', '删除阶段一 · 输入18'], ['delete2', '删除阶段二 · 输入山茶'],
            ['awakening', '重播复苏动画'], ['reading', '最终阅读 · 37.92%'],
            ['reading90', '最终阅读 · 89.34%'], ['ready', '唤醒按钮 · 100%'],
            ['ending', '直接播放结局'], [null, '退出测试，返回原存档']
        ]) {
            const button = document.createElement('button');
            button.textContent = label;
            button.style.cssText = 'display:block;width:100%;margin-top:6px;padding:6px;cursor:pointer';
            button.onclick = () => {
                const next = new URL(window.location.href);
                if (target) next.searchParams.set('debugStage', target);
                else { next.searchParams.delete('debug'); next.searchParams.delete('debugStage'); }
                // 重载清理动画定时器、阅读锁和旧界面。
                window.location.href = next.href;
            };
            panel.appendChild(button);
        }
        document.body.appendChild(panel);
    });
}
