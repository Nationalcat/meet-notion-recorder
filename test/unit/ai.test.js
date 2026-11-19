// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { aiStatus, summarizeTranscript, claudePrompt } from '../../lib/ai.js';

const PARTIAL_ZH = '請條列這段會議逐字稿中的重點、決議與待辦事項（標註負責人）：';
const FINAL_ZH = '請把以下會議內容整理成 Markdown 會議記錄，嚴格使用這個格式，某一節沒有內容就寫「- 無」：\n## 重點摘要\n- …\n## 決議事項\n- …\n## 待辦事項\n- [ ] 負責人：事項（期限）\n\n會議內容：';
const FINAL_EN = 'Turn the following into Markdown meeting minutes using exactly this format (write "- None" for empty sections):\n## Summary\n- …\n## Decisions\n- …\n## Action items\n- [ ] Owner: task (due)\n\nMeeting content:';
const FINAL_JA = '以下を次の形式の Markdown 議事録にまとめてください（該当なしは「- なし」）：\n## 要約\n- …\n## 決定事項\n- …\n## ToDo\n- [ ] 担当者：タスク（期限）\n\n会議内容：';
const PARTIAL_EN = 'List the key points, decisions and action items (with owners) from this part of the meeting transcript:';
const PARTIAL_JA = 'この部分の文字起こしから要点・決定事項・ToDo（担当者付き）を箇条書きにしてください：';
const SYSTEM = {
  zh: '你是專業的會議記錄助理。一律使用繁體中文回答。只根據提供的逐字稿內容，不要捏造任何資訊。',
  en: 'You are a professional meeting note taker. Always answer in English. Use only the transcript provided; never invent facts.',
  ja: 'あなたはプロの議事録作成者です。必ず日本語で回答し、提供された文字起こしの内容のみを使ってください。'
};

let scope;
beforeEach(() => {
  scope = {};
  vi.stubGlobal('self', scope);
});

function fakeLM({ availability = 'available', base: baseProps = {}, reply = () => ' R ', sessionProps = {} } = {}) {
  const prompts = [];
  const sessions = [];
  const base = {
    destroy: vi.fn(),
    clone: vi.fn(async () => {
      const s = { prompt: vi.fn(async (p) => { prompts.push(p); return reply(p); }), destroy: vi.fn(), ...sessionProps };
      sessions.push(s);
      return s;
    }),
    ...baseProps
  };
  const LM = {
    availability: typeof availability === 'function' ? vi.fn(availability) : vi.fn(async () => availability),
    create: vi.fn(async () => base)
  };
  scope.LanguageModel = LM;
  vi.stubGlobal('LanguageModel', LM);
  return { LM, base, prompts, sessions };
}

function fakeSummarizer({ availability = 'available', props = {}, reply = () => ' S ' } = {}) {
  const inputs = [];
  const s = { summarize: vi.fn(async (t) => { inputs.push(t); return reply(t); }), destroy: vi.fn(), ...props };
  const SM = {
    availability: typeof availability === 'function' ? vi.fn(availability) : vi.fn(async () => availability),
    create: vi.fn(async () => s)
  };
  scope.Summarizer = SM;
  vi.stubGlobal('Summarizer', SM);
  return { SM, s, inputs };
}

