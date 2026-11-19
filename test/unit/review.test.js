import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeChrome, tick, loadBody } from '../helpers/chrome.js';

const summarizeTranscript = vi.fn();
const aiStatus = vi.fn();
const saveMeetingToNotion = vi.fn();

const T1 = Date.UTC(2024, 0, 2, 7, 4, 5);
const T2 = Date.UTC(2024, 0, 3, 7, 4, 5);

const M1 = {
  id: 'abc-defg-hij_1', meetCode: 'abc-defg-hij', title: '週會', url: 'https://meet.google.com/abc-defg-hij',
  startedAt: T1, endedAt: T1 + 65 * 60000,
  entries: [{ t: 0, speaker: 'Amy', text: 'hi <b>' }, { t: 61000, speaker: 'Bob', text: 'yo' }]
};
const M2 = { id: 'x y', meetCode: 'xyz', title: '', url: '', startedAt: T2, endedAt: null, entries: [] };

let env;
const $ = (s) => document.querySelector(s);

async function boot({ data = { 'meeting:abc-defg-hij_1': M1, 'meeting:x y': M2 }, hash = '', settings } = {}) {
  env = makeChrome({ ...data, ...(settings ? { settings } : {}) });
  history.replaceState(null, '', '/review.html' + hash);
  loadBody('review.html');
  vi.resetModules();
  vi.doMock('../../lib/ai.js', async (orig) => ({ ...(await orig()), summarizeTranscript, aiStatus }));
  vi.doMock('../../lib/notion.js', () => ({ saveMeetingToNotion }));
  await import('../../review.js');
  await tick();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(Date.UTC(2024, 5, 1));
  summarizeTranscript.mockReset();
  aiStatus.mockReset().mockResolvedValue({ api: 'prompt', availability: 'available' });
  saveMeetingToNotion.mockReset();
  vi.stubGlobal('confirm', vi.fn(() => true));
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => {}) }, configurable: true });
});
const winListeners = [];
const realAdd = window.addEventListener.bind(window);
window.addEventListener = (type, fn, opts) => { winListeners.push([type, fn, opts]); realAdd(type, fn, opts); };
afterEach(() => {
  vi.useRealTimers();
  for (const [type, fn, opts] of winListeners.splice(0)) window.removeEventListener(type, fn, opts);
});

const items = () => [...document.querySelectorAll('#list li')];

describe('列表', () => {
  it('依時間新到舊，預設選第一個', async () => {
    await boot({ data: { 'meeting:abc-defg-hij_1': M1, 'meeting:x y': M2, settings: {}, other: 1 } });
    expect($('#list').innerHTML).toMatchInlineSnapshot(`
      "
          <li data-id="x y" class="active">
            <div class="t">xyz</div>
            <div class="small muted">2024年1月3日 下午3:04 · 0 段 · <span class="live">● 進行中</span></div>
          </li>
          <li data-id="abc-defg-hij_1" class="">
            <div class="t">週會</div>
            <div class="small muted">2024年1月2日 下午3:04 · 2 段</div>
          </li>"
    `);
  });

  it('網址 hash 指定目前會議，標題優先用 meta 並標示已存 Notion', async () => {
    await boot({
      hash: '#abc-defg-hij_1',
      data: {
        'meeting:abc-defg-hij_1': M1,
        'meeting:x y': M2,
        'meta:abc-defg-hij_1': { title: '<改>', notionUrl: 'https://n/1' }
      }
    });
    const [a, b] = items();
    expect(a.className).toBe('');
    expect(b.className).toBe('active');
    expect(b.querySelector('.t').innerHTML).toBe('✅ &lt;改&gt;');
  });

  it('hash 經過 URL 解碼', async () => {
    await boot({ hash: '#x%20y' });
    expect(items()[0].className).toBe('active');
    expect($('#title').value).toBe('xyz');
  });

  it('hash 不存在時退回第一個', async () => {
    await boot({ hash: '#nope' });
    expect(items()[0].className).toBe('active');
  });

  it('點選切換並更新網址', async () => {
    await boot();
    items()[1].querySelector('.t').click();
    expect(items()[1].className).toBe('active');
    expect(location.hash).toBe('#abc-defg-hij_1');
    expect($('#title').value).toBe('週會');
    items()[0].click();
    expect(location.hash).toBe('#x%20y');
  });

  it('點到列表空白處不切換', async () => {
    await boot();
    $('#list').click();
    expect(items()[0].className).toBe('active');
    expect(location.hash).toBe('');
  });
});

