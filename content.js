// 在 Google Meet 頁面擷取即時字幕，整理成逐字稿存到 chrome.storage.local。
// Meet 的 DOM class 名稱是混淆過的、會變動，所以每個選擇器都有語系無關的備援。
(() => {
  'use strict';
  if (window.__meetNotesLoaded) return;
  window.__meetNotesLoaded = true;

  const TICK_MS = 1000;
  const SAVE_EVERY_MS = 3000;
  const LEAVE_MISSES_TO_END = 3; // 連續幾秒找不到「離開通話」按鈕才判定會議結束

  const LEAVE_SEL = [
    '[jsname="CQylAd"]',
    'button[aria-label*="leave call" i]',
    'button[aria-label*="離開通話"]',
    'button[aria-label*="退出通話"]',
    'button[aria-label*="退出通话"]',
    'button[aria-label*="離開會議"]'
  ].join(',');

  const REGION_SEL = [
    'div[role="region"][aria-label*="caption" i]',
    'div[role="region"][aria-label*="字幕"]',
    'div[jsname="dsyhDe"]'
  ].join(',');

  const settings = { autoCaptions: true };
  let meeting = null;
  let inCall = false;
  let leaveMisses = 0;
  let recording = true;
  let dirty = false;
  let lastSave = 0;
  let region = null;
  let observer = null;
  let scanTimer = null;
  let captionClicks = 0;
  const blockEntry = new WeakMap(); // 字幕區塊元素 → 逐字稿條目

  const safe = (fn) => { try { return fn(); } catch { return undefined; } };
  const send = (msg) => safe(() => chrome.runtime.sendMessage(msg).catch(() => {}));

  safe(() => chrome.storage.local.get('settings').then(({ settings: s }) => Object.assign(settings, s || {})));
  safe(() => chrome.storage.onChanged.addListener((c, area) => {
    if (area === 'local' && c.settings) Object.assign(settings, c.settings.newValue || {});
  }));

  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const lines = (s) => (s || '').split('\n').map(clean).filter(Boolean);

  function meetCode() {
    const m = location.pathname.match(/([a-z]{3,4}-[a-z]{4}-[a-z]{3,4})/i);
    return m ? m[1] : 'meet';
  }

  function meetingTitle() {
    const el = document.querySelector('[data-meeting-title]');
    const t = clean(el?.getAttribute('data-meeting-title') || el?.textContent);
    if (t) return t;
    const dt = clean(document.title.replace(/^Meet\s*[-–—:]\s*/i, ''));
    return dt && !/^(google )?meet$/i.test(dt) ? dt : meetCode();
  }

  function ensureCaptionsOn() {
    if (!settings.autoCaptions || captionClicks >= 3) return;
    const btn = $$('button[aria-label][aria-pressed="false"]')
      .find((b) => /caption|字幕/i.test(b.getAttribute('aria-label')));
    if (btn) { btn.click(); captionClicks++; }
  }

  // 回傳 [{ el, speaker, text }]，每個 el 是一段發言的區塊
  function readBlocks(root) {
    const known = $$('.nMcdL', root);
    if (known.length) {
      return known.map((el) => ({
        el,
        speaker: clean(el.querySelector('.NWpY1d, .KcIKyf')?.textContent),
        text: clean(el.querySelector('.ygicle, .bh44bd')?.textContent)
      }));
    }
    // 備援：每段發言都有講者頭像，從頭像往上找到「名字 + 內容」的區塊
    const out = [];
    const seen = new Set();
    for (const img of $$('img', root)) {
      let el = img.parentElement;
      while (el && el !== root && lines(el.innerText).length < 2) el = el.parentElement;
      if (!el || el === root || seen.has(el)) continue;
      seen.add(el);
      const [speaker, ...rest] = lines(el.innerText);
      out.push({ el, speaker, text: clean(rest.join(' ')) });
    }
    return out;
  }

  // Meet 會就地修正字幕，長段落也可能把開頭裁掉；盡量合併而不遺失內容
  function mergeText(oldT, newT) {
    if (!oldT || newT === oldT) return newT;
    if (newT.startsWith(oldT.slice(0, Math.min(15, oldT.length)))) return newT;
    // 開頭被裁掉：舊文字的結尾與新文字的開頭重疊
    for (let k = Math.min(oldT.length, newT.length); k >= 8; k--) {
      if (oldT.endsWith(newT.slice(0, k))) return oldT + newT.slice(k);
    }
    // 開頭被裁掉且結尾被修正：在舊文字中找新文字的開頭
    const idx = oldT.lastIndexOf(newT.slice(0, Math.min(12, newT.length)));
    if (idx > 0) return oldT.slice(0, idx) + newT;
    return newT.length >= oldT.length ? newT : `${oldT} ${newT}`;
  }

  function scan() {
    if (!meeting || !recording || !region) return;
    for (const { el, speaker, text } of readBlocks(region)) {
      if (!text) continue;
      let entry = blockEntry.get(el);
      // 同一個 DOM 區塊被換給另一位講者時，另開新條目
      if (entry && speaker && entry.speaker !== speaker && entry.text) entry = null;
      if (!entry) {
        const prev = meeting.entries[meeting.entries.length - 1];
        entry = { speaker: speaker || prev?.speaker || '未知', text: '', t: Date.now() - meeting.startedAt };
        meeting.entries.push(entry);
        blockEntry.set(el, entry);
      }
      const merged = mergeText(entry.text, text);
      if (merged !== entry.text) { entry.text = merged; dirty = true; }
    }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 250);
  }

  function attachRegion() {
    const r = document.querySelector(REGION_SEL);
    if (r === region) return;
    observer?.disconnect();
    observer = null;
    region = r;
    if (!region) return;
    observer = new MutationObserver(scheduleScan);
    observer.observe(region, { childList: true, subtree: true, characterData: true });
    scheduleScan();
  }

  function snapshot() {
    return {
      ...meeting,
      entries: meeting.entries.filter((e) => e.text.trim()).map((e) => ({ ...e }))
    };
  }

  async function save() {
    if (!meeting || !dirty) return;
    dirty = false;
    lastSave = Date.now();
    const m = snapshot();
    if (!m.entries.length) return;
    try {
      await chrome.storage.local.set({ ['meeting:' + m.id]: m });
    } catch {
      dirty = true;
    }
  }

  function startMeeting() {
    const now = Date.now();
    const code = meetCode();
    meeting = {
      id: `${code}_${now}`,
      meetCode: code,
      title: meetingTitle(),
      url: location.origin + location.pathname,
      startedAt: now,
      endedAt: null,
      entries: []
    };
    captionClicks = 0;
    dirty = true;
    send({ type: 'MEETING_STARTED', id: meeting.id });
  }

  function endMeeting() {
    if (!meeting) return;
    scan();
    meeting.endedAt = Date.now();
    send({ type: 'MEETING_ENDED', meeting: snapshot() });
    observer?.disconnect();
    observer = null;
    region = null;
    meeting = null;
  }

  function tick() {
    const present = !!document.querySelector(LEAVE_SEL);
    if (present) {
      leaveMisses = 0;
      if (!inCall) { inCall = true; startMeeting(); }
    } else if (inCall && ++leaveMisses >= LEAVE_MISSES_TO_END) {
      inCall = false;
      endMeeting();
    }
    if (!meeting) return;
    if (meeting.title === meeting.meetCode) {
      const t = meetingTitle();
      if (t !== meeting.title) { meeting.title = t; dirty = true; }
    }
    if (recording) ensureCaptionsOn();
    attachRegion();
    if (Date.now() - lastSave >= SAVE_EVERY_MS) save();
  }

  setInterval(tick, TICK_MS);
  window.addEventListener('pagehide', () => { if (meeting) endMeeting(); });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === 'GET_STATUS') {
      reply({
        inCall,
        recording,
        captionsFound: !!region,
        meetingId: meeting?.id || null,
        title: meeting?.title || '',
        count: meeting ? meeting.entries.filter((e) => e.text).length : 0,
        last: meeting?.entries[meeting.entries.length - 1] || null
      });
    } else if (msg.type === 'SET_RECORDING') {
      recording = !!msg.value;
      if (recording) { captionClicks = 0; scheduleScan(); }
      reply({ recording });
    }
  });
})();
