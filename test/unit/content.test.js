import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeChrome, tick } from '../helpers/chrome.js';

// jsdom 沒有 innerText：子元素之間以換行分隔的簡化版
Object.defineProperty(HTMLElement.prototype, 'innerText', {
  configurable: true,
  get() {
    return [...this.childNodes].map((n) => (n.nodeType === 3 ? n.textContent : n.innerText ?? '')).join('\n');
  }
});

const START = 1_000_000;
let env;

const winListeners = [];
const realAdd = window.addEventListener.bind(window);
window.addEventListener = (type, fn, opts) => { winListeners.push([type, fn, opts]); realAdd(type, fn, opts); };

async function boot({ settings, path = '/abc-defg-hij', title = 'Meet - 週會', html = '' } = {}) {
  env = makeChrome(settings ? { settings } : {});
  history.replaceState(null, '', path);
  document.title = title;
  document.body.innerHTML = html;
  delete window.__meetNotesLoaded;
  vi.resetModules();
  await import('../../content.js');
  await tick();
}

const step = async (n = 1) => {
  for (let i = 0; i < n; i++) {
    vi.advanceTimersByTime(1000);
    await tick();
  }
};
const settle = async () => { await tick(); vi.advanceTimersByTime(250); await tick(); };

const sent = (type) => env.chrome.runtime.sendMessage.mock.calls.map((c) => c[0]).filter((m) => m.type === type);
const status = () => new Promise((r) => env.listeners.message[0]({ type: 'GET_STATUS' }, {}, r));
const setRecording = (value) => new Promise((r) => env.listeners.message[0]({ type: 'SET_RECORDING', value }, {}, r));

function addLeave(label = 'Leave call') {
  const b = document.createElement('button');
  b.setAttribute('aria-label', label);
  b.id = 'leave';
  document.body.append(b);
  return b;
}
function addRegion(label = 'Captions') {
  const r = document.createElement('div');
  r.setAttribute('role', 'region');
  r.setAttribute('aria-label', label);
  document.body.append(r);
  return r;
}
function addBlock(region, speaker, text) {
  const el = document.createElement('div');
  el.className = 'nMcdL';
  el.innerHTML = '<span class="NWpY1d"></span><div class="ygicle"></div>';
  el.querySelector('.NWpY1d').textContent = speaker;
  el.querySelector('.ygicle').textContent = text;
  region.append(el);
  return el;
}
const setText = (el, text) => { el.querySelector('.ygicle').textContent = text; };
const setSpeaker = (el, s) => { el.querySelector('.NWpY1d').textContent = s; };

async function inCall(opts) {
  await boot(opts);
  addLeave();
  await step();
}
async function endCall() {
  document.getElementById('leave').remove();
  await step(3);
  return sent('MEETING_ENDED').at(-1).meeting;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'Date'] });
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
  for (const [type, fn, opts] of winListeners.splice(0)) window.removeEventListener(type, fn, opts);
});

describe('載入', () => {
  it('只載入一次', async () => {
    env = makeChrome();
    window.__meetNotesLoaded = true;
    vi.resetModules();
    await import('../../content.js');
    expect(env.chrome.runtime.onMessage.addListener).not.toHaveBeenCalled();
    expect(env.chrome.storage.local.get).not.toHaveBeenCalled();
  });

  it('設定旗標並讀取設定', async () => {
    await boot();
    expect(window.__meetNotesLoaded).toBe(true);
    expect(env.chrome.storage.local.get).toHaveBeenCalledWith('settings');
  });

  it('chrome.storage 不可用時仍可運作', async () => {
    env = makeChrome();
    env.chrome.storage = undefined;
    delete window.__meetNotesLoaded;
    vi.resetModules();
    await import('../../content.js');
    addLeave();
    await step();
    expect(sent('MEETING_STARTED')).toHaveLength(1);
  });

  it('sendMessage 失敗被吞掉', async () => {
    await boot();
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    env.chrome.runtime.sendMessage.mockRejectedValueOnce(new Error('x'));
    addLeave();
    await step();
    env.chrome.runtime.sendMessage.mockImplementationOnce(() => { throw new Error('ctx invalidated'); });
    await endCall();
    await vi.advanceTimersByTimeAsync(0);
    process.off('unhandledRejection', onUnhandled);
    expect(onUnhandled).not.toHaveBeenCalled();
    expect(env.chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);
  });
});

