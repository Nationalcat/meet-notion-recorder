// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeId, resolveTarget, markdownToBlocks, saveMeetingToNotion } from '../../lib/notion.js';

const HEX = '0123456789abcdef0123456789abcdef';
const UUID = '01234567-89ab-cdef-0123-456789abcdef';

let delays;
let fetchMock;
let routes;

const res = (status, body, { statusText = 'Status', headers = {}, badJson = false } = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  statusText,
  headers: { get: (k) => headers[k] ?? null },
  json: badJson ? async () => { throw new Error('bad json'); } : async () => body
});

beforeEach(() => {
  delays = [];
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms) => { delays.push(ms); fn(); return 0; });
  routes = [];
  fetchMock = vi.fn(async (url, init) => {
    for (const r of routes) {
      const m = r.match(url, init);
      if (m) return typeof r.reply === 'function' ? r.reply(url, init) : r.reply;
    }
    throw new Error('unexpected fetch ' + init.method + ' ' + url);
  });
  vi.stubGlobal('fetch', fetchMock);
});

const on = (method, path, reply) => routes.push({
  match: (url, init) => init.method === method && url === 'https://api.notion.com/v1' + path,
  reply
});
const bodies = (method, pathPrefix) => fetchMock.mock.calls
  .filter(([u, i]) => i.method === method && u.startsWith('https://api.notion.com/v1' + pathPrefix))
  .map(([, i]) => JSON.parse(i.body));

