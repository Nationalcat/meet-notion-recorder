// Notion API（免費的 Internal Integration）寫入會議記錄。
import { fmtClock, fmtDate, fmtDuration, speakersOf, durationOf } from './shared.js';

const API = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';
const MAX_TEXT = 2000;   // 每個 rich_text 物件的字數上限
const MAX_BLOCKS = 100;  // 每次請求的區塊數上限

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(token, path, method = 'GET', body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': VERSION,
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 429 && attempt < 4) {
      await sleep((Number(res.headers.get('Retry-After')) || 1) * 1000);
      continue;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json.message || `${res.status} ${res.statusText}`);
      err.status = res.status;
      err.code = json.code;
      throw err;
    }
    return json;
  }
}

// 接受 Notion 網址或 ID，回傳帶連字號的 UUID
export function normalizeId(input) {
  const seg = (input || '').trim().split(/[?#]/)[0].split('/').pop().replace(/-/g, '');
  const m = seg.match(/[0-9a-f]{32}$/i);
  if (!m) return null;
  const h = m[0].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const plain = (arr) => (arr || []).map((t) => t.plain_text).join('');

export async function resolveTarget(token, rawTarget) {
  if (!token) throw new Error('尚未設定 Notion Integration Token');
  const id = normalizeId(rawTarget);
  if (!id) throw new Error('Notion 目標網址或 ID 格式不正確');
  try {
    const db = await call(token, `/databases/${id}`);
    return { type: 'database', id, db, name: plain(db.title) || '未命名資料庫' };
  } catch (e) {
    if (e.status === 401) throw new Error('Token 無效，請重新複製 Integration Secret');
    if (e.status !== 404 && e.status !== 400) throw e;
  }
  try {
    const page = await call(token, `/pages/${id}`);
    const titleProp = Object.values(page.properties || {}).find((p) => p.type === 'title');
    return { type: 'page', id, name: plain(titleProp?.title) || '未命名頁面' };
  } catch (e) {
    if (e.status === 404) {
      throw new Error('找不到這個頁面/資料庫。請在 Notion 該頁面右上角 ⋯ → 連線（Connections）加入你的 integration。');
    }
    throw e;
  }
}

// ---------- 區塊建構 ----------

function rt(text, annotations) {
  const out = [];
  const s = String(text ?? '');
  for (let i = 0; i < s.length && out.length < 100; i += MAX_TEXT) {
    const piece = { type: 'text', text: { content: s.slice(i, i + MAX_TEXT) } };
    if (annotations) piece.annotations = annotations;
    out.push(piece);
  }
  return out.length ? out : [{ type: 'text', text: { content: '' } }];
}

// 支援 **粗體** 的行內文字
function inline(text) {
  const parts = String(text).split(/\*\*(.+?)\*\*/g);
  return parts.flatMap((p, i) => (p ? rt(p, i % 2 ? { bold: true } : undefined) : [])).slice(0, 100);
}

const block = (type, text, extra = {}) => ({ object: 'block', type, [type]: { rich_text: inline(text), ...extra } });

export function markdownToBlocks(md) {
  const blocks = [];
  for (const raw of (md || '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) blocks.push(block(`heading_${m[1].length}`, m[2]));
    else if ((m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/))) blocks.push(block('to_do', m[2], { checked: m[1] !== ' ' }));
    else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) blocks.push(block('bulleted_list_item', m[1]));
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) blocks.push(block('numbered_list_item', m[1]));
    else if ((m = line.match(/^>\s?(.*)$/))) blocks.push(block('quote', m[1]));
    else if (/^-{3,}$/.test(line.trim())) blocks.push({ object: 'block', type: 'divider', divider: {} });
    else blocks.push(block('paragraph', line));
  }
  return blocks;
}

function transcriptBlock(e) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [
        ...rt(`[${fmtClock(e.t)}] `, { color: 'gray' }),
        ...rt(`${e.speaker}：`, { bold: true }),
        ...rt(e.text)
      ].slice(0, 100)
    }
  };
}

