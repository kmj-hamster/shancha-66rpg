const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function boot(ios = false) {
    const audios = [], timers = new Map(); let serial = 0;
    class Audio {
        constructor() { this.paused = true; this.volume = 1; this.currentTime = 0; this.listeners = new Map(); audios.push(this); }
        play() { this.paused = false; return Promise.resolve(); }
        pause() { this.paused = true; }
        remove() {}
        addEventListener(type, fn) { this.listeners.set(type, fn); }
        removeEventListener(type) { this.listeners.delete(type); }
    }
    const c = vm.createContext({Audio, navigator:{userAgent:ios?'iPhone':'Desktop'}, window:{}, console:{log(){},warn(){},error(){}},
        setInterval(fn) { timers.set(++serial, fn); return serial; }, clearInterval(id) { timers.delete(id); }});
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/audio.js'),'utf8'), c);
    return {m:c.window.audioManager, audios, timers,
        tick(n = 25) { for(let i=0;i<n;i++) for(const [id,fn] of [...timers]) if(timers.has(id)) fn(); },
        playing() { return audios.filter(a=>!a.paused); }};
}
for (const ios of [false, true]) {
    test(`red click and saved BGM restoration cannot duplicate playback (iOS=${ios})`, () => {
        const h = boot(ios); h.m.switchMusic('Memory',2000); h.m.restoreMusic('Memory'); h.tick();
        assert.equal(h.playing().length, 1);
        h.m.switchMusic('Mozart.m4a',2000); h.tick();
        assert.deepEqual(h.playing().map(a=>a.src), ['./sound/Mozart.m4a']);
    });
}
test('first click on a different card wins over saved music', () => {
    const h=boot();h.m.switchMusic('Mozart.m4a');h.m.restoreMusic('Memory');h.tick();
    assert.deepEqual(h.playing().map(a=>a.src), ['./sound/Mozart.m4a']);
});
test('restoration without a card plays saved music; paused same track resumes', () => {
    const h=boot();h.m.restoreMusic('Memory');h.tick();h.m.pauseMusic();h.m.switchMusic('Memory');
    assert.equal(h.audios.length,1);assert.equal(h.playing().length,1);
});
test('rapid changes cancel previous transitions and release every old player', () => {
    const h=boot();h.m.playMusic('Memory',1,2000);h.tick(2);h.m.switchMusic('Mozart.m4a');h.tick(2);h.m.switchMusic('Wagner.m4a');h.tick();
    assert.deepEqual(h.playing().map(a=>a.src), ['./sound/Wagner.m4a']);assert.equal(h.timers.size,0);
});
test('stop during crossfade leaves no audio or delayed playback', () => {
    const h=boot();h.m.playMusic('Memory');h.m.switchMusic('Mozart.m4a');h.tick(3);h.m.stopMusic();h.tick();
    assert.equal(h.playing().length,0);assert.equal(h.timers.size,0);assert.equal(h.m.currentMusic,null);
});
test('new playback cancels stale fade-out and fade-in timers', () => {
    const h=boot();h.m.playMusic('Memory',1,2000);h.tick(2);h.m.stopMusic(1000);h.tick(2);h.m.playMusic('Mozart.m4a',1,2000);h.tick();
    assert.deepEqual(h.playing().map(a=>a.src), ['./sound/Mozart.m4a']);assert.equal(h.timers.size,0);
});
test('switching from atmosphere loop removes loop handlers and players', async () => {
    const h=boot();h.m.restoreMusic('Atmosphere');await Promise.resolve();h.tick();
    const old=h.m.currentMusic;h.m.switchMusic('Memory');h.tick();
    assert.equal(old.listeners.size,0);assert.deepEqual(h.playing().map(a=>a.src), ['./sound/Memory.m4a']);
    h.m.stopMusic();assert.equal(h.playing().length,0);
});