describe('aiStatus', () => {
  it('沒有任何 API', async () => {
    expect(await aiStatus()).toEqual({ api: null, availability: 'unavailable' });
  });

  it('只看 self 上有暴露的 API', async () => {
    vi.stubGlobal('LanguageModel', { availability: async () => 'available' });
    vi.stubGlobal('Summarizer', { availability: async () => 'available' });
    expect(await aiStatus()).toEqual({ api: null, availability: 'unavailable' });
  });

  it.each(['available', 'downloadable'])('Prompt API %s', async (a) => {
    fakeLM({ availability: a });
    fakeSummarizer();
    expect(await aiStatus()).toEqual({ api: 'prompt', availability: a });
  });

  it('Prompt API 不可用時退回 Summarizer', async () => {
    fakeLM({ availability: 'unavailable' });
    fakeSummarizer({ availability: 'downloading' });
    expect(await aiStatus()).toEqual({ api: 'summarizer', availability: 'downloading' });
  });

  it('Prompt API 拋錯時退回 Summarizer', async () => {
    fakeLM({ availability: async () => { throw new Error('x'); } });
    fakeSummarizer();
    expect(await aiStatus()).toEqual({ api: 'summarizer', availability: 'available' });
  });

  it('Summarizer 不可用', async () => {
    fakeSummarizer({ availability: 'unavailable' });
    expect(await aiStatus()).toEqual({ api: null, availability: 'unavailable' });
  });

  it('Summarizer 拋錯', async () => {
    fakeSummarizer({ availability: async () => { throw new Error('x'); } });
    expect(await aiStatus()).toEqual({ api: null, availability: 'unavailable' });
  });
});

describe('summarizeTranscript：沒有 API', () => {
  it('拋出錯誤', async () => {
    await expect(summarizeTranscript('x')).rejects.toThrow(
      '這個 Chrome 沒有可用的內建 AI（需 Chrome 138+ 且硬體符合需求）。可改用「複製給 Claude」。'
    );
  });
});

