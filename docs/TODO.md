# 開發進度

依 `SPEC.md` 分段實作；每段完成就在這裡打勾並註記驗證方式。即時更新。

分工：本對話串（主管）負責需求、文件、驗收與更新本檔；每一段開發各開一個新的對話串執行，
開發串只動自己那段的程式碼、不改 `docs/`，完成後自行 commit。

## 0. 設計
- [x] 技術棧定案：Hono + `node:sqlite` + Vite React（commit 8d04f8a）
- [x] 規格寫成 `docs/SPEC.md` / `docs/SPEC.zh-TW.md`（commit 5056f00）

## 1. Scaffold
- [x] pnpm workspace：根 `package.json`、`pnpm-workspace.yaml`
- [x] `server/`：Hono + `@hono/node-server`、tsconfig、`src/index.ts` 含 `GET /api/health`（dev 用 tsx watch）
- [x] `web/`：Vite + React + TS，`vite.config.ts` proxy `/api` → :3000
- [x] 根指令：`pnpm dev`、`pnpm test`、`pnpm build`、`pnpm start`
- 驗證：✅ commit 7751bfb；主管串重測 `curl :3999/api/health` 回 `{"ok":true}`、`pnpm build` 過
- 備註：`serveStatic` root 用 cwd 相對路徑換算，從非專案目錄啟動 production 可能失效 → 第 3 段修

## 2. 金額邏輯（`server/src/money.ts`）
- [x] `parseAmount("12.34") → 1234`，拒絕非法字串
- [x] `splitEqual`：餘數依成員順序給前面的人
- [x] `splitPercent`：最大餘數法；加總 ≠ 100±0.01 丟錯；殘差全數分完（spec a0a3c25 補定義）
- [x] `splitExact`：加總 ≠ total 丟錯
- [x] `balances`：paid − owed，全體加總為 0
- [x] `settle`：雙指標貪婪，≤ n−1 筆
- [x] `node:test` 25 個：$100÷3、$0.01÷3、百分比殘差（$1000 按 33.33×3、50/50.01、0/0.01/99.99）、exact 不合、編輯後餘額、settle 清空
- 驗證：✅ commit b114c3a + 修正 7421171；主管串重跑 `pnpm test` 25/25，另外探測四個殘差案例加總皆 = total
- 備註：第一版在 ±0.01 容許值下殘差只補一輪，$1000 會少 7 分；主管串用大金額探出，spec 補規則後修正

## 3. 資料與 API
- [x] `db.ts`：`node:sqlite` 開檔、建四張表、`PRAGMA foreign_keys=ON`、WAL；路徑以 `import.meta.url` 為基準
- [x] `schemas.ts`：zod `ExpenseInput`、`NameInput`
- [x] `service.ts` + `routes.ts`：七個 endpoint；寫入在 transaction 內；群組成員檢查；members/expenses 依 `rowid` 排序
- [x] `events.ts`：SSE，每群組一組訂閱者，寫入後廣播 `changed`
- [x] 錯誤處理：zod → 400 `VALIDATION`；money → 400 帶 code（`PERCENT_SUM_MISMATCH` 等）；未知成員 400 `UNKNOWN_MEMBER`；同名成員 409；找不到 404
- [x] 順便修 `serveStatic` root 改絕對路徑
- 驗證：✅ commit 5892ba2 + 修正 83595e3；主管串 `pnpm test` 31/31；bash 腳本 curl：建群、三人、三種分法、PUT、DELETE、四種壞輸入各 400 且 code 正確、404、重啟後資料仍在、SSE 收到 `changed`；餘額手算核對一致
- 備註：第一版 members `ORDER BY created_at, id`，同毫秒建立時順序隨 UUID 浮動、餘數歸屬不確定；主管串跑測試抓到，spec 改成 rowid 後修正

## 4. 前端
- [x] 設計稿：design session 做研究 + codex 概念圖 + 六畫面 mockup（commit d989387），使用者確認採卡片式
- [x] `/` 建群組（可同時加成員）→ 導向 `/g/:id`
- [x] `/g/:id`：header（群名、成員 chips、+ member、live 小點）
- [x] settle-up 卡（accent 邊框，提到餘額之上）+ 餘額卡（綠 +／紅 −／灰 settled）
- [x] 支出列表（點一筆進編輯、回填原輸入）、刪除需 confirm
- [x] 底部「+ Add expense」bottom sheet：描述、金額、「Kai paid · split equally among 3」摘要列展開付款人與三模式、即時預覽與餘數提示、壞輸入訊息
- [x] SSE 訂閱 → 重抓
- [x] 375px 排版無橫向捲動
- 驗證：✅ commit 35582c0；主管串 Browser pane 實測：建群 + 三人 → $100 平分（預覽 33.34/33.33/33.33）→ $30 percent 50/25/25（加總 90 時 Save 鎖住並提示）→ 餘額手算一致 → 第二分頁不重整收到刪除後更新（SSE）→ 編輯回填 50/25/25 → 375px `scrollWidth == innerWidth`。截圖：`docs/evidence/`（web session 9 張 + 主管串 2 張）
- 備註：exact 模式主管串未親測（web session 有截圖 `sheet-exact-desktop.jpg`，API 層已 curl 驗過）

## 5. 交付
- [x] README：安裝與執行、設計決策（從 SPEC 濃縮）、取捨、next steps（commit b2b9b73，逐項對過程式碼）
- [x] `.gitignore` 排除 db 與 dist；全新 clone 後 `git ls-files` 無 .db
- [x] 推到 GitHub：https://github.com/kakapo1933/expense-splitter（public）；主管串從全新 clone 跑 `pnpm install && pnpm test && pnpm build` 31/31 綠、build 過
- [ ] 回信附連結

## 6. 使用者實測後的修正
- [x] 中文輸入法選字的 Enter 被當成加成員 → 三處 onKeyDown 加 `isComposingEnter` 守衛（commit 007cc81）
- [x] 記帳 sheet「X paid · split equally」摺疊列像提示文字、易忽略 → 付款人／分法預設展開、Cancel/Save sticky（commit 6997089；research.md 與 README 同步改）
- [x] 回報「後面新增的人被算進前面平分的帳」→ 查 `server/data/app.db`：阿咪在所有支出前加入、卡卡只出現在加入後的「電影」，沒有任何支出含記帳當時不存在的成員。實際是「加人後新支出預設全員平分」的 UX 預期落差，非計算錯誤；維持預設全員，README next steps 考慮加「記住上次參與者」
- [ ] 加 Settle 切換 Fewest payments / Pay who paid for you（spec 12f0b5f；settle-direct session 進行中）
- [ ] 記帳 sheet：捲動區底部被 sticky footer 壓到，最後一行（提示／預覽）看不清 → 捲動區加 padding-bottom ≥ footer 高度；平分提示改「Tap a name to exclude or include them.」
- [ ] 群組頁缺「Copy link / Share」按鈕（建群頁寫 Share the link afterwards 但沒地方複製）；Vite 只聽 localhost，手機同網段連不到 → `server.host: true` + README 寫手機測試步驟（等 settle-direct 完成後開 session）