describe('會議生命週期', () => {
  it('沒有離開按鈕時不開始', async () => {
    await boot();
    await step(5);
    expect(env.chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(await status()).toEqual({
      inCall: false, recording: true, captionsFound: false, meetingId: null, title: '', count: 0, last: null
    });
  });

  it.each([
    ['Leave call'], ['leave CALL now'], ['離開通話'], ['退出通話'], ['退出通话'], ['離開會議']
  ])('離開按鈕 %s', async (label) => {
    await boot();
    addLeave(label);
    await step();
    expect(sent('MEETING_STARTED')).toEqual([{ type: 'MEETING_STARTED', id: `abc-defg-hij_${START + 1000}` }]);
  });

  it('jsname 離開按鈕', async () => {
    await boot({ html: '<div jsname="CQylAd"></div>' });
    await step();
    expect(sent('MEETING_STARTED')).toHaveLength(1);
  });

  it('非 button 的 aria-label 不算', async () => {
    await boot({ html: '<div aria-label="Leave call"></div>' });
    await step();
    expect(sent('MEETING_STARTED')).toHaveLength(0);
  });

  it('連續 3 秒找不到離開按鈕才結束', async () => {
    await inCall();
    const leave = document.getElementById('leave');
    leave.remove();
    await step(2);
    document.body.append(leave);
    await step();
    leave.remove();
    await step(2);
    expect(sent('MEETING_ENDED')).toHaveLength(0);
    expect((await status()).inCall).toBe(true);
    await step();
    expect(sent('MEETING_ENDED')).toHaveLength(1);
    expect((await status()).inCall).toBe(false);
    await step(5);
    expect(sent('MEETING_ENDED')).toHaveLength(1);
  });

  it('結束時送出快照，並可再開新會議', async () => {
    await inCall();
    const m = await endCall();
    expect(m).toEqual({
      id: `abc-defg-hij_${START + 1000}`,
      meetCode: 'abc-defg-hij',
      title: '週會',
      url: 'http://localhost:3000/abc-defg-hij',
      startedAt: START + 1000,
      endedAt: START + 4000,
      entries: []
    });
    expect(await status()).toEqual({
      inCall: false, recording: true, captionsFound: false, meetingId: null, title: '', count: 0, last: null
    });
    addLeave();
    await step();
    expect(sent('MEETING_STARTED')).toHaveLength(2);
  });

  it('pagehide 時結束會議', async () => {
    await inCall();
    window.dispatchEvent(new Event('pagehide'));
    expect(sent('MEETING_ENDED')).toHaveLength(1);
    expect(sent('MEETING_ENDED')[0].meeting.endedAt).toBe(START + 1000);
  });

  it('沒有會議時 pagehide 不做事', async () => {
    await boot();
    window.dispatchEvent(new Event('pagehide'));
    expect(env.chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});

describe('會議代碼與標題', () => {
  it.each([
    ['/abc-defg-hij', 'abc-defg-hij'],
    ['/abcd-efgh-ijkl', 'abcd-efgh-ijkl'],
    ['/ABC-DEFG-HIJ?authuser=0', 'ABC-DEFG-HIJ'],
    ['/landing', 'meet'],
    ['/ab-defg-hij', 'meet'],
    ['/abc-def-hij', 'meet']
  ])('%s → %s', async (path, code) => {
    await inCall({ path, title: '' });
    const m = await endCall();
    expect(m.meetCode).toBe(code);
    expect(m.title).toBe(code);
  });

  it.each([
    ['Meet - 週會', '週會'],
    ['Meet – 週會', '週會'],
    ['Meet — 週會', '週會'],
    ['meet:週會', '週會'],
    ['  我的   會議 ', '我的 會議'],
    ['Meet', 'abc-defg-hij'],
    ['Google Meet', 'abc-defg-hij'],
    ['google meet', 'abc-defg-hij'],
    ['Meet - Google Meet', 'abc-defg-hij'],
    ['My Google Meet', 'My Google Meet'],
    ['Meeting', 'Meeting'],
    ['Weekly Meet - Sync', 'Weekly Meet - Sync'],
    ['', 'abc-defg-hij']
  ])('document.title %j → %s', async (title, expected) => {
    await inCall({ title });
    expect((await endCall()).title).toBe(expected);
  });

  it('data-meeting-title 屬性優先', async () => {
    await inCall({ html: '<div data-meeting-title="  屬性  標題 ">文字</div>' });
    expect((await endCall()).title).toBe('屬性 標題');
  });

  it('data-meeting-title 為空時用文字', async () => {
    await inCall({ html: '<div data-meeting-title="">  元素 文字 </div>' });
    expect((await endCall()).title).toBe('元素 文字');
  });

  it('元素沒有文字時退回 document.title', async () => {
    await inCall({ html: '<div data-meeting-title=""></div>' });
    expect((await endCall()).title).toBe('週會');
  });

  it('標題變更會觸發儲存，沒變更不會重存', async () => {
    await inCall({ title: 'Google Meet' });
    const region = addRegion();
    await step();
    addBlock(region, 'A', 'x');
    await settle();
    await step(3);
    expect(env.chrome.storage.local.set).toHaveBeenCalledTimes(1);
    await step(6);
    expect(env.chrome.storage.local.set).toHaveBeenCalledTimes(1);
    document.title = 'Meet - 新標題';
    await step(3);
    expect(env.chrome.storage.local.set).toHaveBeenCalledTimes(2);
    expect(env.data[`meeting:abc-defg-hij_${START + 1000}`].title).toBe('新標題');
  });

  it('標題稍後出現時更新', async () => {
    await inCall({ title: 'Google Meet' });
    expect((await status()).title).toBe('abc-defg-hij');
    await step();
    expect((await status()).title).toBe('abc-defg-hij');
    document.title = 'Meet - 晚來的標題';
    await step();
    expect((await status()).title).toBe('晚來的標題');
    await step(3);
    expect(Object.values(env.data)).toEqual([]);
    document.title = 'Meet - 再改';
    await step();
    expect((await status()).title).toBe('晚來的標題');
  });
});

describe('自動開啟字幕', () => {
  const ccButton = (label = 'Turn on captions (c)', pressed = 'false') => {
    const b = document.createElement('button');
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-pressed', pressed);
    b.onclick = vi.fn();
    document.body.append(b);
    return b;
  };

  it('點擊字幕按鈕，最多三次', async () => {
    await boot();
    const other = ccButton('Mute');
    const pressed = ccButton('Captions', 'true');
    const cc = ccButton();
    addLeave();
    await step(5);
    expect(cc.onclick).toHaveBeenCalledTimes(3);
    expect(other.onclick).not.toHaveBeenCalled();
    expect(pressed.onclick).not.toHaveBeenCalled();
  });

  it('中文標籤', async () => {
    await boot();
    const cc = ccButton('開啟字幕');
    addLeave();
    await step();
    expect(cc.onclick).toHaveBeenCalledTimes(1);
  });

  it('沒有 aria-label 的按鈕不算', async () => {
    await boot();
    const b = document.createElement('button');
    b.setAttribute('aria-pressed', 'false');
    b.textContent = 'captions';
    b.onclick = vi.fn();
    document.body.append(b);
    addLeave();
    await step();
    expect(b.onclick).not.toHaveBeenCalled();
  });

  it('不在會議中不點', async () => {
    await boot();
    const cc = ccButton();
    await step(2);
    expect(cc.onclick).not.toHaveBeenCalled();
  });

  it('設定關閉時不點', async () => {
    await boot({ settings: { autoCaptions: false } });
    const cc = ccButton();
    addLeave();
    await step(2);
    expect(cc.onclick).not.toHaveBeenCalled();
  });

  it('設定即時變更', async () => {
    await boot();
    const cc = ccButton();
    const change = (c, area = 'local') => env.listeners.changed.forEach((fn) => fn(c, area));
    change({ settings: { newValue: { autoCaptions: false } } });
    change({ settings: { newValue: { autoCaptions: true } } }, 'sync');
    change({ other: { newValue: { autoCaptions: true } } });
    change({ settings: {} });
    addLeave();
    await step();
    expect(cc.onclick).not.toHaveBeenCalled();
    change({ settings: { newValue: { autoCaptions: true } } });
    await step();
    expect(cc.onclick).toHaveBeenCalledTimes(1);
  });

  it('暫停時不點；繼續時重設次數', async () => {
    await boot();
    const cc = ccButton();
    addLeave();
    await step();
    expect(cc.onclick).toHaveBeenCalledTimes(1);
    expect(await setRecording(false)).toEqual({ recording: false });
    await step(3);
    expect(cc.onclick).toHaveBeenCalledTimes(1);
    expect(await setRecording(1)).toEqual({ recording: true });
    await step(5);
    expect(cc.onclick).toHaveBeenCalledTimes(4);
  });

  it('新會議重設次數', async () => {
    await boot();
    const cc = ccButton();
    addLeave();
    await step(3);
    await endCall();
    addLeave();
    await step();
    expect(cc.onclick).toHaveBeenCalledTimes(4);
  });
});

describe('字幕擷取', () => {
  it('擷取、就地更新、儲存', async () => {
    await inCall();
    const region = addRegion();
    await step();
    expect((await status()).captionsFound).toBe(true);
    vi.setSystemTime(START + 5000);
    const a = addBlock(region, 'Amy', 'hello');
    await settle();
    expect(await status()).toMatchObject({ count: 1, last: { speaker: 'Amy', text: 'hello', t: 4250 } });
    setText(a, 'hello world');
    await settle();
    expect((await status()).last).toEqual({ speaker: 'Amy', text: 'hello world', t: 4250 });
    expect((await status()).count).toBe(1);
    await step(3);
    const saved = env.data[`meeting:abc-defg-hij_${START + 1000}`];
    expect(saved.entries).toEqual([{ speaker: 'Amy', text: 'hello world', t: 4250 }]);
  });

  it('字幕區選擇器', async () => {
    for (const html of [
      '<div role="region" aria-label="Live CAPTIONS"></div>',
      '<div role="region" aria-label="即時字幕"></div>',
      '<div jsname="dsyhDe"></div>'
    ]) {
      await inCall({ html });
      await step();
      expect((await status()).captionsFound).toBe(true);
    }
    await inCall({ html: '<div aria-label="Captions"></div><div role="region" aria-label="Chat"></div>' });
    await step();
    expect((await status()).captionsFound).toBe(false);
  });

  it('字幕區沒變時不重新附加', async () => {
    const Real = window.MutationObserver;
    const made = vi.fn();
    vi.stubGlobal('MutationObserver', class extends Real { constructor(cb) { super(cb); made(); } });
    await inCall();
    addRegion();
    await step(5);
    expect(made).toHaveBeenCalledTimes(1);
  });

  it('直接修改文字節點（characterData）也會擷取', async () => {
    await inCall();
    const region = addRegion();
    await step();
    const a = addBlock(region, 'A', 'one');
    await settle();
    a.querySelector('.ygicle').firstChild.data = 'one two';
    await settle();
    expect((await status()).last.text).toBe('one two');
  });

  it('區塊沒有講者元素', async () => {
    await inCall();
    const region = addRegion();
    await step();
    const el = document.createElement('div');
    el.className = 'nMcdL';
    el.innerHTML = '<div class="ygicle">solo</div>';
    region.append(el);
    await settle();
    expect((await status()).last).toEqual({ speaker: '未知', text: 'solo', t: 1250 });
  });

  it('附加字幕區時立即排程掃描', async () => {
    await inCall();
    const region = addRegion();
    addBlock(region, 'Amy', 'pre-existing');
    await step();
    vi.advanceTimersByTime(249);
    await tick();
    expect((await status()).count).toBe(0);
    vi.advanceTimersByTime(1);
    expect((await status()).count).toBe(1);
  });

  it('掃描去抖動：250ms 內多次變動只掃一次', async () => {
    await inCall();
    const region = addRegion();
    await step();
    const scanSpy = vi.spyOn(Element.prototype, 'querySelectorAll');
    addBlock(region, 'A', 'x');
    await tick();
    addBlock(region, 'B', 'y');
    await tick();
    vi.advanceTimersByTime(250);
    const scans = scanSpy.mock.calls.filter(([sel]) => sel === '.nMcdL').length;
    expect(scans).toBe(1);
    expect((await status()).count).toBe(2);
  });

  it('同一區塊換講者時另開新條目', async () => {
    await inCall();
    const region = addRegion();
    await step();
    const a = addBlock(region, 'Amy', 'one');
    await settle();
    setSpeaker(a, 'Bob');
    setText(a, 'two');
    await settle();
    const m = await endCall();
    expect(m.entries.map((e) => [e.speaker, e.text])).toEqual([['Amy', 'one'], ['Bob', 'two']]);
  });

  it('講者名稱暫時消失時沿用', async () => {
    await inCall();
    const region = addRegion();
    await step();
    const a = addBlock(region, 'Amy', 'one');
    await settle();
    setSpeaker(a, '');
    setText(a, 'one two');
    await settle();
    expect((await endCall()).entries).toEqual([{ speaker: 'Amy', text: 'one two', t: 1250 }]);
  });

  it('沒有講者的新區塊沿用上一位，第一位則是「未知」', async () => {
    await inCall();
    const region = addRegion();
    await step();
    addBlock(region, '', 'first');
    await settle();
    addBlock(region, 'Amy', 'a');
    await settle();
    addBlock(region, '', 'b');
    await settle();
    const m = await endCall();
    expect(m.entries.map((e) => e.speaker)).toEqual(['未知', 'Amy', 'Amy']);
  });

  it('空白文字略過；條目文字被清空時不存', async () => {
    await inCall();
    const region = addRegion();
    await step();
    addBlock(region, 'A', 'real');
    await settle();
    addBlock(region, 'B', '   ');
    await settle();
    expect((await status()).count).toBe(1);
    expect((await status()).last.speaker).toBe('A');
    const el = addBlock(region, 'A', 'x');
    el.querySelector('.ygicle').remove();
    await settle();
    expect((await status()).count).toBe(1);
    expect((await endCall()).entries.map((e) => e.text)).toEqual(['real']);
  });

  it('換講者但原條目還沒文字時沿用原條目', async () => {
    await inCall();
    const region = addRegion();
    await step();
    const a = addBlock(region, 'Amy', 'x');
    await settle();
    // 讓條目文字變成空字串：模擬 merge 後為空（直接透過 KcIKyf/bh44bd 備援選擇器）
    a.innerHTML = '<span class="KcIKyf">Bob</span><div class="bh44bd">y</div>';
    await settle();
    expect((await endCall()).entries.map((e) => [e.speaker, e.text])).toEqual([['Amy', 'x'], ['Bob', 'y']]);
  });

  it('頭像備援解析', async () => {
    await inCall();
    const region = addRegion();
    await step();
    region.innerHTML = `
      <div id="b1"><div><img></div><div>Amy</div><div>hello <i>there</i></div></div>
      <div id="b2"><img><img><span>Bob</span><span>yo</span></div>
      <div id="b3"><img></div>`;
    await settle();
    const m = await endCall();
    expect(m.entries.map((e) => [e.speaker, e.text])).toEqual([['Amy', 'hello there'], ['Bob', 'yo']]);
  });

  it('頭像備援：各區塊都只有一行時不把整個字幕區當成區塊', async () => {
    await inCall();
    const region = addRegion();
    await step();
    region.innerHTML = '<div><img><span>Amy</span></div><div><img><span>Bob</span></div>';
    await settle();
    expect((await status()).count).toBe(0);
  });

  it('頭像備援：頭像直接在字幕區下', async () => {
    await inCall();
    const region = addRegion();
    await step();
    region.innerHTML = '<img><span>Amy</span><span>hi</span>';
    await settle();
    expect((await status()).count).toBe(0);
  });

  it('頭像備援：只有名字的區塊不收', async () => {
    await inCall();
    const region = addRegion();
    await step();
    region.innerHTML = '<div><img><span>Amy</span></div>';
    await settle();
    expect((await status()).count).toBe(0);
  });

  it('字幕區被替換或移除時重新附加', async () => {
    await inCall();
    const r1 = addRegion();
    await step();
    r1.remove();
    await step();
    expect((await status()).captionsFound).toBe(false);
    addBlock(r1, 'Old', 'ignored');
    await settle();
    const r2 = addRegion();
    await step();
    addBlock(r2, 'New', 'kept');
    await settle();
    await step();
    addBlock(r2, 'New2', 'also');
    await settle();
    expect((await endCall()).entries.map((e) => e.speaker)).toEqual(['New', 'New2']);
  });

  it('暫停時不擷取，繼續後補掃', async () => {
    await inCall();
    const region = addRegion();
    await step();
    await setRecording(false);
    addBlock(region, 'A', 'while paused');
    await settle();
    expect((await status())).toMatchObject({ recording: false, count: 0 });
    await setRecording(true);
    vi.advanceTimersByTime(250);
    expect((await status()).count).toBe(1);
  });

  it('會議結束後字幕變動不再記錄', async () => {
    await inCall();
    const region = addRegion();
    await step();
    await endCall();
    addBlock(region, 'A', 'late');
    await settle();
    await setRecording(true);
    vi.advanceTimersByTime(250);
    expect((await status()).count).toBe(0);
  });

  it('結束時先做最後一次掃描', async () => {
    await inCall();
    const region = addRegion();
    await step();
    const a = addBlock(region, 'A', 'x');
    await settle();
    setText(a, 'x y');
    window.dispatchEvent(new Event('pagehide'));
    expect(sent('MEETING_ENDED')[0].meeting.entries[0].text).toBe('x y');
  });

  it('未知訊息不回覆', async () => {
    await boot();
    const reply = vi.fn();
    env.listeners.message[0]({ type: 'X' }, {}, reply);
    expect(reply).not.toHaveBeenCalled();
  });
});

describe('儲存', () => {
  const key = `meeting:abc-defg-hij_${START + 1000}`;

  it('每 3 秒、有變更才存', async () => {
    await inCall();
    const region = addRegion();
    await step();
    const a = addBlock(region, 'A', 'x');
    await settle();
    expect(env.chrome.storage.local.set).not.toHaveBeenCalled();
    await step(1);
    expect(env.chrome.storage.local.set).not.toHaveBeenCalled();
    await step(1);
    expect(env.chrome.storage.local.set).toHaveBeenCalledTimes(1);
    await step(5);
    expect(env.chrome.storage.local.set).toHaveBeenCalledTimes(1);
    setText(a, 'x y');
    await settle();
    await step(1);
    expect(env.chrome.storage.local.set).toHaveBeenCalledTimes(2);
    expect(env.data[key].entries[0].text).toBe('x y');
  });

  it('儲存的是副本', async () => {
    await inCall();
    const region = addRegion();
    await step();
    const a = addBlock(region, 'A', 'x');
    await settle();
    env.chrome.storage.local.set.mockImplementation(async (o) => { Object.assign(env.data, o); });
    await step(3);
    setText(a, 'x y');
    await settle();
    expect(env.data[key].entries[0].text).toBe('x');
    expect(env.data[key].entries).not.toBe(undefined);
  });

  it('儲存失敗時下次重試', async () => {
    await inCall();
    const region = addRegion();
    await step();
    addBlock(region, 'A', 'x');
    await settle();
    env.chrome.storage.local.set.mockRejectedValueOnce(new Error('quota'));
    await step(3);
    expect(env.chrome.storage.local.set).toHaveBeenCalledTimes(1);
    expect(env.data[key]).toBeUndefined();
    await step(3);
    expect(env.chrome.storage.local.set).toHaveBeenCalledTimes(2);
    expect(env.data[key].entries).toHaveLength(1);
  });
});

describe('字幕文字合併', () => {
  async function merge(...texts) {
    await inCall();
    const region = addRegion();
    await step();
    const el = addBlock(region, 'A', texts[0]);
    await settle();
    for (const t of texts.slice(1)) {
      setText(el, t);
      await settle();
    }
    return (await status()).last.text;
  }

  it('修正字幕（開頭 15 字相同）採用新文字', async () => {
    expect(await merge('abcdefghijklmnoXYZ', 'abcdefghijklmnoQ')).toBe('abcdefghijklmnoQ');
  });

  it('短文字整段相同前綴', async () => {
    expect(await merge('abc', 'abcd')).toBe('abcd');
  });

  it('只有前 14 字相同時不算修正', async () => {
    expect(await merge('abcdefghijklmnoXYZ', 'abcdefghijklmnQ')).toBe('abcdefghijklmnoXYZ abcdefghijklmnQ');
  });

  it('開頭被裁掉：重疊 8 字以上接起來', async () => {
    expect(await merge('0123456789ABCDEFGH', 'ABCDEFGH-new')).toBe('0123456789ABCDEFGH-new');
  });

  it('重疊剛好 8 字', async () => {
    expect(await merge('zzzzzzzzzz12345678', '12345678tail')).toBe('zzzzzzzzzz12345678tail');
  });

  it('重疊 7 字不接（且找不到 12 字開頭）', async () => {
    expect(await merge('zzzzzzzzzzz1234567', '1234567tail')).toBe('zzzzzzzzzzz1234567 1234567tail');
  });

  it('選最長的重疊', async () => {
    expect(await merge('qqqqqqqqqqabababababababab', 'abababababababab!')).toBe('qqqqqqqqqqabababababababab!');
  });

  it('新文字比舊文字長時重疊上限取較短者', async () => {
    expect(await merge('xxxxxxxxxxxxxxxxxxxx12345678', '12345678' + 'y'.repeat(40))).toBe('xxxxxxxxxxxxxxxxxxxx12345678' + 'y'.repeat(40));
  });

  it('開頭被裁掉且結尾被修正：從 12 字開頭定位', async () => {
    expect(await merge('PREFIX----------abcdefghijkl-old-end', 'abcdefghijkl-new-end')).toBe('PREFIX----------abcdefghijkl-new-end');
  });

  it('12 字開頭在最前面時不算定位（idx 0）', async () => {
    expect(await merge('abcdefghijkl12-------------', 'abcdefghijkl99')).toBe('abcdefghijkl12------------- abcdefghijkl99');
  });

  it('定位使用最後出現的位置', async () => {
    expect(await merge('Xabcdefghijkl-1-abcdefghijkl-2', 'abcdefghijkl-3')).toBe('Xabcdefghijkl-1-abcdefghijkl-3');
  });

  it('只比對新文字前 12 字', async () => {
    expect(await merge('PREFIX---abcdefghijkl', 'abcdefghijklm')).toBe('PREFIX---abcdefghijklm');
  });

  it('短新文字用全部當開頭', async () => {
    expect(await merge('XXabcdefg!zz', 'abcdefg!')).toBe('XXabcdefg!');
  });

  it('完全不同：較長或等長的新文字取代', async () => {
    expect(await merge('aaaa', 'bbbb')).toBe('bbbb');
    expect(await merge('aaaa', 'bbbbb')).toBe('bbbbb');
  });

  it('完全不同且較短：附加', async () => {
    expect(await merge('aaaaa', 'bbbb')).toBe('aaaaa bbbb');
  });

  it('文字沒變不標記變更', async () => {
    await inCall();
    const region = addRegion();
    await step();
    const el = addBlock(region, 'A', 'same');
    await settle();
    await step(3);
    expect(env.chrome.storage.local.set).toHaveBeenCalledTimes(1);
    setText(el, 'same');
    await settle();
    await step(3);
    expect(env.chrome.storage.local.set).toHaveBeenCalledTimes(1);
  });
});
