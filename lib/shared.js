// 擴充頁面（整理頁、彈出視窗、設定頁）共用的工具。

export const DEFAULT_SETTINGS = {
  notionToken: '',
  notionTarget: '',
  autoCaptions: true,
  autoOpenReview: true,
  aiLang: 'zh'
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

export function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  return min < 60 ? `${min} 分鐘` : `${Math.floor(min / 60)} 小時 ${min % 60} 分鐘`;
}

export function fmtDate(ms) {
  return new Date(ms).toLocaleString('zh-TW', { dateStyle: 'medium', timeStyle: 'short' });
}

export function speakersOf(meeting) {
  return [...new Set(meeting.entries.map((e) => e.speaker).filter((s) => s && s !== '未知'))];
}

export function durationOf(meeting) {
  const last = meeting.entries[meeting.entries.length - 1];
  return (meeting.endedAt || meeting.startedAt + (last?.t || 0)) - meeting.startedAt;
}

export function transcriptText(meeting) {
  return meeting.entries.map((e) => `[${fmtClock(e.t)}] ${e.speaker}：${e.text}`).join('\n');
}