describe('summarizeTranscript：Prompt API', () => {
  it('短逐字稿：預設中文、一次產生', async () => {
    const { LM, base, prompts, sessions } = fakeLM();
    const out = await summarizeTranscript('hello');
    expect(out).toBe('R');
    expect(LM.create).toHaveBeenCalledWith({
      initialPrompts: [{ role: 'system', content: SYSTEM.zh }],
      monitor: expect.any(Function)
    });
    expect(prompts).toEqual([`${FINAL_ZH}\n\nhello`]);
    expect(sessions[0].destroy).toHaveBeenCalledTimes(1);
    expect(base.destroy).toHaveBeenCalledTimes(1);
  });

  it('非中文時指定輸入輸出語言，並回報狀態', async () => {
    const { LM, prompts } = fakeLM({ availability: 'downloadable' });
    const onStatus = vi.fn();
    await summarizeTranscript('hi', 'en', onStatus);
    expect(LM.create).toHaveBeenCalledWith({
      initialPrompts: [{ role: 'system', content: SYSTEM.en }],
      monitor: expect.any(Function),
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }]
    });
    expect(prompts).toEqual([`${FINAL_EN}\n\nhi`]);
    expect(onStatus.mock.calls).toEqual([['準備 AI 模型…'], ['AI 產生會議記錄…']]);
  });

  it('日文提示詞', async () => {
    const { LM, prompts } = fakeLM();
    await summarizeTranscript('hi', 'ja');
    expect(LM.create.mock.calls[0][0].initialPrompts[0].content).toBe(SYSTEM.ja);
    expect(prompts).toEqual([`${FINAL_JA}\n\nhi`]);
  });

  it('下載進度', async () => {
    const { LM } = fakeLM();
    const onStatus = vi.fn();
    await summarizeTranscript('hi', 'zh', onStatus);
    const handlers = {};
    LM.create.mock.calls[0][0].monitor({ addEventListener: (ev, fn) => { handlers[ev] = fn; } });
    handlers.downloadprogress({ loaded: 0.456 });
    expect(onStatus).toHaveBeenLastCalledWith('下載 Chrome 內建 AI 模型… 46%（只需一次）');
  });

  it('沒有 destroy 也不會出錯', async () => {
    fakeLM({ base: { destroy: undefined }, sessionProps: { destroy: undefined } });
    await expect(summarizeTranscript('hi')).resolves.toBe('R');
  });

  it('prompt 失敗時仍釋放 session', async () => {
    const { base, sessions } = fakeLM({ reply: () => { throw new Error('boom'); } });
    await expect(summarizeTranscript('hi')).rejects.toThrow('boom');
    expect(sessions[0].destroy).toHaveBeenCalledTimes(1);
    expect(base.destroy).toHaveBeenCalledTimes(1);
  });

  it('create 以外的失敗也釋放 base', async () => {
    const { base } = fakeLM({ base: { clone: async () => { throw new Error('nope'); } } });
    await expect(summarizeTranscript('hi')).rejects.toThrow('nope');
    expect(base.destroy).toHaveBeenCalledTimes(1);
  });

  // 預算 = max(800, floor((quota - used - 600) * 0.45))；最終提示詞只保留前 budget 字
  const finalLen = (prompts) => prompts.at(-1).length - `${FINAL_ZH}\n\n`.length;

  it.each([
    [{ inputQuota: 10000, inputUsage: 1000, maxTokens: 1 }, 3780],
    [{ maxTokens: 6000 }, 2430],
    [{}, 1573],
    [{ inputQuota: 2000 }, 800]
  ])('預算計算 %j → %i', async (baseProps, budget) => {
    const { prompts } = fakeLM({ base: baseProps, reply: () => 'y'.repeat(budget + 50) });
    await summarizeTranscript('a'.repeat(budget));
    expect(prompts).toHaveLength(1);
    expect(finalLen(prompts)).toBe(budget);
    prompts.length = 0;
    await summarizeTranscript('a'.repeat(budget + 1));
    expect(prompts.length).toBeGreaterThan(1);
    expect(finalLen(prompts)).toBe(budget);
  });

  it('長逐字稿分段整理，最多三輪，最後截斷', async () => {
    const { prompts } = fakeLM({ base: { inputQuota: 2378 }, reply: () => ' ' + 'n'.repeat(500) + ' ' });
    // budget = floor((2378 - 600) * 0.45) = 800
    const line = 'L'.repeat(399);
    const text = [line, line, line, line].join('\n'); // 1599 字 → 兩段
    const onStatus = vi.fn();
    const out = await summarizeTranscript(text, 'zh', onStatus);
    expect(out).toBe('n'.repeat(500));
    expect(prompts[0]).toBe(`${PARTIAL_ZH}\n\n${line}\n${line}`);
    expect(prompts[1]).toBe(`${PARTIAL_ZH}\n\n${line}\n${line}`);
    // 第 2 輪：兩段筆記以空行串接 → 1002 字 > 800，切成兩段
    expect(prompts[2]).toBe(`${PARTIAL_ZH}\n\n${'n'.repeat(500)}`);
    expect(prompts[3]).toBe(`${PARTIAL_ZH}\n\n${'n'.repeat(500)}`);
    expect(prompts[4]).toBe(`${PARTIAL_ZH}\n\n${'n'.repeat(500)}`);
    expect(prompts[5]).toBe(`${PARTIAL_ZH}\n\n${'n'.repeat(500)}`);
    expect(prompts[6]).toBe(`${FINAL_ZH}\n\n${'n'.repeat(500)}\n\n${'n'.repeat(298)}`);
    expect(prompts).toHaveLength(7);
    expect(onStatus.mock.calls.map((c) => c[0])).toEqual([
      'AI 整理中（第 1 輪 1/2 段）…',
      'AI 整理中（第 1 輪 2/2 段）…',
      'AI 整理中（第 2 輪 1/2 段）…',
      'AI 整理中（第 2 輪 2/2 段）…',
      'AI 整理中（第 3 輪 1/2 段）…',
      'AI 整理中（第 3 輪 2/2 段）…',
      'AI 產生會議記錄…'
    ]);
  });

  it('筆記變短後提早結束', async () => {
    const { prompts } = fakeLM({ base: { inputQuota: 2378 }, reply: () => 'ok' });
    await summarizeTranscript('z'.repeat(801), 'en');
    expect(prompts).toEqual([
      `${PARTIAL_EN}\n\n${'z'.repeat(800)}`,
      `${PARTIAL_EN}\n\nz`,
      `${FINAL_EN}\n\nok\n\nok`
    ]);
  });

  it('日文分段提示詞', async () => {
    const { prompts } = fakeLM({ base: { inputQuota: 2378 }, reply: () => 'ok' });
    await summarizeTranscript('z'.repeat(801), 'ja');
    expect(prompts[0]).toBe(`${PARTIAL_JA}\n\n${'z'.repeat(800)}`);
  });
});

