import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeChrome, tick, loadBody } from '../helpers/chrome.js';

const resolveTarget = vi.fn();
let env;
const $ = (s) => document.querySelector(s);

async function boot(settings) {
  env = makeChrome(settings ? { settings } : {});
  loadBody('options.html');
  vi.resetModules();
  vi.doMock('../../lib/notion.js', () => ({ resolveTarget }));
  await import('../../options.js');
}

beforeEach(() => {
  vi.useFakeTimers();
  resolveTarget.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('options', () => {
  it('以預設值填入表單', async () => {
    await boot();
    expect($('#token').value).toBe('');
    expect($('#target').value).toBe('');
    expect($('#autoCaptions').checked).toBe(true);
    expect($('#autoOpenReview').checked).toBe(true);
    expect($('#aiLang').value).toBe('zh');
  });

  it('以已儲存設定填入表單', async () => {
    await boot({ notionToken: 'tok', notionTarget: 'tgt', autoCaptions: false, autoOpenReview: false, aiLang: 'ja' });
    expect($('#token').value).toBe('tok');
    expect($('#target').value).toBe('tgt');
    expect($('#autoCaptions').checked).toBe(false);
    expect($('#autoOpenReview').checked).toBe(false);
    expect($('#aiLang').value).toBe('ja');
  });

  it('儲存：去除空白後寫入並短暫顯示狀態', async () => {
    await boot();
    $('#token').value = '  tok  ';
    $('#target').value = ' tgt ';
    $('#autoCaptions').checked = false;
    $('#aiLang').value = 'en';
    $('#save').click();
    await tick();
    expect(env.data.settings).toEqual({
      notionToken: 'tok', notionTarget: 'tgt', autoCaptions: false, autoOpenReview: true, aiLang: 'en'
    });
    expect($('#saveStatus').textContent).toBe('已儲存');
    expect($('#saveStatus').className).toBe('status ok');
    vi.advanceTimersByTime(1999);
    expect($('#saveStatus').textContent).toBe('已儲存');
    vi.advanceTimersByTime(1);
    expect($('#saveStatus').textContent).toBe('');
    expect($('#saveStatus').className).toBe('status ');
  });

  it.each([
    ['database', '資料庫'],
    ['page', '頁面']
  ])('測試連線成功（%s）並儲存', async (type, label) => {
    await boot();
    let done;
    resolveTarget.mockReturnValue(new Promise((r) => { done = r; }));
    $('#token').value = ' tok ';
    $('#target').value = ' tgt ';
    $('#autoOpenReview').checked = false;
    $('#test').click();
    expect($('#testStatus').textContent).toBe('測試中…');
    expect($('#testStatus').className).toBe('status ');
    expect(resolveTarget).toHaveBeenCalledWith('tok', 'tgt');
    done({ type, name: 'X' });
    await tick();
    expect($('#testStatus').textContent).toBe(`✅ 已連線${label}「X」，設定已儲存`);
    expect($('#testStatus').className).toBe('status ok');
    expect(env.data.settings).toEqual({
      notionToken: 'tok', notionTarget: 'tgt', autoCaptions: true, autoOpenReview: false, aiLang: 'zh'
    });
  });

  it('測試連線失敗時不儲存', async () => {
    await boot();
    resolveTarget.mockRejectedValue(new Error('壞了'));
    $('#test').click();
    await tick();
    expect($('#testStatus').textContent).toBe('❌ 壞了');
    expect($('#testStatus').className).toBe('status err');
    expect(env.data.settings).toBeUndefined();
  });
});
