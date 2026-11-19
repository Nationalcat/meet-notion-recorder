import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeChrome, flush } from '../helpers/chrome.js';

let env;
const msg = (m, sender = { tab: { id: 7 } }) => env.listeners.message[0](m, sender);

beforeEach(async () => {
  env = makeChrome();
  vi.resetModules();
  await import('../../background.js');
});

describe('onInstalled', () => {
  it('首次安裝開啟設定頁', () => {
    env.listeners.installed[0]({ reason: 'install' });
    expect(env.chrome.runtime.openOptionsPage).toHaveBeenCalledTimes(1);
  });

  it('更新時不開啟', () => {
    env.listeners.installed[0]({ reason: 'update' });
    expect(env.chrome.runtime.openOptionsPage).not.toHaveBeenCalled();
  });
});

describe('MEETING_STARTED', () => {
  it('在分頁顯示 REC 徽章', () => {
    msg({ type: 'MEETING_STARTED' });
    expect(env.chrome.action.setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: 'REC' });
    expect(env.chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ tabId: 7, color: '#d93025' });
  });

  it('tabId 為 0 也有效', () => {
    msg({ type: 'MEETING_STARTED' }, { tab: { id: 0 } });
    expect(env.chrome.action.setBadgeText).toHaveBeenCalledWith({ tabId: 0, text: 'REC' });
  });

  it('不是來自分頁時不設定徽章', () => {
    msg({ type: 'MEETING_STARTED' }, {});
    expect(env.chrome.action.setBadgeText).not.toHaveBeenCalled();
    expect(env.chrome.action.setBadgeBackgroundColor).not.toHaveBeenCalled();
  });

  it('徽章 API 失敗會被吞掉', async () => {
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    env.chrome.action.setBadgeText.mockRejectedValue(new Error('closed'));
    env.chrome.action.setBadgeBackgroundColor.mockRejectedValue(new Error('closed'));
    msg({ type: 'MEETING_STARTED' });
    await flush();
    process.off('unhandledRejection', onUnhandled);
    expect(onUnhandled).not.toHaveBeenCalled();
  });

  it('未知訊息不做事', async () => {
    msg({ type: 'OTHER' });
    await flush();
    expect(env.chrome.action.setBadgeText).not.toHaveBeenCalled();
    expect(env.chrome.storage.local.set).not.toHaveBeenCalled();
  });
});

describe('MEETING_ENDED', () => {
  const meeting = { id: 'abc def', entries: [{ t: 0, speaker: 'A', text: 'x' }] };

  it('清除徽章、保存並開啟整理頁', async () => {
    msg({ type: 'MEETING_ENDED', meeting });
    await flush();
    expect(env.chrome.action.setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: '' });
    expect(env.data['meeting:abc def']).toEqual(meeting);
    expect(env.chrome.storage.local.get).toHaveBeenCalledWith('settings');
    expect(env.chrome.runtime.getURL).toHaveBeenCalledWith('review.html#abc%20def');
    expect(env.chrome.tabs.create).toHaveBeenCalledWith({ url: 'chrome-extension://ext/review.html#abc%20def' });
  });

  it('autoOpenReview 為 false 時不開啟', async () => {
    env.data.settings = { autoOpenReview: false };
    msg({ type: 'MEETING_ENDED', meeting });
    await flush();
    expect(env.data['meeting:abc def']).toEqual(meeting);
    expect(env.chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('autoOpenReview 未設定時開啟', async () => {
    env.data.settings = { aiLang: 'en' };
    msg({ type: 'MEETING_ENDED', meeting });
    await flush();
    expect(env.chrome.tabs.create).toHaveBeenCalledTimes(1);
  });

  it('沒有分頁時不清徽章但仍保存', async () => {
    msg({ type: 'MEETING_ENDED', meeting }, {});
    await flush();
    expect(env.chrome.action.setBadgeText).not.toHaveBeenCalled();
    expect(env.data['meeting:abc def']).toEqual(meeting);
  });

  it('清除徽章失敗會被吞掉', async () => {
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    env.chrome.action.setBadgeText.mockRejectedValue(new Error('closed'));
    msg({ type: 'MEETING_ENDED', meeting: { id: 'x', entries: [] } });
    await flush();
    process.off('unhandledRejection', onUnhandled);
    expect(onUnhandled).not.toHaveBeenCalled();
  });

  it.each([
    ['沒有 meeting', undefined],
    ['沒有 entries', { id: 'x' }],
    ['entries 為空', { id: 'x', entries: [] }]
  ])('%s 時不保存', async (_n, m) => {
    msg({ type: 'MEETING_ENDED', meeting: m });
    await flush();
    expect(env.chrome.action.setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: '' });
    expect(env.chrome.storage.local.set).not.toHaveBeenCalled();
    expect(env.chrome.tabs.create).not.toHaveBeenCalled();
  });
});