describe('分段（chunk）規則', () => {
  // 透過 Prompt API 觀察分段結果；budget 固定 800
  async function parts(text) {
    const { prompts } = fakeLM({ base: { inputQuota: 2378 }, reply: () => 'ok' });
    await summarizeTranscript(text, 'en');
    return prompts.slice(0, -1).map((p) => p.slice(PARTIAL_EN.length + 2));
  }

  it('剛好塞滿的行會換到下一段', async () => {
    const a = 'a'.repeat(400);
    const b = 'b'.repeat(399);
    const c = 'c'.repeat(400);
    // a + \n + b = 800（剛好）；再加 c 會超過
    expect(await parts([a, b, c].join('\n'))).toEqual([`${a}\n${b}`, c]);
  });

  it('多一個字就換段', async () => {
    const a = 'a'.repeat(400);
    const b = 'b'.repeat(400);
    expect(await parts([a, b].join('\n'))).toEqual([a, b]);
  });

  it('第一行剛好等於預算時不產生空段', async () => {
    const a = 'a'.repeat(800);
    expect(await parts(`${a}\nb`)).toEqual([a, 'b']);
  });

  it('過長的單行硬切', async () => {
    const s = 'x'.repeat(800) + 'y'.repeat(800) + 'z'.repeat(5);
    expect(await parts(`q\n${s}`)).toEqual(['q', 'x'.repeat(800), 'y'.repeat(800), 'zzzzz']);
  });

  it('空行被忽略，只有空白行時不送出空段', async () => {
    expect(await parts('\n'.repeat(900))).toEqual([]);
  });

  it('短行之間以換行串接', async () => {
    const lines = Array.from({ length: 500 }, (_, i) => String(i % 10));
    // 400 行 + 399 個換行 = 799 字，再加一行就超過 800
    expect(await parts(lines.join('\n'))).toEqual([
      lines.slice(0, 400).join('\n'),
      lines.slice(400).join('\n')
    ]);
  });
});