describe('詳細內容', () => {
  it('沒有會議', async () => {
    await boot({ data: {} });
    expect($('#detail').innerHTML).toBe('<div class="empty">還沒有會議記錄。加入 Google Meet 後會自動開始擷取字幕。</div>');
    expect($('#list').innerHTML).toBe('');
  });

  it('完整會議', async () => {
    await boot({
      hash: '#abc-defg-hij_1',
      data: { 'meeting:abc-defg-hij_1': M1, 'meta:abc-defg-hij_1': { summary: '## 重點 <x>', notionUrl: 'https://n/"1' } }
    });
    expect($('#detail').innerHTML).toMatchInlineSnapshot(`
      "
          <input id="title" type="text" value="週會" aria-label="會議標題">
          <div class="muted">2024年1月2日 下午3:04 · 1 小時 5 分鐘 · 2 段
            
             · <a href="https://meet.google.com/abc-defg-hij" target="_blank">abc-defg-hij</a></div>
          <div class="muted">👥 Amy、Bob</div>

          <section>
            <h2>摘要</h2>
            <div class="row" style="margin-bottom:8px">
              <button id="ai">✨ 用 Chrome 內建 AI 產生</button>
              <button id="claude">📋 複製給 Claude 整理</button>
              <span class="small muted">（貼到 claude.ai，再把結果貼回下方）</span>
            </div>
            <textarea id="summary" placeholder="## 重點摘要
      - …
      ## 決議事項
      - …
      ## 待辦事項
      - [ ] 負責人：事項">## 重點 &lt;x&gt;</textarea>
            <div id="aiStatus" class="status"></div>
          </section>

          <section>
            <div class="row">
              <button id="notion" class="primary">再存一份到 Notion</button>
              <button id="md">下載 Markdown</button>
              <button id="del" class="danger">刪除</button>
              <a href="https://n/&quot;1" target="_blank">開啟 Notion 頁面 ↗</a>
            </div>
            <div id="saveStatus" class="status"></div>
          </section>

          <section>
            <h2>逐字稿</h2>
            <div class="card transcript" id="transcript">
          <div class="line"><span class="time">00:00:00</span><span><b>Amy</b>hi &lt;b&gt;</span></div>
          <div class="line"><span class="time">00:01:01</span><span><b>Bob</b>yo</span></div></div>
          </section>"
    `);
  });

  it('進行中、沒有連結/講者/摘要/逐字稿', async () => {
    await boot({ hash: '#x%20y' });
    expect($('#detail').innerHTML).toMatchInlineSnapshot(`
      "
          <input id="title" type="text" value="xyz" aria-label="會議標題">
          <div class="muted">2024年1月3日 下午3:04 · 0 分鐘 · 0 段
             · <span class="live">● 會議進行中</span>
            </div>
          

          <section>
            <h2>摘要</h2>
            <div class="row" style="margin-bottom:8px">
              <button id="ai">✨ 用 Chrome 內建 AI 產生</button>
              <button id="claude">📋 複製給 Claude 整理</button>
              <span class="small muted">（貼到 claude.ai，再把結果貼回下方）</span>
            </div>
            <textarea id="summary" placeholder="## 重點摘要
      - …
      ## 決議事項
      - …
      ## 待辦事項
      - [ ] 負責人：事項"></textarea>
            <div id="aiStatus" class="status"></div>
          </section>

          <section>
            <div class="row">
              <button id="notion" class="primary">儲存到 Notion</button>
              <button id="md">下載 Markdown</button>
              <button id="del" class="danger">刪除</button>
              
            </div>
            <div id="saveStatus" class="status"></div>
          </section>

          <section>
            <h2>逐字稿</h2>
            <div class="card transcript" id="transcript"><span class="muted">尚無內容</span></div>
          </section>"
    `);
  });

  it('沒有任何標題時顯示空字串', async () => {
    await boot({ data: { 'meeting:a': { ...M2, id: 'a', meetCode: undefined } } });
    expect(items()[0].querySelector('.t').innerHTML).toBe('');
    expect($('#title').value).toBe('');
  });

  it('標題屬性值會跳脫', async () => {
    await boot({ data: { 'meeting:a': { ...M2, id: 'a', title: `"&'<>` } } });
    expect($('#title').value).toBe(`"&'<>`);
  });

  it('沒有內建 AI 時停用按鈕', async () => {
    aiStatus.mockResolvedValue({ api: null });
    await boot();
    expect($('#ai').disabled).toBe(true);
    expect($('#ai').title).toBe('此 Chrome 無內建 AI');
  });

  it('有內建 AI 時可用', async () => {
    await boot();
    expect($('#ai').disabled).toBe(false);
    expect($('#ai').title).toBe('');
  });
});

