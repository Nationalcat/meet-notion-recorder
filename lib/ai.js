// 用 Chrome 內建 AI（Gemini Nano，本機執行、免費）整理會議重點。
// 優先用 Prompt API（LanguageModel），沒有的話退回 Summarizer API。

const SYSTEM = {
  zh: '你是專業的會議記錄助理。一律使用繁體中文回答。只根據提供的逐字稿內容，不要捏造任何資訊。',
  en: 'You are a professional meeting note taker. Always answer in English. Use only the transcript provided; never invent facts.',
  ja: 'あなたはプロの議事録作成者です。必ず日本語で回答し、提供された文字起こしの内容のみを使ってください。'
};

const PARTIAL = {
  zh: '請條列這段會議逐字稿中的重點、決議與待辦事項（標註負責人）：',
  en: 'List the key points, decisions and action items (with owners) from this part of the meeting transcript:',
  ja: 'この部分の文字起こしから要点・決定事項・ToDo（担当者付き）を箇条書きにしてください：'
};

const FINAL = {
  zh: '請把以下會議內容整理成 Markdown 會議記錄，嚴格使用這個格式，某一節沒有內容就寫「- 無」：\n## 重點摘要\n- …\n## 決議事項\n- …\n## 待辦事項\n- [ ] 負責人：事項（期限）\n\n會議內容：',
  en: 'Turn the following into Markdown meeting minutes using exactly this format (write "- None" for empty sections):\n## Summary\n- …\n## Decisions\n- …\n## Action items\n- [ ] Owner: task (due)\n\nMeeting content:',
  ja: '以下を次の形式の Markdown 議事録にまとめてください（該当なしは「- なし」）：\n## 要約\n- …\n## 決定事項\n- …\n## ToDo\n- [ ] 担当者：タスク（期限）\n\n会議内容：'
};

export async function aiStatus() {
  if ('LanguageModel' in self) {
    try {
      const a = await LanguageModel.availability();
      if (a !== 'unavailable') return { api: 'prompt', availability: a };
    } catch { /* 繼續嘗試 Summarizer */ }
  }
  if ('Summarizer' in self) {
    try {
      const a = await Summarizer.availability();
      if (a !== 'unavailable') return { api: 'summarizer', availability: a };
    } catch { /* 無可用 API */ }
  }
  return { api: null, availability: 'unavailable' };
}

function chunk(text, size) {
  const out = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > size) { out.push(cur); cur = ''; }
    // 單行過長時硬切
    for (let i = 0; i < line.length; i += size) {
      const piece = line.slice(i, i + size);
      if (cur && cur.length + piece.length + 1 > size) { out.push(cur); cur = ''; }
      cur += (cur ? '\n' : '') + piece;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const progressMonitor = (onStatus) => (m) => {
  m.addEventListener('downloadprogress', (e) => onStatus(`下載 Chrome 內建 AI 模型… ${Math.round(e.loaded * 100)}%（只需一次）`));
};

async function withPrompt(text, lang, onStatus) {
  const opts = { initialPrompts: [{ role: 'system', content: SYSTEM[lang] }], monitor: progressMonitor(onStatus) };
  if (lang !== 'zh') {
    opts.expectedInputs = [{ type: 'text', languages: [lang] }];
    opts.expectedOutputs = [{ type: 'text', languages: [lang] }];
  }
  const base = await LanguageModel.create(opts);
  try {
    const quota = base.inputQuota ?? base.maxTokens ?? 4096;
    const used = base.inputUsage ?? 0;
    // 中日文約 1 字 ≈ 1~2 token，保守估計
    const budget = Math.max(800, Math.floor((quota - used - 600) * 0.45));

    const ask = async (prompt) => {
      const s = await base.clone();
      try { return (await s.prompt(prompt)).trim(); } finally { s.destroy?.(); }
    };

    let material = text;
    for (let round = 1; material.length > budget && round <= 3; round++) {
      const parts = chunk(material, budget);
      const notes = [];
      for (let i = 0; i < parts.length; i++) {
        onStatus(`AI 整理中（第 ${round} 輪 ${i + 1}/${parts.length} 段）…`);
        notes.push(await ask(`${PARTIAL[lang]}\n\n${parts[i]}`));
      }
      material = notes.join('\n\n');
    }
    onStatus('AI 產生會議記錄…');
    return await ask(`${FINAL[lang]}\n\n${material.slice(0, budget)}`);
  } finally {
    base.destroy?.();
  }
}

async function withSummarizer(text, lang, onStatus) {
  const opts = {
    type: 'key-points',
    format: 'markdown',
    length: 'long',
    sharedContext: 'Online meeting transcript',
    monitor: progressMonitor(onStatus)
  };
  if (lang !== 'zh') opts.outputLanguage = lang;
  const s = await Summarizer.create(opts);
  try {
    const budget = Math.max(800, Math.floor((s.inputQuota ?? 4000) * 0.45));
    let material = text;
    for (let round = 1; material.length > budget && round <= 3; round++) {
      const parts = chunk(material, budget);
      const notes = [];
      for (let i = 0; i < parts.length; i++) {
        onStatus(`AI 摘要中（第 ${round} 輪 ${i + 1}/${parts.length} 段）…`);
        notes.push(await s.summarize(parts[i]));
      }
      material = notes.join('\n');
    }
    onStatus('AI 產生重點…');
    const heading = { zh: '## 重點摘要', en: '## Summary', ja: '## 要約' }[lang];
    return `${heading}\n${(await s.summarize(material.slice(0, budget))).trim()}`;
  } finally {
    s.destroy?.();
  }
}

export async function summarizeTranscript(text, lang = 'zh', onStatus = () => {}) {
  const { api, availability } = await aiStatus();
  if (!api) {
    throw new Error('這個 Chrome 沒有可用的內建 AI（需 Chrome 138+ 且硬體符合需求）。可改用「複製給 Claude」。');
  }
  if (availability !== 'available') onStatus('準備 AI 模型…');
  return api === 'prompt' ? withPrompt(text, lang, onStatus) : withSummarizer(text, lang, onStatus);
}

export function claudePrompt(meetingTitle, dateText, transcript) {
  return [
    '請幫我把以下 Google Meet 會議逐字稿整理成會議記錄，使用繁體中文 Markdown，格式如下（某節沒有內容就寫「- 無」）：',
    '## 重點摘要',
    '## 決議事項',
    '## 待辦事項（用 `- [ ] 負責人：事項（期限）`）',
    '只輸出會議記錄本身，不要加前言。逐字稿來自自動字幕，可能有錯字，請依上下文修正。',
    '',
    `會議：${meetingTitle}`,
    `時間：${dateText}`,
    '',
    '逐字稿：',
    transcript
  ].join('\n');
}