function buildDatabaseProps(db, meeting, title) {
  const props = {};
  const speakers = speakersOf(meeting);
  const entries = Object.entries(db.properties || {});
  const dateName =
    entries.find(([n, p]) => p.type === 'date' && /日期|date|時間/i.test(n))?.[0] ||
    entries.find(([, p]) => p.type === 'date')?.[0];

  for (const [name, p] of entries) {
    if (p.type === 'title') {
      props[name] = { title: rt(title) };
    } else if (name === dateName) {
      props[name] = {
        date: {
          start: new Date(meeting.startedAt).toISOString(),
          end: meeting.endedAt ? new Date(meeting.endedAt).toISOString() : null
        }
      };
    } else if (/參與|與會|出席|participant|attendee/i.test(name)) {
      if (p.type === 'multi_select') {
        props[name] = { multi_select: speakers.slice(0, 100).map((s) => ({ name: s.replace(/,/g, ' ').slice(0, 100) })) };
      } else if (p.type === 'rich_text') {
        props[name] = { rich_text: rt(speakers.join('、')) };
      }
    } else if (p.type === 'url' && /meet|連結|link|url/i.test(name)) {
      props[name] = { url: meeting.url || null };
    }
  }
  return props;
}

async function appendChildren(token, parentId, children) {
  let last;
  for (let i = 0; i < children.length; i += MAX_BLOCKS) {
    last = await call(token, `/blocks/${parentId}/children`, 'PATCH', { children: children.slice(i, i + MAX_BLOCKS) });
    if (i + MAX_BLOCKS < children.length) await sleep(350); // Notion 限速約 3 req/s
  }
  return last;
}

// 建立會議頁面：資訊列 → 摘要 → 可收合的逐字稿
export async function saveMeetingToNotion({ token, target, meeting, title, summary, onStatus = () => {} }) {
  onStatus('連線 Notion…');
  const t = await resolveTarget(token, target);
  const speakers = speakersOf(meeting);

  const info = [
    `📅 ${fmtDate(meeting.startedAt)}`,
    `⏱ ${fmtDuration(durationOf(meeting))}`,
    speakers.length ? `👥 ${speakers.join('、')}` : null,
    meeting.url ? `🔗 ${meeting.url}` : null
  ].filter(Boolean).join('　');

  const top = [
    { object: 'block', type: 'callout', callout: { rich_text: rt(info), icon: { type: 'emoji', emoji: '🗓️' }, color: 'gray_background' } },
    ...(summary?.trim() ? markdownToBlocks(summary) : [block('paragraph', '（尚未產生摘要）')]),
    { object: 'block', type: 'divider', divider: {} }
  ];

  const body = {
    parent: t.type === 'database' ? { database_id: t.id } : { page_id: t.id },
    icon: { type: 'emoji', emoji: '📝' },
    properties: t.type === 'database' ? buildDatabaseProps(t.db, meeting, title) : { title: { title: rt(title) } },
    children: top.slice(0, MAX_BLOCKS)
  };

  onStatus('建立頁面…');
  const page = await call(token, '/pages', 'POST', body);
  if (top.length > MAX_BLOCKS) await appendChildren(token, page.id, top.slice(MAX_BLOCKS));

  onStatus('寫入逐字稿…');
  const heading = await appendChildren(token, page.id, [{
    object: 'block',
    type: 'heading_2',
    heading_2: { rich_text: rt(`逐字稿（${meeting.entries.length} 段）`), is_toggleable: true }
  }]);
  const headingId = heading.results[0].id;
  const lines = meeting.entries.map(transcriptBlock);
  for (let i = 0; i < lines.length; i += MAX_BLOCKS) {
    onStatus(`寫入逐字稿… ${Math.min(i + MAX_BLOCKS, lines.length)}/${lines.length}`);
    await appendChildren(token, headingId, lines.slice(i, i + MAX_BLOCKS));
    await sleep(350);
  }
  return { url: page.url, targetName: t.name };
}
