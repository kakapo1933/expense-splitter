# Group Expense Splitter — 規格（繁體中文版）

William 出的 take-home（截止 2026-10-25）。目標：一小時內完成、核心能動、取捨講清楚。
本檔記錄動手前談定的設計；README 會為審閱者濃縮這份內容。
**本檔與 `SPEC.md` 必須同步修改。**

## 範圍

- 建立群組；用名字加入成員。
- 任何人可記一筆支出：付款人、金額、分法（平分／精確金額／百分比）。
- 顯示每位成員的餘額與 settle-up 方案。
- 支出可編輯／刪除，餘額跟著更新。
- 資料撐過重啟（SQLite）。兩個瀏覽器互相看得到變更（SSE）。

範圍外（README 的「next steps」）：登入與權限、多幣別、soft delete + audit log、離線、
記錄「已結清」、全域最少筆數的 settle 演算法。

## 技術棧

- Backend：Node 24、TypeScript、Hono、`node:sqlite`（內建，零 native 依賴）。
- Frontend：Vite + React，手機優先單頁。
- 測試：`node:test` 測金額模組。
- Workspace：pnpm，`server/` + `web/`。

## 資料模型

所有金額欄位一律存**整數分（cents）**。

| 表               | 欄位                                                                                                        |
|------------------|-------------------------------------------------------------------------------------------------------------|
| `groups`         | id, name, currency（先固定 `USD`）, created_at                                                              |
| `members`        | id, group_id, name — (group_id, name) 唯一                                                                  |
| `expenses`       | id, group_id, payer_id, description, amount_cents, split_mode（`equal`/`exact`/`percent`）, created_at, updated_at |
| `expense_splits` | expense_id, member_id, share_cents, input_value — PK (expense_id, member_id)                                |

決策：

- **餘額只推導、不儲存。** 餘額 = Σ付出 − Σ應分攤。編輯或刪除一筆支出只動那一列與它的 splits，
  餘額不可能飄掉。
- **split 同時存結果（`share_cents`）與使用者輸入（`input_value`）**——輸入的百分比或精確金額。
  結果在寫入時算一次；輸入讓編輯表單能回填（例如再次顯示「33.33%」）。
- 編輯 = 在同一個 transaction 內取代 expense 列、刪除並重插它的 splits。
- 刪除 = 真刪（cascade 到 splits）。

## 金額邏輯（`server/src/money.ts`，純函式，不碰 DB）

- `splitEqual(total, memberIds)`：每人 `floor(total / n)`；餘數 `r` 分，依成員順序給前 `r` 位各 1 分。
  $100 / 3 → 3334 / 3333 / 3333。
- `splitPercent(total, [{id, pct}])`：每人先取 `total * pct / 100` 無條件捨去，剩下的分以
  **最大餘數法**分配，同餘數依成員順序。百分比加總必須等於 100（容許 ±0.01），否則 400。
- `splitExact(total, [{id, cents}])`：加總必須恰等於 `total`，否則 400。
- `balances(expenses)`：每人 付出 − 應分攤。全體加總恆為 0。
- `settle(balances)`：債權人降冪、債務人降冪排序；雙指標貪婪，每步付 `min(credit, debt)`。
  最多 n−1 筆。不保證全域最少（那是 NP-hard）；作為取捨明講。

待定點：餘數給前面的成員（Splitwise 作法）還是給付款人。
預設：前面的成員——規則簡單、可預測。

## API

```
POST   /api/groups                        { name }                         → group
GET    /api/groups/:id                                                     → group + members + expenses(+splits) + balances + settlement
POST   /api/groups/:id/members            { name }                         → member
POST   /api/groups/:id/expenses           ExpenseInput                     → expense
PUT    /api/groups/:id/expenses/:eid      ExpenseInput                     → expense
DELETE /api/groups/:id/expenses/:eid                                       → 204
GET    /api/groups/:id/events             SSE：任何寫入後送 `changed`
```

`ExpenseInput`：

```ts
{
  description: string,            // 1..200 字
  amount: string,                 // 十進位字串 "12.34" — 後端解析成分，不經過浮點
  payerId: string,
  split: { mode: "equal", memberIds: string[] }
       | { mode: "exact",   shares: { memberId, amount: string }[] }
       | { mode: "percent", shares: { memberId, percent: string }[] }
}
```

驗證（zod）失敗 → 400 回 `{ error, issues }`。id 不存在 → 404。所有計算都在後端；
前端只渲染 `GET /api/groups/:id` 回的東西。

不做登入：知道群組 URL 就等於受邀。

## 前端

單頁、手機優先：

1. 頂部：群組名、成員 chips、「+ 成員」。
2. 餘額卡 + settle-up 清單（每行「A → B $12.34」）——最常看，放前面。
3. 支出列表；底部固定「+ 記一筆」，開 bottom sheet。

記一筆的最短路徑：描述 + 金額 + 送出（付款人預設上次的人，分法預設全員平分）。
金額欄用 `inputmode="decimal"`。

同步：收到 SSE `changed` 就重抓 `GET /api/groups/:id`。
