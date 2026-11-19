# Meet 會議記錄 → Notion（Chrome 擴充元件）

在 Google Meet 會議中自動擷取**即時字幕**成逐字稿，會後用 **Chrome 內建 AI**（Gemini Nano，本機執行）或 **Claude.ai** 整理摘要／決議／待辦，一鍵寫入 **Notion**。
全程不需要任何付費 API。

## 運作方式

```
Google Meet 字幕 (CC) ──content.js──▶ chrome.storage（本機逐字稿）
                                         │ 會議結束自動開啟
                                         ▼
                            整理頁 review.html
              ┌──────────────┬───────────────────┐
     Chrome 內建 AI 摘要   複製給 Claude 整理    手動編輯
              └──────────────┴───────────────────┘
                                         ▼
                         Notion API（免費 integration）
```

## 安裝

1. 開啟 `chrome://extensions`，打開右上角「開發人員模式」。
2. 點「載入未封裝項目」，選擇 `meet-notion-recorder` 資料夾。
3. 安裝後會自動打開設定頁。

## 設定 Notion（免費）

1. 到 <https://www.notion.so/profile/integrations> → **New integration**（Internal），複製 **Internal Integration Secret**。
2. 在 Notion 建立一個資料庫，建議欄位（名稱可用中文或英文，擴充元件會自動對應）：

   | 欄位 | 類型 | 自動填入 |
   |---|---|---|
   | 名稱 | Title | 會議標題 |
   | 日期 | Date | 會議開始～結束時間 |
   | 參與者 | Multi-select 或 Text | 字幕中出現的講者 |
   | 會議連結 | URL | Meet 網址 |

   也可以只給一個一般頁面，會議記錄會建立成它的子頁面。
3. 在資料庫右上角 **⋯ → 連線（Connections）** 加入剛建立的 integration（**沒做這步會找不到頁面**）。
4. 把資料庫網址貼到設定頁，按「測試連線」。

## 使用

1. 加入 Google Meet 會議 → 擴充元件自動開啟字幕並開始記錄（圖示顯示紅色 `REC`）。
   - 請先在 Meet「設定 → 字幕」選好會議語言（例如中文（台灣））。
   - 點擴充元件圖示可看到即時狀態、暫停／繼續記錄。
2. 離開會議 → 自動開啟整理頁。
3. 產生摘要（擇一）：
   - **✨ 用 Chrome 內建 AI 產生**：完全本機、免費。第一次會下載模型。
   - **📋 複製給 Claude 整理**：複製「提示詞＋逐字稿」，貼到 claude.ai，再把結果貼回摘要欄。中文品質通常比內建 AI 好。
4. 按 **儲存到 Notion**。頁面內容：資訊列 → 摘要（標題、條列、待辦 checkbox）→ 可收合的逐字稿。

## Chrome 內建 AI 需求

- Chrome 138 以上（桌面版 Windows / macOS / Linux / ChromeOS）。
- 約 22 GB 可用磁碟空間；GPU 4 GB 以上 VRAM，或 16 GB RAM + 4 核心 CPU。
- 模型官方支援英文、日文、西班牙文；繁體中文設為「實驗性」，品質不穩時請改用 Claude。
- 不符合需求時按鈕會停用，仍可用「複製給 Claude」或手動輸入。

## 檔案結構

| 檔案 | 用途 |
|---|---|
| `manifest.json` | MV3 設定 |
| `content.js` | 在 Meet 頁面開字幕、監聽字幕 DOM、合併逐字稿、偵測會議結束 |
| `background.js` | REC 徽章、會議結束時保存並開啟整理頁 |
| `review.html/js` | 會議列表、摘要、存到 Notion、下載 Markdown |
| `popup.html/js` | 工具列小視窗：即時狀態、暫停 |
| `options.html/js` | Notion 與擷取設定 |
| `lib/notion.js` | Notion API：解析目標、Markdown → blocks、分批寫入 |
| `lib/ai.js` | Chrome Prompt API / Summarizer API、長逐字稿分段整理 |
| `test/mock-meet.html` | 模擬 Meet 字幕 DOM 的測試頁 |

## 單元測試與變異測試

```bash
npm install
npm test            # Vitest + jsdom
npm run coverage    # 覆蓋率，門檻 100%（statements / branches / functions / lines）
npm run mutation    # Stryker 變異測試，門檻 100 分
```

- 測試在 `test/unit/`，`test/helpers/chrome.js` 提供記憶體版的 `chrome.*` API。
- `test/helpers/setup.js` 會讓任何未處理的錯誤直接使測試失敗。
- Stryker 需要開本機連接埠給 worker 使用；在 Claude Code 的沙箱中要允許 local binding。

## 測試字幕擷取（不用真的開會）

```bash
python3 -m http.server 8765
```

開啟 <http://localhost:8765/test/mock-meet.html>，約 15 秒後頁面會印出擷取結果（也可在 Console 看 `window.__test`）。

## 限制與注意事項

- **只能記錄字幕看得到的內容**，準確度取決於 Meet 字幕；講者名稱來自字幕顯示的名字。
- Google 會更改 Meet 的網頁結構。若擷取失效，調整 `content.js` 頂端的 `LEAVE_SEL`、`REGION_SEL` 與 `readBlocks()` 的選擇器即可（已內建語系無關的備援解析）。
- 逐字稿只存在本機 `chrome.storage.local`，Notion Token 也只存在本機。
- 記錄會議前請告知與會者並取得同意。
