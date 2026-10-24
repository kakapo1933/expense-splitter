# Group Expense Splitter — 規格（繁體中文版）

一個給朋友旅行分攤共同花費的小型 full-stack web app。有人建立群組、用名字加入成員。
群組裡任何人都能記一筆支出——誰付的、多少錢、怎麼分（平分、指定金額或百分比）。
App 顯示每個人目前的餘額，以及一份用盡量少的轉帳把所有欠款清掉的 settle-up 方案。
支出可以編輯或刪除，餘額跟著更新。資料撐過 server 重啟；兩個人在不同瀏覽器使用時，
看得到彼此的變更。

（對照版：`SPEC.md`——兩份一起改。）

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

餘數一律依**成員順序**（= 加入順序：`created_at`，再以 id 決勝）給前面的成員。
不選「給付款人」，因為前者規則更簡單、可預測。

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

驗證（zod + 群組檢查）失敗 → 400 回 `{ error, issues }`。群組／支出不存在 → 404。

- `amount`：`^\d+(\.\d{1,2})?$`，> 0，≤ 10,000,000.00。
- `description`：去頭尾空白後 1..200 字。`name`（群組／成員）：去頭尾空白後 1..50 字。
- `payerId` 與 `split` 內每個 `memberId` 都必須屬於該群組；split 內成員不可重複。
- `equal`：至少一人。`percent`：每個最多兩位小數、≥ 0、加總 = 100 ± 0.01。
  `exact`：每個 ≥ 0、加總 = amount。

`GET /api/groups/:id` 回傳：

```ts
{
  group: { id, name, currency, createdAt },
  members: { id, name, createdAt }[],              // 依成員順序
  expenses: { id, description, amountCents, payerId, splitMode, createdAt, updatedAt,
              splits: { memberId, shareCents, inputValue }[] }[],   // 新的在前
  balances: { memberId, paidCents, owedCents, netCents }[],         // net = paid − owed
  settlement: { fromId, toId, cents }[]
}
```

所有計算都在後端；前端只渲染這個 payload。
id 一律 UUID v4（`crypto.randomUUID()`），群組 URL 不可猜。
成員不能改名或刪除（刪了會讓它的 splits 失去歸屬）——列為範圍外。

不做登入：知道群組 URL 就等於受邀。

## 前端

單頁、手機優先：

1. 頂部：群組名、成員 chips、「+ 成員」。
2. 餘額卡 + settle-up 清單（每行「A → B $12.34」）——最常看，放前面。
3. 支出列表；底部固定「+ 記一筆」，開 bottom sheet。

記一筆的最短路徑：描述 + 金額 + 送出（付款人預設上次的人，分法預設全員平分）。
金額欄用 `inputmode="decimal"`。

路由：`/` 建群組（完成後導向）；`/g/:id` 群組頁。群組 URL 就是邀請連結。

同步：收到 SSE `changed` 就重抓 `GET /api/groups/:id`。`EventSource` 自動重連；重連後重抓一次。

## 執行方式

- `pnpm install && pnpm dev` — server 在 :3000，Vite 在 :5173 並 proxy `/api`。
- `pnpm test` — 金額模組測試。`pnpm build && pnpm start` — server 直接 serve `web/dist`。
- SQLite 檔在 `server/data/app.db`；可用 `PORT`、`DB_PATH` 環境變數覆蓋。

## 為現場加功能預留（不實作）

可能的題目：記錄「已結清」、多幣別、分攤之上加小費／稅。讓 `money.ts` 保持純函式、
`expenses` 可擴充（例如未來的 `kind` 欄位），任何一題都是「新增一個函式 + 一個 migration」，
不是重寫。
