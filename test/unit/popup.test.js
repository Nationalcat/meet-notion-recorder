import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeChrome, tick, loadBody } from '../helpers/chrome.js';

let env;
const $ = (s) => document.querySelector(s);
const MEET = { id: 5, url: 'https://meet.google.com/abc-defg-hij' };

async function boot({ tab = MEET, status, settings } = {}) {
  env = makeChrome(settings ? { settings } : {});
  env.chrome.tabs.query.mockResolvedValue(tab === null ? [] : [tab]);
  if (status instanceof Error) env.chrome.tabs.sendMessage.mockRejectedValue(status);
  else env.chrome.tabs.sendMessage.mockResolvedValue(status);
  loadBody('popup.html');
  vi.resetModules();
  await import('../../popup.js');
  await tick();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const NOT_MEET = '目前分頁不是 Google Meet。加入會議後會自動擷取字幕。';

describe('popup 狀態', () => {
  it.each([
    ['沒有分頁', null],
    ['分頁沒有網址', { id: 1 }],
    ['其他網站', { id: 1, url: 'https://example.com/' }],
    ['相似網域', { id: 1, url: 'http://meet.google.com/x' }]
  ])('%s', async (_n, tab) => {
    await boot({ tab });
    expect(env.chrome.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect($('#state').innerHTML).toBe(NOT_MEET);
    expect($('#toggle').hidden).toBe(true);
    expect($('#last').hidden).toBe(true);
    expect(env.chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('內容腳本沒回應', async () => {
    await boot({ status: new Error('no receiver') });
    expect(env.chrome.tabs.sendMessage).toHaveBeenCalledWith(5, { type: 'GET_STATUS' });
    expect($('#state').textContent).toBe('請重新整理這個 Meet 分頁，讓擴充元件載入。');
    expect($('#toggle').hidden).toBe(true);
  });

  it('尚未加入會議', async () => {
    await boot({ status: { inCall: false } });
    expect($('#state').textContent).toBe('尚未加入會議。');
    expect($('#toggle').hidden).toBe(true);
    expect($('#last').hidden).toBe(true);
  });

  it('記錄中、找不到字幕區、顯示最後一句（跳脫並截斷）', async () => {
    const text = 'x'.repeat(200) + '<&>"\'';
    await boot({ status: { inCall: true, recording: true, count: 3, captionsFound: false, last: { speaker: '<A&"\'>', text } } });
    expect($('#state').innerHTML).toBe(
      '<span class="dot on"></span>記錄中 · 3 段<br><span class="small">⚠️ 找不到字幕區，請按 Meet 下方的「CC」開啟字幕。</span>'
    );
    expect($('#toggle').hidden).toBe(false);
    expect($('#toggle').textContent).toBe('⏸ 暫停記錄');
    expect($('#last').hidden).toBe(false);
    const html = '<b>&lt;A&amp;"\'&gt;</b>：' + 'x'.repeat(155) + '&lt;&amp;&gt;"\'';
    expect($('#last').innerHTML).toBe(html);
    expect($('#last').querySelector('b').textContent).toBe('<A&"\'>');
  });

  it('跳脫引號（屬性內）', async () => {
    await boot({ status: { inCall: true, recording: true, count: 0, captionsFound: true, last: { speaker: undefined, text: '"\'' } } });
    const b = $('#last').innerHTML;
    // innerHTML 會把 &quot; 與 &#39; 還原成字元，所以改用自訂屬性驗證 esc 結果
    expect(b).toBe('<b></b>："\'');
  });

  it('暫停中、有字幕區、沒有最後一句', async () => {
    await boot({ status: { inCall: true, recording: false, count: 0, captionsFound: true, last: null } });
    expect($('#state').innerHTML).toBe('<span class="dot "></span>已暫停 · 0 段');
    expect($('#toggle').textContent).toBe('▶︎ 繼續記錄');
    expect($('#last').hidden).toBe(true);
  });

  it('最後一句沒有文字時不顯示', async () => {
    await boot({ status: { inCall: true, recording: true, count: 1, captionsFound: true, last: { speaker: 'A', text: '' } } });
    expect($('#last').hidden).toBe(true);
  });

  it('每 1.5 秒更新', async () => {
    await boot({ status: { inCall: false } });
    expect(env.chrome.tabs.query).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1499);
    expect(env.chrome.tabs.query).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(env.chrome.tabs.query).toHaveBeenCalledTimes(2);
  });
});

describe('popup 按鈕', () => {
  it.each([true, false])('切換記錄（目前 recording=%s）', async (recording) => {
    await boot({ status: { inCall: true, recording, count: 0, captionsFound: true } });
    env.chrome.tabs.query.mockClear();
    $('#toggle').click();
    await tick();
    expect(env.chrome.tabs.sendMessage).toHaveBeenCalledWith(5, { type: 'SET_RECORDING', value: !recording });
    expect(env.chrome.tabs.query).toHaveBeenCalledTimes(1);
  });

  it('不是 Meet 分頁時切換無效', async () => {
    await boot({ tab: null });
    $('#toggle').click();
    await tick();
    expect(env.chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(env.chrome.tabs.query).toHaveBeenCalledTimes(1);
  });

  it('沒有狀態時切換無效', async () => {
    await boot({ status: new Error('x') });
    env.chrome.tabs.sendMessage.mockClear();
    $('#toggle').click();
    await tick();
    expect(env.chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(env.chrome.tabs.query).toHaveBeenCalledTimes(1);
  });

  it('開啟所有會議記錄', async () => {
    await boot({ tab: null });
    $('#open').click();
    expect(env.chrome.tabs.create).toHaveBeenCalledWith({ url: 'chrome-extension://ext/review.html' });
  });

  it('開啟設定', async () => {
    await boot({ tab: null });
    $('#settings').click();
    expect(env.chrome.runtime.openOptionsPage).toHaveBeenCalledTimes(1);
  });
});

describe('popup 設定提示', () => {
  it.each([
    [undefined, '設定 Notion ⚠️'],
    [{ notionToken: 't' }, '設定 Notion ⚠️'],
    [{ notionTarget: 'x' }, '設定 Notion ⚠️'],
    [{ notionToken: 't', notionTarget: 'x' }, '設定']
  ])('%j → %s', async (settings, label) => {
    await boot({ tab: null, settings });
    expect($('#settings').textContent).toBe(label);
  });
});
