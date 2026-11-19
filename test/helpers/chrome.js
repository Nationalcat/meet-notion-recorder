import { vi } from 'vitest';

const clone = (v) => (v === undefined ? v : structuredClone(v));

// 記憶體版的 chrome.* API，足以驅動擴充元件的各個腳本。
export function makeChrome(initial = {}) {
  const data = clone(initial);
  const listeners = { changed: [], message: [], installed: [] };
  const chrome = {
    storage: {
      local: {
        get: vi.fn(async (keys) => {
          if (keys == null) return clone(data);
          const out = {};
          for (const k of [].concat(keys)) if (k in data) out[k] = clone(data[k]);
          return out;
        }),
        set: vi.fn(async (obj) => { Object.assign(data, clone(obj)); }),
        remove: vi.fn(async (keys) => { for (const k of [].concat(keys)) delete data[k]; })
      },
      onChanged: { addListener: vi.fn((fn) => listeners.changed.push(fn)) }
    },
    runtime: {
      onMessage: { addListener: vi.fn((fn) => listeners.message.push(fn)) },
      onInstalled: { addListener: vi.fn((fn) => listeners.installed.push(fn)) },
      sendMessage: vi.fn(async () => {}),
      openOptionsPage: vi.fn(),
      getURL: vi.fn((p) => 'chrome-extension://ext/' + p)
    },
    tabs: {
      create: vi.fn(),
      query: vi.fn(async () => []),
      sendMessage: vi.fn(async () => ({}))
    },
    action: {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {})
    }
  };
  vi.stubGlobal('chrome', chrome);
  return { chrome, data, listeners };
}

export const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

// 只用 microtask 等待（可與 fake timers 並用）
export const tick = async (n = 30) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

// 載入擴充頁面的 <body>（去掉 <script>）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export function loadBody(file) {
  const html = readFileSync(fileURLToPath(new URL('../../' + file, import.meta.url)), 'utf8');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script').forEach((s) => s.remove());
  document.body.innerHTML = doc.body.innerHTML;
}
