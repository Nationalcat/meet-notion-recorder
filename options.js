import { getSettings, saveSettings } from './lib/shared.js';
import { resolveTarget } from './lib/notion.js';

const $ = (s) => document.querySelector(s);

function status(sel, text, kind = '') {
  $(sel).textContent = text;
  $(sel).className = 'status ' + kind;
}

function readForm() {
  return {
    notionToken: $('#token').value.trim(),
    notionTarget: $('#target').value.trim(),
    autoCaptions: $('#autoCaptions').checked,
    autoOpenReview: $('#autoOpenReview').checked,
    aiLang: $('#aiLang').value
  };
}

const s = await getSettings();
$('#token').value = s.notionToken;
$('#target').value = s.notionTarget;
$('#autoCaptions').checked = s.autoCaptions;
$('#autoOpenReview').checked = s.autoOpenReview;
$('#aiLang').value = s.aiLang;

$('#save').addEventListener('click', async () => {
  await saveSettings(readForm());
  status('#saveStatus', '已儲存', 'ok');
  setTimeout(() => status('#saveStatus', ''), 2000);
});

$('#test').addEventListener('click', async () => {
  const f = readForm();
  status('#testStatus', '測試中…');
  try {
    const t = await resolveTarget(f.notionToken, f.notionTarget);
    await saveSettings(f);
    status('#testStatus', `✅ 已連線${t.type === 'database' ? '資料庫' : '頁面'}「${t.name}」，設定已儲存`, 'ok');
  } catch (e) {
    status('#testStatus', '❌ ' + e.message, 'err');
  }
});
