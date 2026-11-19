import { getSettings } from './lib/shared.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let tabId = null;
let st = null;

async function poll() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith('https://meet.google.com/')) {
    $('#state').innerHTML = '目前分頁不是 Google Meet。加入會議後會自動擷取字幕。';
    $('#toggle').hidden = true;
    $('#last').hidden = true;
    return;
  }
  tabId = tab.id;
  try {
    st = await chrome.tabs.sendMessage(tabId, { type: 'GET_STATUS' });
  } catch {
    $('#state').textContent = '請重新整理這個 Meet 分頁，讓擴充元件載入。';
    return;
  }
  if (!st.inCall) {
    $('#state').textContent = '尚未加入會議。';
    $('#toggle').hidden = true;
    $('#last').hidden = true;
    return;
  }
  const on = st.recording;
  $('#state').innerHTML = `<span class="dot ${on ? 'on' : ''}"></span>${on ? '記錄中' : '已暫停'} · ${st.count} 段` +
    (st.captionsFound ? '' : '<br><span class="small">⚠️ 找不到字幕區，請按 Meet 下方的「CC」開啟字幕。</span>');
  $('#toggle').hidden = false;
  $('#toggle').textContent = on ? '⏸ 暫停記錄' : '▶︎ 繼續記錄';
  if (st.last?.text) {
    $('#last').hidden = false;
    $('#last').innerHTML = `<b>${esc(st.last.speaker)}</b>：${esc(st.last.text.slice(-160))}`;
  }
}

$('#toggle').addEventListener('click', async () => {
  if (tabId == null || !st) return;
  await chrome.tabs.sendMessage(tabId, { type: 'SET_RECORDING', value: !st.recording });
  poll();
});
$('#open').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('review.html') }));
$('#settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

getSettings().then((s) => {
  if (!s.notionToken || !s.notionTarget) {
    $('#settings').textContent = '設定 Notion ⚠️';
  }
});
poll();
setInterval(poll, 1500);