describe('編輯', () => {
  it('修改標題（去空白）並更新列表', async () => {
    await boot();
    $('#title').value = '  新標題 ';
    $('#title').dispatchEvent(new Event('change'));
    await tick();
    expect(env.data['meta:x y']).toEqual({ title: '新標題' });
    expect(items()[0].querySelector('.t').textContent).toBe('新標題');
  });

  it('摘要輸入 400ms 去抖動後保存，保留既有 meta', async () => {
    await boot({ hash: '#abc-defg-hij_1', data: { 'meeting:abc-defg-hij_1': M1, 'meta:abc-defg-hij_1': { title: 'T' } } });
    const input = (v) => { $('#summary').value = v; $('#summary').dispatchEvent(new Event('input')); };
    input('a');
    vi.advanceTimersByTime(300);
    input('ab');
    vi.advanceTimersByTime(399);
    expect(env.chrome.storage.local.set).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await tick();
    expect(env.chrome.storage.local.set).toHaveBeenCalledTimes(1);
    expect(env.data['meta:abc-defg-hij_1']).toEqual({ title: 'T', summary: 'ab' });
  });
});

describe('AI 摘要', () => {
  it('成功', async () => {
    await boot({ hash: '#abc-defg-hij_1', settings: { aiLang: 'en', notionToken: 't', notionTarget: 'x' } });
    let finish;
    summarizeTranscript.mockImplementation((text, lang, onStatus) => {
      onStatus('進行中');
      return new Promise((r) => { finish = r; });
    });
    $('#ai').click();
    await tick();
    expect($('#ai').disabled).toBe(true);
    expect($('#aiStatus').textContent).toBe('進行中');
    expect($('#aiStatus').className).toBe('status ');
    expect(summarizeTranscript).toHaveBeenCalledWith('[00:00:00] Amy：hi <b>\n[00:01:01] Bob：yo', 'en', expect.any(Function));
    $('#ai').click();
    $('#notion').click();
    await tick();
    expect(summarizeTranscript).toHaveBeenCalledTimes(1);
    expect(saveMeetingToNotion).not.toHaveBeenCalled();
    finish('## 摘要');
    await tick();
    expect($('#summary').value).toBe('## 摘要');
    expect(env.data['meta:abc-defg-hij_1']).toEqual({ summary: '## 摘要' });
    expect($('#aiStatus').textContent).toBe('完成，可直接修改後再存到 Notion。');
    expect($('#aiStatus').className).toBe('status ok');
    expect($('#ai').disabled).toBe(false);
    $('#ai').click();
    await tick();
    expect(summarizeTranscript).toHaveBeenCalledTimes(2);
  });

  it('失敗', async () => {
    await boot();
    summarizeTranscript.mockRejectedValue(new Error('沒模型'));
    $('#ai').click();
    await tick();
    expect($('#aiStatus').textContent).toBe('AI 失敗：沒模型');
    expect($('#aiStatus').className).toBe('status err');
    expect($('#ai').disabled).toBe(false);
  });

  it('畫面已切換時不會出錯', async () => {
    await boot();
    let fail;
    summarizeTranscript.mockReturnValue(new Promise((_, r) => { fail = r; }));
    $('#ai').click();
    await tick();
    $('#detail').innerHTML = '';
    fail(new Error('x'));
    await tick();
    expect($('#ai')).toBeNull();
  });
});

