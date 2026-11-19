import { getSettings, fmtClock, fmtDate, fmtDuration, speakersOf, durationOf, transcriptText } from './lib/shared.js';
import { summarizeTranscript, claudePrompt, aiStatus } from './lib/ai.js';
import { saveMeetingToNotion } from './lib/notion.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let meetings;               // 依時間新到舊（load 後才有值）
let store = {};             // chrome.storage.local 快照；meta:<id> → { title, summary, notionUrl }
let currentId = decodeURIComponent(location.hash.slice(1)) || null;
let busy = false;

async function load() {
  store = await chrome.storage.local.get(null);
  meetings = Object.keys(store).filter((k) => k.startsWith('meeting:')).map((k) => store[k]).sort((a, b) => b.startedAt - a.startedAt);
  if (!meetings.some((m) => m.id === currentId)) currentId = meetings[0]?.id || null;
}

const metaOf = (id) => store['meta:' + id] || {};
const titleOf = (m) => metaOf(m.id).title || m.title || m.meetCode;

async function setMeta(id, patch) {
  const key = 'meta:' + id;
  store[key] = { ...metaOf(id), ...patch };
  await chrome.storage.local.set({ [key]: store[key] });
}

function renderList() {
  $('#list').innerHTML = meetings.map((m) => `
    <li data-id="${esc(m.id)}" class="${m.id === currentId ? 'active' : ''}">
      <div class="t">${metaOf(m.id).notionUrl ? '✅ ' : ''}${esc(titleOf(m))}</div>
      <div class="small muted">${esc(fmtDate(m.startedAt))} · ${m.entries.length} 段${m.endedAt ? '' : ' · <span class="live">● 進行中</span>'}</div>
    </li>`).join('');
}

function transcriptHtml(m) {
  return m.entries.map((e) => `
    <div class="line"><span class="time">${fmtClock(e.t)}</span><span><b>${esc(e.speaker)}</b>${esc(e.text)}</span></div>`).join('');
}

function renderDetail() {
  const m = meetings.find((x) => x.id === currentId);
  if (!m) {
    $('#detail').innerHTML = '<div class="empty">還沒有會議記錄。加入 Google Meet 後會自動開始擷取字幕。</div>';
    return;
  }
  const meta = metaOf(m.id);
  const speakers = speakersOf(m);
  $('#detail').innerHTML = `
    <input id="title" type="text" value="${esc(titleOf(m))}" aria-label="會議標題">
    <div class="muted">${esc(fmtDate(m.startedAt))} · ${esc(fmtDuration(durationOf(m)))} · ${m.entries.length} 段
      ${m.endedAt ? '' : ' · <span class="live">● 會議進行中</span>'}
      ${m.url ? ` · <a href="${esc(m.url)}" target="_blank">${esc(m.meetCode)}</a>` : ''}</div>
    ${speakers.length ? `<div class="muted">👥 ${esc(speakers.join('、'))}</div>` : ''}

    <section>
      <h2>摘要</h2>
      <div class="row" style="margin-bottom:8px">
        <button id="ai">✨ 用 Chrome 內建 AI 產生</button>
        <button id="claude">📋 複製給 Claude 整理</button>
        <span class="small muted">（貼到 claude.ai，再把結果貼回下方）</span>
      </div>
      <textarea id="summary" placeholder="## 重點摘要&#10;- …&#10;## 決議事項&#10;- …&#10;## 待辦事項&#10;- [ ] 負責人：事項">${esc(meta.summary || '')}</textarea>
      <div id="aiStatus" class="status"></div>
    </section>

    <section>
      <div class="row">
        <button id="notion" class="primary">${meta.notionUrl ? '再存一份到 Notion' : '儲存到 Notion'}</button>
        <button id="md">下載 Markdown</button>
        <button id="del" class="danger">刪除</button>
        ${meta.notionUrl ? `<a href="${esc(meta.notionUrl)}" target="_blank">開啟 Notion 頁面 ↗</a>` : ''}
      </div>
      <div id="saveStatus" class="status"></div>
    </section>

    <section>
      <h2>逐字稿</h2>
      <div class="card transcript" id="transcript">${transcriptHtml(m) || '<span class="muted">尚無內容</span>'}</div>
    </section>`;

  $('#title').addEventListener('change', async (e) => { await setMeta(m.id, { title: e.target.value.trim() }); renderList(); });
  $('#summary').addEventListener('input', debounce((e) => setMeta(m.id, { summary: e.target.value }), 400));
  $('#ai').addEventListener('click', () => runAi(m));
  $('#claude').addEventListener('click', () => copyForClaude(m));
  $('#notion').addEventListener('click', () => saveNotion(m));
  $('#md').addEventListener('click', () => downloadMd(m));
  $('#del').addEventListener('click', () => removeMeeting(m));
  aiStatus().then(({ api }) => { if (!api) { $('#ai').disabled = true; $('#ai').title = '此 Chrome 無內建 AI'; } });
}

