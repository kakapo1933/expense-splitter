# 開發進度

依 `SPEC.md` 分段實作；每段完成就在這裡打勾並註記驗證方式。即時更新。

分工：本對話串（主管）負責需求、文件、驗收與更新本檔；每一段開發各開一個新的對話串執行，
開發串只動自己那段的程式碼、不改 `docs/`，完成後自行 commit。

## 0. 設計
- [x] 技術棧定案：Hono + `node:sqlite` + Vite React（commit 8d04f8a）
- [x] 規格寫成 `docs/SPEC.md` / `docs/SPEC.zh-TW.md`（commit 5056f00）

## 1. Scaffold
- [ ] pnpm workspace：根 `package.json`、`pnpm-workspace.yaml`
- [ ] `server/`：Hono + `@hono/node-server`、tsconfig、`src/index.ts` 含 `GET /api/health`
- [ ] `web/`：Vite + React + TS，`vite.config.ts` proxy `/api` → :3000
- [ ] 根指令：`pnpm dev`（同時起兩邊）、`pnpm test`、`pnpm build`、`pnpm start`
- 驗證：`pnpm install && pnpm dev` 跑起來，`curl :3000/api/health` 回 `{"ok":true}`，:5173 開得出空白頁

## 2. 金額邏輯（`server/src/money.ts`）
- [ ] `parseAmount("12.34") → 1234`，拒絕非法字串
- [ ] `splitEqual`：餘數依成員順序給前面的人
- [ ] `splitPercent`：最大餘數法；加總 ≠ 100 丟錯
- [ ] `splitExact`：加總 ≠ total 丟錯
- [ ] `balances`：paid − owed，全體加總為 0
- [ ] `settle`：雙指標貪婪，≤ n−1 筆
- [ ] `node:test`：$100÷3、$0.01÷3、$10 按 33.33/33.33/33.34%、exact 不合、編輯後餘額、settle 清空
- 驗證：`pnpm test` 全綠

## 3. 資料與 API
- [ ] `db.ts`：開檔、建四張表、`PRAGMA foreign_keys=ON`、WAL
- [ ] `schemas.ts`：zod `ExpenseInput`、`NameInput`
- [ ] `routes.ts`：七個 endpoint；寫入在 transaction 內；群組成員檢查
- [ ] `events.ts`：SSE，每群組一組訂閱者，寫入後廣播 `changed`
- [ ] 錯誤處理：zod → 400 `{error, issues}`；找不到 → 404
- 驗證：curl 建群、加人、記三種分法、改、刪；重啟 server 後 `GET` 資料仍在；`curl -N /events` 看得到廣播

## 4. 前端
- [ ] 設計稿：手機版三區塊（header／餘額+settle／支出列表+記帳 sheet）的靜態稿，確認後才實作
- [ ] `/` 建群組 → 導向 `/g/:id`
- [ ] `/g/:id`：header（群名、成員 chips、+ 成員）
- [ ] 餘額卡 + settle-up 清單
- [ ] 支出列表（點一筆進編輯）、刪除
- [ ] 底部「+ 記一筆」bottom sheet：描述、金額、付款人、分法三模式
- [ ] SSE 訂閱 → 重抓
- [ ] 手機寬度排版
- 驗證：Browser pane 兩個分頁同一群組，一邊記帳另一邊即時更新；375px 寬無跑版；截圖存 `docs/evidence/`

## 5. 交付
- [ ] README：安裝與執行、設計決策（從 SPEC 濃縮）、取捨、next steps
- [ ] 整理 commit、確認 `.gitignore` 排除 db 與 dist
- [ ] 推到 GitHub，回信附連結
