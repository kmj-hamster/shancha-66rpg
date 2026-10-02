/** 用 ?debug=1 开启剧情测试，测试存档与正式存档隔离。 */
window.DEBUG_SKIP_OPENING = false;
window.DEBUG_STORY_MODE = new URLSearchParams(window.location.search).get('debug') === '1';

function seedDebugStory(stage) {
    if (!window.DEBUG_STORY_MODE) throw new Error('Enable ?debug=1 first');
    if (!['awakening', 'reading', 'reading90', 'ready', 'ending'].includes(stage)) throw new Error('Unknown debug stage');
    const state = new GameState();
    state.state.game_started = true;
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