describe('複製給 Claude', () => {
  it('複製提示詞', async () => {
    await boot({ hash: '#abc-defg-hij_1', data: { 'meeting:abc-defg-hij_1': M1, 'meta:abc-defg-hij_1': { title: '改名' } } });
    $('#claude').click();
    await tick();
    const text = navigator.clipboard.writeText.mock.calls[0][0];
    expect(text.split('\n').slice(-6)).toEqual([
      '會議：改名', '時間：2024年1月2日 下午3:04', '', '逐字稿：', '[00:00:00] Amy：hi <b>', '[00:01:01] Bob：yo'
    ]);
    expect($('#aiStatus').textContent).toBe(`已複製（${text.length} 字），貼到 claude.ai 後把結果貼回上方即可。`);
    expect($('#aiStatus').className).toBe('status ok');
  });
});

describe('存到 Notion', () => {
  it.each([
    [{}],
    [{ notionToken: 't' }],
    [{ notionTarget: 'x' }]
  ])('未設定 %j', async (settings) => {
    await boot({ settings });
    $('#notion').click();
    await tick();
    expect($('#saveStatus').textContent).toBe('尚未設定 Notion（選用）。可以先用「下載 Markdown」，或到「設定」填入 Notion Token 與目標頁面/資料庫。');
    expect($('#saveStatus').className).toBe('status err');
    expect(saveMeetingToNotion).not.toHaveBeenCalled();
    expect($('#notion').disabled).toBe(false);
  });

  it('成功後重新繪製', async () => {
    await boot({ hash: '#abc-defg-hij_1', settings: { notionToken: 't', notionTarget: 'x' } });
    let finish;
    saveMeetingToNotion.mockImplementation(({ onStatus }) => {
      onStatus('寫入中');
      return new Promise((r) => { finish = r; });
    });
    $('#summary').value = '摘要';
    $('#notion').click();
    await tick();
    expect($('#notion').disabled).toBe(true);
    expect($('#saveStatus').textContent).toBe('寫入中');
    expect($('#saveStatus').className).toBe('status ');
    expect(saveMeetingToNotion).toHaveBeenCalledWith({
      token: 't', target: 'x', meeting: M1, title: '週會', summary: '摘要', onStatus: expect.any(Function)
    });
    $('#notion').click();
    $('#ai').click();
    await tick();
    expect(saveMeetingToNotion).toHaveBeenCalledTimes(1);
    expect(summarizeTranscript).not.toHaveBeenCalled();
    finish({ url: 'https://n/p', targetName: '會議 DB' });
    await tick();
    expect(env.data['meta:abc-defg-hij_1']).toEqual({ notionUrl: 'https://n/p', savedAt: Date.UTC(2024, 5, 1) });
    expect(items()[1].querySelector('.t').textContent).toBe('✅ 週會');
    expect($('#notion').textContent).toBe('再存一份到 Notion');
    expect($('#notion').disabled).toBe(false);
    expect($('#saveStatus').textContent).toBe('已存到「會議 DB」。');
    expect($('#saveStatus').className).toBe('status ok');
    summarizeTranscript.mockResolvedValue('ok');
    $('#ai').click();
    await tick();
    expect(summarizeTranscript).toHaveBeenCalledTimes(1);
  });

  it('失敗', async () => {
    await boot({ settings: { notionToken: 't', notionTarget: 'x' } });
    saveMeetingToNotion.mockRejectedValue(new Error('403'));
    $('#notion').click();
    await tick();
    expect($('#saveStatus').textContent).toBe('Notion 寫入失敗：403');
    expect($('#saveStatus').className).toBe('status err');
    expect($('#notion').disabled).toBe(false);
  });

  it('畫面已切換時不會出錯', async () => {
    await boot({ settings: { notionToken: 't', notionTarget: 'x' } });
    let fail;
    saveMeetingToNotion.mockReturnValue(new Promise((_, r) => { fail = r; }));
    $('#notion').click();
    await tick();
    $('#detail').innerHTML = '';
    fail(new Error('x'));
    await tick();
    expect($('#notion')).toBeNull();
  });
});