function status(sel, text, kind = '') {
  const el = $(sel);
  if (!el) return;
  el.textContent = text;
  el.className = 'status ' + kind;
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

async function runAi(m) {
  if (busy) return;
  busy = true;
  $('#ai').disabled = true;
  try {
    const { aiLang } = await getSettings();
    const md = await summarizeTranscript(transcriptText(m), aiLang, (s) => status('#aiStatus', s));
    $('#summary').value = md;
    await setMeta(m.id, { summary: md });
    status('#aiStatus', '完成，可直接修改後再存到 Notion。', 'ok');
  } catch (e) {
    status('#aiStatus', 'AI 失敗：' + e.message, 'err');
  } finally {
    busy = false;
    if ($('#ai')) $('#ai').disabled = false;
  }
}

async function copyForClaude(m) {
  const text = claudePrompt(titleOf(m), fmtDate(m.startedAt), transcriptText(m));
  await navigator.clipboard.writeText(text);
  status('#aiStatus', `已複製（${text.length} 字），貼到 claude.ai 後把結果貼回上方即可。`, 'ok');
}

async function saveNotion(m) {
  if (busy) return;
  const s = await getSettings();
  if (!s.notionToken || !s.notionTarget) {
    status('#saveStatus', '尚未設定 Notion（選用）。可以先用「下載 Markdown」，或到「設定」填入 Notion Token 與目標頁面/資料庫。', 'err');
    return;
  }
  busy = true;
  $('#notion').disabled = true;
  try {
    const { url, targetName } = await saveMeetingToNotion({
      token: s.notionToken,
      target: s.notionTarget,
      meeting: m,
      title: titleOf(m),
      summary: $('#summary').value,
      onStatus: (t) => status('#saveStatus', t)
    });
    await setMeta(m.id, { notionUrl: url, savedAt: Date.now() });
    renderList();
    renderDetail();
    status('#saveStatus', `已存到「${targetName}」。`, 'ok');
  } catch (e) {
    status('#saveStatus', 'Notion 寫入失敗：' + e.message, 'err');
  } finally {
    busy = false;
    if ($('#notion')) $('#notion').disabled = false;
  }
}

function downloadMd(m) {
  const md = [
    `# ${titleOf(m)}`,
    '',
    `- 時間：${fmtDate(m.startedAt)}（${fmtDuration(durationOf(m))}）`,
    `- 參與者：${speakersOf(m).join('、') || '—'}`,
    m.url ? `- 會議連結：${m.url}` : '',
    '',
    $('#summary').value.trim(),
    '',
    '## 逐字稿',
    '',
    ...m.entries.map((e) => `- \`${fmtClock(e.t)}\` **${e.speaker}**：${e.text}`)
  ].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
  a.download = `${titleOf(m).replace(/[\\/:*?"<>|]/g, '_')}_${new Date(m.startedAt).toISOString().slice(0, 10)}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function removeMeeting(m) {
  if (!confirm(`確定刪除「${titleOf(m)}」的本機記錄？（不會刪除 Notion 上的頁面）`)) return;
  await chrome.storage.local.remove(['meeting:' + m.id, 'meta:' + m.id]);
  currentId = null;
  await refresh();
}

async function refresh() {
  await load();
  renderList();
  renderDetail();
}

$('#list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  currentId = li.dataset.id;
  // Stryker disable next-line StringLiteral: replaceState 的 title 參數會被瀏覽器忽略
  history.replaceState(null, '', '#' + encodeURIComponent(currentId));
  renderList();
  renderDetail();
});

// 會議進行中時即時更新逐字稿，但不覆蓋使用者正在編輯的摘要
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !Object.keys(changes).some((k) => k.startsWith('meeting:'))) return;
  const prevId = currentId;
  await load();
  renderList();
  const m = meetings.find((x) => x.id === currentId);
  if (currentId !== prevId || !$('#transcript')) return renderDetail();
  if (changes['meeting:' + currentId] && m) {
    const box = $('#transcript');
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
    box.innerHTML = transcriptHtml(m);
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
});

window.addEventListener('hashchange', () => {
  currentId = decodeURIComponent(location.hash.slice(1)) || currentId;
  refresh();
});

refresh();