describe('summarizeTranscript：Summarizer', () => {
  it('短逐字稿', async () => {
    const { SM, s, inputs } = fakeSummarizer();
    const out = await summarizeTranscript('hello');
    expect(out).toBe('## 重點摘要\nS');
    expect(SM.create).toHaveBeenCalledWith({
      type: 'key-points',
      format: 'markdown',
      length: 'long',
      sharedContext: 'Online meeting transcript',
      monitor: expect.any(Function)
    });
    expect(inputs).toEqual(['hello']);
    expect(s.destroy).toHaveBeenCalledTimes(1);
  });

  it.each([['en', '## Summary'], ['ja', '## 要約']])('語言 %s', async (lang, heading) => {
    const { SM } = fakeSummarizer();
    const onStatus = vi.fn();
    expect(await summarizeTranscript('hi', lang, onStatus)).toBe(`${heading}\nS`);
    expect(SM.create.mock.calls[0][0].outputLanguage).toBe(lang);
    expect(onStatus.mock.calls).toEqual([['AI 產生重點…']]);
  });

  it('下載進度', async () => {
    const { SM } = fakeSummarizer();
    const onStatus = vi.fn();
    await summarizeTranscript('hi', 'zh', onStatus);
    const handlers = {};
    SM.create.mock.calls[0][0].monitor({ addEventListener: (ev, fn) => { handlers[ev] = fn; } });
    handlers.downloadprogress({ loaded: 1 });
    expect(onStatus).toHaveBeenLastCalledWith('下載 Chrome 內建 AI 模型… 100%（只需一次）');
  });

  it('不是 available 時先提示準備', async () => {
    fakeSummarizer({ availability: 'downloadable' });
    const onStatus = vi.fn();
    await summarizeTranscript('hi', 'zh', onStatus);
    expect(onStatus.mock.calls[0]).toEqual(['準備 AI 模型…']);
  });

  it('沒有 destroy 也不會出錯', async () => {
    fakeSummarizer({ props: { destroy: undefined } });
    await expect(summarizeTranscript('hi')).resolves.toBe('## 重點摘要\nS');
  });

  it('失敗時仍釋放', async () => {
    const { s } = fakeSummarizer({ reply: () => { throw new Error('bad'); } });
    await expect(summarizeTranscript('hi')).rejects.toThrow('bad');
    expect(s.destroy).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ inputQuota: 4000 }, 1800],
    [{}, 1800],
    [{ inputQuota: 10000 }, 4500],
    [{ inputQuota: 100 }, 800]
  ])('預算 %j → %i', async (props, budget) => {
    const { inputs } = fakeSummarizer({ props, reply: () => 'w'.repeat(budget + 9) });
    await summarizeTranscript('a'.repeat(budget));
    expect(inputs).toEqual(['a'.repeat(budget)]);
    inputs.length = 0;
    await summarizeTranscript('a'.repeat(budget + 1));
    expect(inputs.at(-1)).toHaveLength(budget);
    expect(inputs.length).toBeGreaterThan(1);
  });

  it('長逐字稿分段摘要，最多三輪', async () => {
    const { inputs } = fakeSummarizer({ props: { inputQuota: 1778 }, reply: () => 'm'.repeat(500) });
    // budget = floor(1778 * 0.45) = 800
    const line = 'L'.repeat(399);
    const onStatus = vi.fn();
    const out = await summarizeTranscript([line, line, line, line].join('\n'), 'zh', onStatus);
    expect(out).toBe('## 重點摘要\n' + 'm'.repeat(500));
    expect(inputs.slice(0, 2)).toEqual([`${line}\n${line}`, `${line}\n${line}`]);
    expect(inputs.slice(2, 6)).toEqual(Array(4).fill('m'.repeat(500)));
    expect(inputs[6]).toBe(`${'m'.repeat(500)}\n${'m'.repeat(299)}`);
    expect(inputs).toHaveLength(7);
    expect(onStatus.mock.calls.map((c) => c[0])).toEqual([
      'AI 摘要中（第 1 輪 1/2 段）…',
      'AI 摘要中（第 1 輪 2/2 段）…',
      'AI 摘要中（第 2 輪 1/2 段）…',
      'AI 摘要中（第 2 輪 2/2 段）…',
      'AI 摘要中（第 3 輪 1/2 段）…',
      'AI 摘要中（第 3 輪 2/2 段）…',
      'AI 產生重點…'
    ]);
  });

  it('摘要變短後提早結束', async () => {
    const { inputs } = fakeSummarizer({ props: { inputQuota: 1778 }, reply: () => 'ok' });
    await summarizeTranscript('z'.repeat(801));
    expect(inputs).toEqual(['z'.repeat(800), 'z', 'ok\nok']);
  });
});

describe('claudePrompt', () => {
  it('組合提示詞', () => {
    expect(claudePrompt('週會', '2024/1/1', '[00:00:00] A：hi')).toBe([
      '請幫我把以下 Google Meet 會議逐字稿整理成會議記錄，使用繁體中文 Markdown，格式如下（某節沒有內容就寫「- 無」）：',
      '## 重點摘要',
      '## 決議事項',
      '## 待辦事項（用 `- [ ] 負責人：事項（期限）`）',
      '只輸出會議記錄本身，不要加前言。逐字稿來自自動字幕，可能有錯字，請依上下文修正。',
      '',
      '會議：週會',
      '時間：2024/1/1',
      '',
      '逐字稿：',
      '[00:00:00] A：hi'
    ].join('\n'));
  });
});