describe('下載 Markdown', () => {
  let blobs;
  let clicked;
  beforeEach(() => {
    blobs = [];
    clicked = [];
    URL.createObjectURL = vi.fn((b) => { blobs.push(b); return 'blob:1'; });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { clicked.push(this); });
  });

  it('完整內容與檔名', async () => {
    await boot({ hash: '#abc-defg-hij_1', data: { 'meeting:abc-defg-hij_1': M1, 'meta:abc-defg-hij_1': { title: 'a/b\\c:d*e?f"g<h>i|j' } } });
    $('#summary').value = '  ## 摘要\n- x  ';
    $('#md').click();
    expect(blobs[0].type).toBe('text/markdown');
    expect(await blobs[0].text()).toBe([
      '# a/b\\c:d*e?f"g<h>i|j',
      '',
      '- 時間：2024年1月2日 下午3:04（1 小時 5 分鐘）',
      '- 參與者：Amy、Bob',
      '- 會議連結：https://meet.google.com/abc-defg-hij',
      '',
      '## 摘要\n- x',
      '',
      '## 逐字稿',
      '',
      '- `00:00:00` **Amy**：hi <b>',
      '- `00:01:01` **Bob**：yo'
    ].join('\n'));
    expect(clicked).toHaveLength(1);
    expect(clicked[0].href).toBe('blob:1');
    expect(clicked[0].download).toBe('a_b_c_d_e_f_g_h_i_j_2024-01-02.md');
    vi.advanceTimersByTime(999);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1');
  });

  it('沒有講者與連結', async () => {
    await boot({ hash: '#x%20y' });
    $('#md').click();
    expect(await blobs[0].text()).toBe('# xyz\n\n- 時間：2024年1月3日 下午3:04（0 分鐘）\n- 參與者：—\n\n\n\n\n## 逐字稿\n');
  });
});

describe('刪除', () => {
  it('取消時不刪除', async () => {
    confirm.mockReturnValue(false);
    await boot();
    $('#del').click();
    await tick();
    expect(confirm).toHaveBeenCalledWith('確定刪除「xyz」的本機記錄？（不會刪除 Notion 上的頁面）');
    expect(env.chrome.storage.local.remove).not.toHaveBeenCalled();
  });

  it('確認後刪除並切到下一個', async () => {
    await boot({ data: { 'meeting:abc-defg-hij_1': M1, 'meeting:x y': M2, 'meta:x y': { title: 't' } } });
    $('#del').click();
    await tick();
    expect(env.chrome.storage.local.remove).toHaveBeenCalledWith(['meeting:x y', 'meta:x y']);
    expect(items()).toHaveLength(1);
    expect(items()[0].className).toBe('active');
    expect($('#title').value).toBe('週會');
  });
});

