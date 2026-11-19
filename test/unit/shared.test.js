import { describe, it, expect, beforeEach } from 'vitest';
import { makeChrome } from '../helpers/chrome.js';
import {
  DEFAULT_SETTINGS, getSettings, saveSettings, fmtClock, fmtDuration, fmtDate,
  speakersOf, durationOf, transcriptText
} from '../../lib/shared.js';

const T0 = Date.UTC(2024, 0, 2, 7, 4, 5);

describe('settings', () => {
  let env;
  beforeEach(() => { env = makeChrome(); });

  it('DEFAULT_SETTINGS 內容', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      notionToken: '', notionTarget: '', autoCaptions: true, autoOpenReview: true, aiLang: 'zh'
    });
  });

  it('沒有儲存的設定時回傳預設值（且是副本）', async () => {
    const s = await getSettings();
    expect(s).toEqual(DEFAULT_SETTINGS);
    expect(s).not.toBe(DEFAULT_SETTINGS);
    expect(env.chrome.storage.local.get).toHaveBeenCalledWith('settings');
  });

  it('合併已儲存的設定', async () => {
    env.data.settings = { aiLang: 'en', notionToken: 'tok' };
    expect(await getSettings()).toEqual({ ...DEFAULT_SETTINGS, aiLang: 'en', notionToken: 'tok' });
  });

  it('saveSettings 合併並寫回', async () => {
    env.data.settings = { aiLang: 'ja' };
    const next = await saveSettings({ notionTarget: 'x' });
    const expected = { ...DEFAULT_SETTINGS, aiLang: 'ja', notionTarget: 'x' };
    expect(next).toEqual(expected);
    expect(env.data.settings).toEqual(expected);
  });
});

describe('格式化', () => {
  it.each([
    [0, '00:00:00'],
    [-5000, '00:00:00'],
    [59999, '00:00:59'],
    [3723999, '01:02:03'],
    [36000000 + 59 * 60000, '10:59:00']
  ])('fmtClock(%i) = %s', (ms, out) => expect(fmtClock(ms)).toBe(out));

  it.each([
    [0, '0 分鐘'],
    [29999, '0 分鐘'],
    [30000, '1 分鐘'],
    [59 * 60000, '59 分鐘'],
    [60 * 60000, '1 小時 0 分鐘'],
    [125 * 60000, '2 小時 5 分鐘']
  ])('fmtDuration(%i) = %s', (ms, out) => expect(fmtDuration(ms)).toBe(out));

  it('fmtDate 使用 zh-TW 中等日期與短時間', () => {
    expect(fmtDate(T0)).toBe('2024年1月2日 下午3:04');
  });
});

describe('會議工具', () => {
  const meeting = {
    startedAt: 1000,
    entries: [
      { t: 0, speaker: 'A', text: 'hi' },
      { t: 5000, speaker: '未知', text: 'x' },
      { t: 61000, speaker: '', text: 'y' },
      { t: 3661000, speaker: 'B', text: 'bye' },
      { t: 3662000, speaker: 'A', text: 'again' }
    ]
  };

  it('speakersOf 去重並排除空白與「未知」', () => {
    expect(speakersOf(meeting)).toEqual(['A', 'B']);
  });

  it('durationOf 優先使用 endedAt', () => {
    expect(durationOf({ ...meeting, endedAt: 9000 })).toBe(8000);
  });

  it('durationOf 沒有 endedAt 時用最後一段時間', () => {
    expect(durationOf(meeting)).toBe(3662000);
  });

  it('durationOf 沒有任何條目時為 0', () => {
    expect(durationOf({ startedAt: 1000, entries: [] })).toBe(0);
  });

  it('transcriptText 格式', () => {
    expect(transcriptText({ entries: meeting.entries.slice(0, 2) })).toBe('[00:00:00] A：hi\n[00:00:05] 未知：x');
  });
});