describe('normalizeId', () => {
  it.each([
    [HEX, UUID],
    [UUID, UUID],
    [HEX.toUpperCase(), UUID],
    [`  ${HEX}  `, UUID],
    [`https://www.notion.so/ws/Meeting-Notes-${HEX}`, UUID],
    [`https://www.notion.so/ws/${HEX}?v=ffffffffffffffffffffffffffffffff`, UUID],
    [`https://www.notion.so/ws/${HEX}#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, UUID],
    [`https://www.notion.so/${HEX}/sub`, null],
    [`x${HEX}`, UUID],
    [`9${HEX}`, UUID],
    [`${HEX}x`, null],
    [HEX.slice(1), null],
    [HEX.slice(1) + 'g', null],
    ['', null],
    [null, null],
    [undefined, null]
  ])('normalizeId(%j) = %j', (input, out) => expect(normalizeId(input)).toBe(out));
});

describe('call（透過 resolveTarget）', () => {
  it('請求格式', async () => {
    on('GET', `/databases/${UUID}`, res(200, { title: [{ plain_text: 'DB' }] }));
    await resolveTarget('tok', HEX);
    expect(fetchMock).toHaveBeenCalledWith(`https://api.notion.com/v1/databases/${UUID}`, {
      method: 'GET',
      headers: {
        Authorization: 'Bearer tok',
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: undefined
    });
  });

  it('429 依 Retry-After 重試', async () => {
    const replies = [
      res(429, {}, { headers: { 'Retry-After': '2' } }),
      res(429, {}),
      res(200, { title: [] })
    ];
    on('GET', `/databases/${UUID}`, () => replies.shift());
    expect((await resolveTarget('tok', HEX)).name).toBe('未命名資料庫');
    expect(delays).toEqual([2000, 1000]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('連續 429 第五次放棄', async () => {
    on('GET', `/databases/${UUID}`, () => res(429, { message: 'slow down', code: 'rate_limited' }));
    const err = await resolveTarget('tok', HEX).catch((e) => e);
    expect(err.message).toBe('slow down');
    expect(err.status).toBe(429);
    expect(err.code).toBe('rate_limited');
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(delays).toEqual([1000, 1000, 1000, 1000]);
  });

  it('錯誤回應不是 JSON 時用狀態碼當訊息', async () => {
    on('GET', `/databases/${UUID}`, res(500, null, { statusText: 'Server Error', badJson: true }));
    const err = await resolveTarget('tok', HEX).catch((e) => e);
    expect(err.message).toBe('500 Server Error');
    expect(err.status).toBe(500);
    expect(err.code).toBeUndefined();
  });

  it('成功回應不是 JSON 時回傳空物件', async () => {
    on('GET', `/databases/${UUID}`, res(200, null, { badJson: true }));
    expect(await resolveTarget('tok', HEX)).toEqual({ type: 'database', id: UUID, db: {}, name: '未命名資料庫' });
  });
});

describe('resolveTarget', () => {
  it('沒有 token', async () => {
    await expect(resolveTarget('', HEX)).rejects.toThrow('尚未設定 Notion Integration Token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ID 格式錯誤', async () => {
    await expect(resolveTarget('tok', 'nope')).rejects.toThrow('Notion 目標網址或 ID 格式不正確');
  });

  it('資料庫', async () => {
    const db = { title: [{ plain_text: '會議' }, { plain_text: '記錄' }] };
    on('GET', `/databases/${UUID}`, res(200, db));
    expect(await resolveTarget('tok', HEX)).toEqual({ type: 'database', id: UUID, db, name: '會議記錄' });
  });

  it('token 無效', async () => {
    on('GET', `/databases/${UUID}`, res(401, {}));
    await expect(resolveTarget('tok', HEX)).rejects.toThrow('Token 無效，請重新複製 Integration Secret');
  });

  it('其他錯誤直接拋出', async () => {
    on('GET', `/databases/${UUID}`, res(403, { message: 'forbidden' }));
    await expect(resolveTarget('tok', HEX)).rejects.toThrow('forbidden');
  });

  it.each([404, 400])('資料庫 %i 時改查頁面', async (status) => {
    on('GET', `/databases/${UUID}`, res(status, {}));
    on('GET', `/pages/${UUID}`, res(200, {
      properties: {
        Tags: { type: 'multi_select' },
        Name: { type: 'title', title: [{ plain_text: '頁' }, { plain_text: '面' }] }
      }
    }));
    expect(await resolveTarget('tok', HEX)).toEqual({ type: 'page', id: UUID, name: '頁面' });
  });

  it.each([
    [{}],
    [{ properties: { Name: { type: 'title' } } }],
    [{ properties: { Name: { type: 'title', title: [] } } }]
  ])('頁面沒有標題 %j', async (page) => {
    on('GET', `/databases/${UUID}`, res(404, {}));
    on('GET', `/pages/${UUID}`, res(200, page));
    expect((await resolveTarget('tok', HEX)).name).toBe('未命名頁面');
  });

  it('頁面也找不到', async () => {
    on('GET', `/databases/${UUID}`, res(404, {}));
    on('GET', `/pages/${UUID}`, res(404, {}));
    await expect(resolveTarget('tok', HEX)).rejects.toThrow(
      '找不到這個頁面/資料庫。請在 Notion 該頁面右上角 ⋯ → 連線（Connections）加入你的 integration。'
    );
  });

  it('頁面其他錯誤', async () => {
    on('GET', `/databases/${UUID}`, res(404, {}));
    on('GET', `/pages/${UUID}`, res(401, { message: 'unauthorized' }));
    await expect(resolveTarget('tok', HEX)).rejects.toThrow('unauthorized');
  });
});

const txt = (content, annotations) => (annotations
  ? { type: 'text', text: { content }, annotations }
  : { type: 'text', text: { content } });
const blk = (type, rich, extra = {}) => ({ object: 'block', type, [type]: { rich_text: rich, ...extra } });

describe('markdownToBlocks', () => {
  it('各種語法', () => {
    const md = [
      '# H1', '## H2', '### H3', '#### H4', '#nospace',
      '- [ ] todo', '* [x] done', '- [X] DONE', '  - [ ]   indented',
      '- item', '* star', '• dot', '  - nested', '-noitem',
      '1. one', '2) two', '  10. ten', '1.x',
      '> quote', '>tight', ' > notquote',
      '---', '-----', '  ---  ', '--',
      '', '   ', 'plain   ', '- [y] weird',
      '##   spaced', '-  [x]  wide', '-   wide', '1.   wide',
      'text - [ ] no', 'v 1. no', 'a---', '---a',
      '# a\u2028b', '- [ ] a\u2028b', '- a\u2028b', '1. a\u2028b', '> a\u2028b'
    ].join('\n');
    expect(markdownToBlocks(md)).toStrictEqual([
      blk('heading_1', [txt('H1')]),
      blk('heading_2', [txt('H2')]),
      blk('heading_3', [txt('H3')]),
      blk('paragraph', [txt('#### H4')]),
      blk('paragraph', [txt('#nospace')]),
      blk('to_do', [txt('todo')], { checked: false }),
      blk('to_do', [txt('done')], { checked: true }),
      blk('to_do', [txt('DONE')], { checked: true }),
      blk('to_do', [txt('indented')], { checked: false }),
      blk('bulleted_list_item', [txt('item')]),
      blk('bulleted_list_item', [txt('star')]),
      blk('bulleted_list_item', [txt('dot')]),
      blk('bulleted_list_item', [txt('nested')]),
      blk('paragraph', [txt('-noitem')]),
      blk('numbered_list_item', [txt('one')]),
      blk('numbered_list_item', [txt('two')]),
      blk('numbered_list_item', [txt('ten')]),
      blk('paragraph', [txt('1.x')]),
      blk('quote', [txt('quote')]),
      blk('quote', [txt('tight')]),
      blk('paragraph', [txt(' > notquote')]),
      { object: 'block', type: 'divider', divider: {} },
      { object: 'block', type: 'divider', divider: {} },
      { object: 'block', type: 'divider', divider: {} },
      blk('paragraph', [txt('--')]),
      blk('paragraph', [txt('plain')]),
      blk('bulleted_list_item', [txt('[y] weird')]),
      blk('heading_2', [txt('spaced')]),
      blk('to_do', [txt('wide')], { checked: true }),
      blk('bulleted_list_item', [txt('wide')]),
      blk('numbered_list_item', [txt('wide')]),
      blk('paragraph', [txt('text - [ ] no')]),
      blk('paragraph', [txt('v 1. no')]),
      blk('paragraph', [txt('a---')]),
      blk('paragraph', [txt('---a')]),
      blk('paragraph', [txt('# a\u2028b')]),
      blk('paragraph', [txt('- [ ] a\u2028b')]),
      blk('paragraph', [txt('- a\u2028b')]),
      blk('paragraph', [txt('1. a\u2028b')]),
      blk('paragraph', [txt('> a\u2028b')])
    ]);
  });

  it('空內容', () => {
    expect(markdownToBlocks('')).toEqual([]);
    expect(markdownToBlocks(undefined)).toEqual([]);
  });

  it('粗體', () => {
    expect(markdownToBlocks('a **b** c **d**')).toStrictEqual([
      blk('paragraph', [txt('a '), txt('b', { bold: true }), txt(' c '), txt('d', { bold: true })])
    ]);
    expect(markdownToBlocks('**x**')).toEqual([blk('paragraph', [txt('x', { bold: true })])]);
    expect(markdownToBlocks('# **')).toEqual([blk('heading_1', [txt('**')])]);
  });

  it('空的標題文字產生一個空 rich_text', () => {
    expect(markdownToBlocks('> ')).toEqual([blk('quote', [])]);
  });

  it('行內片段最多 100 個', () => {
    const md = Array.from({ length: 60 }, (_, i) => `n${i} **b${i}**`).join(' ');
    const rich = markdownToBlocks(md)[0].paragraph.rich_text;
    expect(rich).toHaveLength(100);
    expect(rich[99]).toEqual(txt('b49', { bold: true }));
  });

  it('剛好 2000 字不多出空片段', () => {
    expect(markdownToBlocks('a'.repeat(2000))[0].paragraph.rich_text).toStrictEqual([txt('a'.repeat(2000))]);
  });

  it('長文字每 2000 字切一段', () => {
    const s = 'a'.repeat(2000) + 'b'.repeat(2000) + 'c';
    expect(markdownToBlocks(s)[0].paragraph.rich_text).toEqual([
      txt('a'.repeat(2000)), txt('b'.repeat(2000)), txt('c')
    ]);
  });
});

describe('saveMeetingToNotion', () => {
  const T0 = Date.UTC(2024, 0, 2, 7, 4, 5);
  const baseMeeting = (over = {}) => ({
    id: 'm1',
    startedAt: T0,
    endedAt: T0 + 30 * 60000,
    url: 'https://meet.google.com/abc-defg-hij',
    entries: [
      { t: 0, speaker: 'Amy', text: 'hello' },
      { t: 61000, speaker: 'Bob', text: 'world' }
    ],
    ...over
  });

  function setupDb(properties, title = [{ plain_text: 'DB' }]) {
    on('GET', `/databases/${UUID}`, res(200, { title, properties }));
  }
  function setupPage() {
    on('GET', `/databases/${UUID}`, res(404, {}));
    on('GET', `/pages/${UUID}`, res(200, { properties: { t: { type: 'title', title: [{ plain_text: 'Parent' }] } } }));
  }
  function setupWrites() {
    on('POST', '/pages', res(200, { id: 'PAGE', url: 'https://notion.so/PAGE' }));
    let n = 0;
    routes.push({
      match: (url, init) => init.method === 'PATCH',
      reply: () => res(200, { results: [{ id: 'H' + (n++) }] })
    });
  }

  it('建立在一般頁面下', async () => {
    setupPage();
    setupWrites();
    const onStatus = vi.fn();
    const out = await saveMeetingToNotion({
      token: 'tok', target: HEX, meeting: baseMeeting(), title: '週會', summary: '## 重點\n- a', onStatus
    });
    expect(out).toEqual({ url: 'https://notion.so/PAGE', targetName: 'Parent' });
    const [page] = bodies('POST', '/pages');
    expect(page).toEqual({
      parent: { page_id: UUID },
      icon: { type: 'emoji', emoji: '📝' },
      properties: { title: { title: [txt('週會')] } },
      children: [
        {
          object: 'block',
          type: 'callout',
          callout: {
            rich_text: [txt('📅 2024年1月2日 下午3:04　⏱ 30 分鐘　👥 Amy、Bob　🔗 https://meet.google.com/abc-defg-hij')],
            icon: { type: 'emoji', emoji: '🗓️' },
            color: 'gray_background'
          }
        },
        blk('heading_2', [txt('重點')]),
        blk('bulleted_list_item', [txt('a')]),
        { object: 'block', type: 'divider', divider: {} }
      ]
    });
    const patches = fetchMock.mock.calls.filter(([, i]) => i.method === 'PATCH');
    expect(patches.map(([u]) => u)).toEqual([
      'https://api.notion.com/v1/blocks/PAGE/children',
      'https://api.notion.com/v1/blocks/H0/children'
    ]);
    expect(JSON.parse(patches[0][1].body)).toEqual({
      children: [{
        object: 'block',
        type: 'heading_2',
        heading_2: { rich_text: [txt('逐字稿（2 段）')], is_toggleable: true }
      }]
    });
    expect(JSON.parse(patches[1][1].body)).toEqual({
      children: [
        {
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [txt('[00:00:00] ', { color: 'gray' }), txt('Amy：', { bold: true }), txt('hello')]
          }
        },
        {
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [txt('[00:01:01] ', { color: 'gray' }), txt('Bob：', { bold: true }), txt('world')]
          }
        }
      ]
    });
    expect(onStatus.mock.calls.map((c) => c[0])).toEqual([
      '連線 Notion…', '建立頁面…', '寫入逐字稿…', '寫入逐字稿… 2/2'
    ]);
    expect(delays).toEqual([350]);
  });

  it('沒有摘要、講者與連結時的資訊列', async () => {
    setupPage();
    setupWrites();
    await saveMeetingToNotion({
      token: 'tok', target: HEX, title: 't', summary: '  \n ',
      meeting: baseMeeting({ url: '', endedAt: null, entries: [{ t: 120000, speaker: '未知', text: 'x' }] })
    });
    const [page] = bodies('POST', '/pages');
    expect(page.children[0].callout.rich_text).toEqual([txt('📅 2024年1月2日 下午3:04　⏱ 2 分鐘')]);
    expect(page.children[1]).toEqual(blk('paragraph', [txt('（尚未產生摘要）')]));
    expect(page.children).toHaveLength(3);
  });

  it('summary 為 undefined', async () => {
    setupPage();
    setupWrites();
    await saveMeetingToNotion({ token: 'tok', target: HEX, title: 't', meeting: baseMeeting() });
    expect(bodies('POST', '/pages')[0].children[1]).toEqual(blk('paragraph', [txt('（尚未產生摘要）')]));
  });

  it('逐字稿中的長文字與多個片段被截到 100', async () => {
    setupPage();
    setupWrites();
    const long = 'z'.repeat(2000 * 99);
    await saveMeetingToNotion({
      token: 'tok', target: HEX, title: 't', summary: 'x',
      meeting: baseMeeting({ entries: [{ t: 0, speaker: 'A', text: long }] })
    });
    const rich = bodies('PATCH', '/blocks/H0')[0].children[0].paragraph.rich_text;
    expect(rich).toHaveLength(100);
    expect(rich[99]).toEqual(txt('z'.repeat(2000)));
  });

  it('rt 最多 100 段', async () => {
    setupPage();
    setupWrites();
    await saveMeetingToNotion({ token: 'tok', target: HEX, title: 'q'.repeat(2000 * 100 + 1), summary: 'x', meeting: baseMeeting() });
    const title = bodies('POST', '/pages')[0].properties.title.title;
    expect(title).toHaveLength(100);
    expect(title.every((t) => t.text.content.length === 2000)).toBe(true);
  });

  it('空標題仍給一個空文字', async () => {
    setupPage();
    setupWrites();
    await saveMeetingToNotion({ token: 'tok', target: HEX, title: undefined, summary: 'x', meeting: baseMeeting() });
    expect(bodies('POST', '/pages')[0].properties.title.title).toEqual([txt('')]);
  });

  it('大量摘要與逐字稿分批寫入', async () => {
    setupPage();
    setupWrites();
    const summary = Array.from({ length: 250 }, (_, i) => `- s${i}`).join('\n');
    const entries = Array.from({ length: 201 }, (_, i) => ({ t: i * 1000, speaker: 'A', text: 'e' + i }));
    const onStatus = vi.fn();
    await saveMeetingToNotion({ token: 'tok', target: HEX, title: 't', summary, meeting: baseMeeting({ entries }), onStatus });

    const page = bodies('POST', '/pages')[0];
    expect(page.children).toHaveLength(100);
    // top = 1 callout + 250 + 1 divider = 252 → 剩下 152 個分兩批附加到頁面
    const pagePatches = bodies('PATCH', '/blocks/PAGE/');
    expect(pagePatches.map((b) => b.children.length)).toEqual([100, 52, 1]);
    expect(pagePatches[0].children[0]).toEqual(blk('bulleted_list_item', [txt('s99')]));
    expect(pagePatches[1].children.at(-1)).toEqual({ object: 'block', type: 'divider', divider: {} });
    expect(pagePatches[2].children[0].heading_2.rich_text).toEqual([txt('逐字稿（201 段）')]);

    // 逐字稿頭的 id 來自第三個 PATCH 回應（H2）
    const lines = bodies('PATCH', '/blocks/H2/');
    expect(lines.map((b) => b.children.length)).toEqual([100, 100, 1]);
    expect(lines[2].children[0].paragraph.rich_text[2]).toEqual(txt('e200'));
    expect(onStatus.mock.calls.map((c) => c[0]).slice(3)).toEqual([
      '寫入逐字稿… 100/201', '寫入逐字稿… 200/201', '寫入逐字稿… 201/201'
    ]);
    // 頁面附加 2 批之間 1 次 + 每批逐字稿後 1 次
    expect(delays).toEqual([350, 350, 350, 350]);
  });

  it('剛好 100 個頂層區塊時不再附加', async () => {
    setupPage();
    setupWrites();
    const summary = Array.from({ length: 98 }, (_, i) => `- s${i}`).join('\n');
    await saveMeetingToNotion({ token: 'tok', target: HEX, title: 't', summary, meeting: baseMeeting() });
    expect(bodies('POST', '/pages')[0].children).toHaveLength(100);
    expect(bodies('PATCH', '/blocks/PAGE/')).toHaveLength(1);
  });

  it('沒有逐字稿', async () => {
    setupPage();
    setupWrites();
    await saveMeetingToNotion({ token: 'tok', target: HEX, title: 't', summary: 'x', meeting: baseMeeting({ entries: [] }) });
    expect(bodies('PATCH', '/blocks/H0/')).toHaveLength(0);
    expect(delays).toEqual([]);
  });

  describe('資料庫屬性', () => {
    async function propsFor(properties, meeting = baseMeeting()) {
      setupDb(properties);
      setupWrites();
      const out = await saveMeetingToNotion({ token: 'tok', target: HEX, title: '週會', summary: 'x', meeting });
      expect(out.targetName).toBe('DB');
      const page = bodies('POST', '/pages')[0];
      expect(page.parent).toEqual({ database_id: UUID });
      return page.properties;
    }

    it('依欄位名稱與型別對應', async () => {
      const props = await propsFor({
        名稱: { type: 'title' },
        建立: { type: 'date' },
        會議日期: { type: 'date' },
        參與者: { type: 'multi_select' },
        與會者文字: { type: 'rich_text' },
        出席: { type: 'people' },
        會議連結: { type: 'url' },
        Website: { type: 'url' },
        'Link text': { type: 'rich_text' },
        Note: { type: 'rich_text' }
      }, baseMeeting({ entries: [{ t: 0, speaker: 'A,B', text: 'x' }, { t: 1, speaker: 'C'.repeat(150), text: 'y' }] }));
      expect(props).toEqual({
        名稱: { title: [txt('週會')] },
        會議日期: { date: { start: '2024-01-02T07:04:05.000Z', end: '2024-01-02T07:34:05.000Z' } },
        參與者: { multi_select: [{ name: 'A B' }, { name: 'C'.repeat(100) }] },
        與會者文字: { rich_text: [txt(`A,B、${'C'.repeat(150)}`)] }
      ,
        會議連結: { url: 'https://meet.google.com/abc-defg-hij' }
      });
    });

    it.each([
      ['Date'], ['時間'], ['開會日期'], ['meeting date']
    ])('日期欄位名稱 %s 優先', async (name) => {
      const props = await propsFor({ Other: { type: 'date' }, [name]: { type: 'date' }, T: { type: 'title' } });
      expect(Object.keys(props).sort()).toEqual([name, 'T'].sort());
    });

    it('沒有符合名稱的日期欄位時用第一個日期欄位，且沒結束時間', async () => {
      const props = await propsFor({ A: { type: 'date' }, B: { type: 'date' } }, baseMeeting({ endedAt: null }));
      expect(props).toEqual({ A: { date: { start: '2024-01-02T07:04:05.000Z', end: null } } });
    });

    it('名稱像日期但不是日期型別的欄位不算', async () => {
      const props = await propsFor({ 日期: { type: 'rich_text' }, X: { type: 'date' } });
      expect(Object.keys(props)).toEqual(['X']);
    });

    it.each([
      ['Participants'], ['attendees'], ['參與'], ['與會'], ['出席者']
    ])('參與者欄位 %s', async (name) => {
      const props = await propsFor({ [name]: { type: 'multi_select' } });
      expect(props).toEqual({ [name]: { multi_select: [{ name: 'Amy' }, { name: 'Bob' }] } });
    });

    it('參與者最多 100 位', async () => {
      const entries = Array.from({ length: 105 }, (_, i) => ({ t: i, speaker: 'S' + i, text: 'x' }));
      const props = await propsFor({ 參與者: { type: 'multi_select' } }, baseMeeting({ entries }));
      expect(props.參與者.multi_select).toHaveLength(100);
      expect(props.參與者.multi_select[99]).toEqual({ name: 'S99' });
    });

    it.each([['Meet'], ['連結'], ['Link'], ['URL']])('網址欄位 %s', async (name) => {
      const props = await propsFor({ [name]: { type: 'url' } }, baseMeeting({ url: '' }));
      expect(props).toEqual({ [name]: { url: null } });
    });

    it('沒有 properties', async () => {
      expect(await propsFor(undefined)).toEqual({});
    });
  });
});