describe('即時更新', () => {
  const fire = async (changes, area = 'local') => {
    for (const fn of env.listeners.changed) await fn(changes, area);
    await tick();
  };

  it('忽略非 local 與非會議的變更', async () => {
    await boot();
    const before = $('#detail').firstElementChild;
    env.data['meeting:new'] = { ...M2, id: 'new', startedAt: T2 + 1 };
    await fire({ 'meeting:new': {} }, 'sync');
    await fire({ settings: {}, 'meta:x y': {} });
    expect(items()).toHaveLength(2);
    expect($('#detail').firstElementChild).toBe(before);
  });

  it('目前會議更新：只換逐字稿、保留編輯中的摘要、在底部時捲到底', async () => {
    await boot({ hash: '#x%20y' });
    $('#summary').value = '編輯中';
    const box = $('#transcript');
    Object.defineProperty(box, 'scrollHeight', { value: 500, configurable: true });
    Object.defineProperty(box, 'clientHeight', { value: 100, configurable: true });
    box.scrollTop = 380;
    env.data['meeting:x y'] = { ...M2, entries: [{ t: 1000, speaker: 'C', text: '新' }] };
    await fire({ 'meeting:x y': {} });
    expect($('#summary').value).toBe('編輯中');
    expect($('#transcript')).toBe(box);
    expect(box.innerHTML).toBe('\n    <div class="line"><span class="time">00:00:01</span><span><b>C</b>新</span></div>');
    expect(box.scrollTop).toBe(500);
    expect(items()[0].querySelector('.small').textContent).toContain('1 段');
  });

  it('不在底部時不捲動', async () => {
    await boot({ hash: '#x%20y' });
    const box = $('#transcript');
    Object.defineProperty(box, 'scrollHeight', { value: 500, configurable: true });
    Object.defineProperty(box, 'clientHeight', { value: 100, configurable: true });
    box.scrollTop = 379;
    await fire({ 'meeting:x y': {} });
    expect(box.scrollTop).toBe(379);
  });

  it('會議與其他鍵一起變更時也更新', async () => {
    await boot({ hash: '#x%20y' });
    env.data['meeting:x y'] = { ...M2, entries: [{ t: 0, speaker: 'C', text: '同批' }] };
    await fire({ 'meta:x y': {}, 'meeting:x y': {} });
    expect($('#transcript').textContent).toContain('同批');
  });

  it('更新的是目前（非第一個）會議', async () => {
    await boot({ hash: '#abc-defg-hij_1' });
    env.data['meeting:abc-defg-hij_1'] = { ...M1, entries: [{ t: 0, speaker: 'Amy', text: '更新後' }] };
    await fire({ 'meeting:abc-defg-hij_1': {} });
    expect($('#transcript').textContent).toBe('\n    00:00:00Amy更新後');
  });

  it('其他會議更新時不動逐字稿', async () => {
    await boot({ hash: '#x%20y' });
    const box = $('#transcript');
    const child = box.firstElementChild;
    await fire({ 'meeting:abc-defg-hij_1': {} });
    expect(box.firstElementChild).toBe(child);
    expect($('#transcript')).toBe(box);
  });

  it('目前會議被刪除時重繪', async () => {
    await boot({ hash: '#x%20y' });
    delete env.data['meeting:x y'];
    await fire({ 'meeting:x y': {} });
    expect($('#title').value).toBe('週會');
  });

  it('原本沒有會議、新會議出現時重繪', async () => {
    await boot({ data: {} });
    env.data['meeting:x y'] = M2;
    await fire({ 'meeting:x y': {} });
    expect($('#title').value).toBe('xyz');
  });

  it('沒有逐字稿區塊時重繪', async () => {
    await boot();
    $('#detail').innerHTML = '';
    await fire({ 'meeting:x y': {} });
    expect($('#title').value).toBe('xyz');
  });
});

describe('hashchange', () => {
  it('切換到 hash 指定的會議', async () => {
    await boot();
    history.replaceState(null, '', '#abc-defg-hij_1');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await tick();
    expect($('#title').value).toBe('週會');
  });

  it('空 hash 保留目前會議', async () => {
    await boot();
    items()[1].click();
    history.replaceState(null, '', location.pathname);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await tick();
    expect($('#title').value).toBe('週會');
  });
});
