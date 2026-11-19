// 背景：顯示錄製徽章、會議結束時保存最終逐字稿並開啟整理頁面。

chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab?.id;
  if (msg.type === 'MEETING_STARTED' && tabId != null) {
    chrome.action.setBadgeText({ tabId, text: 'REC' }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#d93025' }).catch(() => {});
  } else if (msg.type === 'MEETING_ENDED') {
    onMeetingEnded(msg.meeting, tabId);
  }
});

async function onMeetingEnded(meeting, tabId) {
  if (tabId != null) chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  if (!meeting?.entries?.length) return;
  await chrome.storage.local.set({ ['meeting:' + meeting.id]: meeting });
  const { settings = {} } = await chrome.storage.local.get('settings');
  if (settings.autoOpenReview !== false) {
    chrome.tabs.create({ url: chrome.runtime.getURL('review.html#' + encodeURIComponent(meeting.id)) });
  }
}
