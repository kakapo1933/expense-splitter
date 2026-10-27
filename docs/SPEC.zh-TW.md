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
- settle-up 的每一筆可標記為已付（記錄成還款，可刪除）。
- 成員可離開與重新加入；離開的成員保留歷史與餘額，但不再被預選。
- 支出可用 20 種幣別之一，以鎖定匯率換算成群組的 base（見「幣別」）。

範圍外（README 的「next steps」）：登入與權限、soft delete + audit log、離線、
全域最少筆數的 settle 演算法。

## 技術棧

- Backend：Node 24、TypeScript、Hono、`node:sqlite`（內建，零 native 依賴）。
- Frontend：Vite + React，手機優先單頁。
- 測試：`node:test` 測金額模組。
- Workspace：pnpm，`server/` + `web/`。

## 資料模型

所有金額欄位一律存**整數最小單位**（USD 即為分；見「幣別」）。

| 表               | 欄位                                                                                                        |
|------------------|-------------------------------------------------------------------------------------------------------------|
| `groups`         | id, name, currency（base，見「幣別」）, created_at                                                        |
| `members`        | id, group_id, name, created_at, left_at（可空）— (group_id, name) 唯一；依 `rowid`（插入順序）排序           |
| `expenses`       | id, group_id, payer_id, description, amount_cents, split_mode（`equal`/`exact`/`percent`）, created_at, updated_at |
| `expense_splits` | expense_id, member_id, share_cents, input_value — PK (expense_id, member_id)                                |
| `settlements`    | id, group_id, from_id, to_id, amount_cents, created_at — 一筆成員對成員的實際還款                           |

決策：

- **餘額只推導、不儲存。** 餘額 = Σ付出 − Σ應分攤。編輯或刪除一筆支出只動那一列與它的 splits，
  餘額不可能飄掉。
- **split 同時存結果（`share_cents`）與使用者輸入（`input_value`）**——輸入的百分比或精確金額。
  結果在寫入時算一次；輸入讓編輯表單能回填（例如再次顯示「33.33%」）。
- 編輯 = 在同一個 transaction 內取代 expense 列、刪除並重插它的 splits。
- 刪除 = 真刪（cascade 到 splits）。
- **還款是一筆資料，不是打勾。** settle 方案是算出來的，沒有固定的列可以標記；「Mark paid」
  寫入一筆還款 `from → to, amount`。還款進餘額的方式等同「from 付了一筆、唯一分攤者是 to」
  （from +amount、to −amount）。方案從新餘額重算，付過的那列會消失或縮小。還款可刪（按錯）。
- **離開是旗標，不是刪除。** 中途離開的成員歷史還在、可能仍欠或被欠。`left_at` 設定後：
  新支出的預設參與者與預設付款人排除他、餘額區放到「Left」小節、仍可手動勾選、仍在餘額與
  方案裡直到歸零。可復原（`left_at = null`）。

## 金額邏輯（`server/src/money.ts`，純函式，不碰 DB）

- `splitEqual(total, memberIds)`：每人 `floor(total / n)`；餘數 `r` 分，依成員順序給前 `r` 位各 1 分。
  $100 / 3 → 3334 / 3333 / 3333。
- `splitPercent(total, [{id, pct}])`：每人先取 `total * pct / 100` 無條件捨去（用整數 basis
  points 算，不經浮點），殘差 `total − Σfloor` 以**最大餘數法**分配，同餘數依成員順序。
  百分比加總必須等於 100 ± 0.01，否則 400。因為有容許值，殘差可能超過每人一分（例如 $1000
  按 33.33 × 3 會剩 7 分）或為負（加總 100.01）：依最大餘數順序循環每次加一分（為負時依最小
  餘數順序每次減一分），直到 share 加總恰等於 `total`。不變量：Σ share = total，永遠成立。
- `splitExact(total, [{id, cents}])`：加總必須恰等於 `total`，否則 400。
- `balances(expenses, settlements)`：每人 付出 − 應分攤，還款視為 `from` 付出、`to` 應分攤。全體加總恆為 0。
- `settle(balances)`（「最少筆數」）：債權人降冪、債務人降冪排序；雙指標貪婪，每步付
  `min(credit, debt)`。最多 n−1 筆。不保證全域最少（那是 NP-hard）；作為取捨明講。
  債務跨全員抵銷，所以可能付錢給從未替你墊過錢的人。
- `settleDirect(expenses)`（「還給替你付錢的人」）：對每筆支出、每個 member ≠ payer 的 split，
  `debt[member→payer] += share`。再對每一對成員把兩個方向抵銷（`a→b − b→a`），正的一方出一筆
  轉帳。依金額降冪、同額依成員順序。筆數比 `settle` 多，但每一筆都是還給實際替你付錢的人。
  它的總額通常比 `settle` 大（只在成對之間抵銷，不跨全員），但兩種方案都能把所有餘額歸零。

餘數一律依**成員順序**（= 插入順序，即 `members` 的 SQLite `rowid`；不用時間戳，同一毫秒會撞）給前面的成員。
不選「給付款人」，因為前者規則更簡單、可預測。

## API

```
POST   /api/groups                        { name }                         → group
GET    /api/groups/:id                                                     → group + members + expenses(+splits) + balances + settlement
POST   /api/groups/:id/members            { name }                         → member
POST   /api/groups/:id/expenses           ExpenseInput                     → expense
PUT    /api/groups/:id/expenses/:eid      ExpenseInput                     → expense
DELETE /api/groups/:id/expenses/:eid                                       → 204
POST   /api/groups/:id/settlements        { fromId, toId, amount }        → 201 settlement（from ≠ to，皆屬群組）
DELETE /api/groups/:id/settlements/:sid                                   → 204
PATCH  /api/groups/:id/members/:mid       { left: boolean }               → 200 member（設定／清除 left_at）
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
  members: { id, name, createdAt, leftAt }[],      // 依成員順序；leftAt 為 null = 在籍
  expenses: { id, description, amountCents, payerId, splitMode, createdAt, updatedAt,
              splits: { memberId, shareCents, inputValue }[] }[],   // 新的在前
  settlements: { id, fromId, toId, amountCents, createdAt }[],      // 新的在前
  balances: { memberId, paidCents, owedCents, netCents }[],         // net = paid − owed（支出 + 還款）
  settlement: { fromId, toId, cents }[],                            // 最少筆數（貪婪）
  settlementDirect: { fromId, toId, cents }[]                       // 還給替你付錢的人
}
```

所有計算都在後端；前端只渲染這個 payload。
id 一律 UUID v4（`crypto.randomUUID()`），群組 URL 不可猜。
成員不能改名或刪除（刪了會讓它的 splits 失去歸屬）——列為範圍外。

不做登入：知道群組 URL 就等於受邀。

## 幣別

前四個階段之後加入（紀錄見 `TODO-multi-currency.md`）。`money.ts` 除了多一個選填的 `decimals`
參數外不變；以下所有東西都先換算成 base 再交給它。

**資料模型。** 金額欄位存整數**最小單位**（minor unit）；每個幣別的 `decimals`（在
`server/src/rates.ts`）表示幾個最小單位等於一個主單位——USD/EUR/… 為 2，TWD/JPY/KRW/VND/IDR 為 0。

- `groups.currency`：群組的 base currency，建立時設定（預設 `USD`）。
- `expenses.currency`、`expenses.original_cents`（實付金額，以該幣別最小單位計）、
  `expenses.rate_nanos`（鎖定的匯率）與 `expenses.amount_cents`（換算後的 base 金額——分攤與餘額
  用的就是它）。舊資料回填為 `currency = base, original_cents = amount_cents, rate_nanos = 10^9`。
- `group_rates (group_id, currency, rate_nanos > 0, updated_at)`，PK `(group_id, currency)`：
  群組自訂匯率。
- 分攤與還款一律以 base 計。

**匯率慣例。** 匯率是「1 單位外幣等於多少 base 單位」，以乘上 10^9 的整數儲存（`rate_nanos`），
API 上以最多 9 位小數的十進位字串傳遞（`"0.216129032"`），不用浮點數。內建匯率表有 20 種幣別，
各附一個近似的 `usdPerUnit`；內建的 X → Y 匯率經由 USD 推算。base 幣別的支出匯率固定為 10^9。

**匯率決定順序**（新增或編輯支出時）：輸入中明確給的 `rate` > 群組自訂匯率 > 內建交叉匯率。
決定後的匯率存在該筆支出上，之後不再回頭查表，所以後來改自訂匯率不會動到既有支出。

**換算。** `base = round_half_up(orig × rate_nanos × 10^(baseDec − origDec) / 10^9)`，以 BigInt
計算；結果必須 > 0（否則 `INVALID_AMOUNT`）且不超過金額上限。

**指定金額（exact）模式。** 每人份額以支出的幣別輸入，總和必須等於原幣金額
（否則 `EXACT_SUM_MISMATCH`）。每份以同一匯率換算後無條件捨去，與 `amount_cents` 的差額依
最大餘數一次一單位補上（同餘數依成員順序），因此 Σ share_cents = amount_cents。平分與百分比
照舊在 base 上分 `amount_cents`。

**更改 base。** 只有群組還沒有任何支出時才允許；否則 409 `GROUP_NOT_EMPTY`。之後再改就得重新
換算歷史資料——不在範圍內。

**API 新增。**

```
POST   /api/groups                        { name, currency? }      → 201 group
PATCH  /api/groups/:id                    { currency }             → 200 group · 409 GROUP_NOT_EMPTY
PUT    /api/groups/:id/rates/:currency    { rate }                 → 200 rates block
DELETE /api/groups/:id/rates/:currency                             → 204 · 沒有自訂匯率時 404
```

- `ExpenseInput` 新增 `currency?`（預設 base）與 `rate?`（預設自訂匯率，其次內建）。`amount`
  與 exact 的 `shares[].amount` 以 `currency` 計，小數位數不得超過其 `decimals`。base 幣別的
  支出帶 `rate` → 400 `INVALID_RATE`；替 base 本身設自訂匯率 → 400 `INVALID_RATE`。
- 錯誤碼：`UNKNOWN_CURRENCY`（400）、`INVALID_RATE`（400）、`GROUP_NOT_EMPTY`（409）。
- View：每筆支出多 `currency`、`originalCents`、`rate`；頂層多
  `rates: { base, table: { currency, name, decimals, rate, source: "seed" | "override" }[] }`
  （每個非 base 幣別一列）。

**前端。** 建立頁可選 base；支出表單有幣別選單、可編輯的匯率列與 `≈` base 總額；從 header 的
base 標籤開啟換算器（Converter）bottom sheet，含匯率表與自訂匯率；settle 卡片有只供顯示的
「show in …」選單——Mark paid 仍記錄 base 金額。

## 前端

單頁、手機優先：

1. 頂部：群組名、成員 chips、「+ 成員」。
2. 餘額卡 + settle-up 清單（每行「A → B $12.34」）——最常看，放前面。settle 卡有兩段切換
   **Fewest payments / Pay who paid for you**（預設最少筆數，以 localStorage 記住每個瀏覽器的選擇）；
   標題顯示目前模式的筆數。每一列有 **Mark paid** 動作，記下正好那一列的還款（inline 確認，
   同刪除）。已記的還款列在支出下方的 **Payments** 區，每筆可刪。餘額區先列在籍成員，
   有人離開時再加 **Left** 小標。成員 chips：離開者的 chip 變淡、點開有 inline「Rejoin」；
   在籍者點開有「Mark as left」。記帳 sheet 內離開者預設不勾、不作預設付款人，但仍可在
   「Left」分隔線下勾選。
3. 支出列表；底部固定「+ 記一筆」，開 bottom sheet。

記一筆的最短路徑：描述 + 金額 + 送出（付款人預設上次的人，分法預設全員平分）。
金額欄用 `inputmode="decimal"`。

路由：`/` 建群組（完成後導向）；`/g/:id` 群組頁。群組 URL 就是邀請連結；群組頁有
**Copy link** 按鈕（手機用 `navigator.share`，否則寫剪貼簿），以及回 `/` 的**首頁連結**（建新群組或選最近的群組）。

**最近的群組**（沒有帳號，所以是每個瀏覽器各自記）：每次成功載入 `/g/:id` 就把
`{id, name, lastVisited}` 存進 localStorage；`/` 在建群表單上方列出，最近的在前，群組 404 時移除。
明講的限制：換裝置就看不到。

同步：收到 SSE `changed` 就重抓 `GET /api/groups/:id`。`EventSource` 自動重連；重連後重抓一次。

## 執行方式

- `pnpm install && pnpm dev` — server 在 :3000，Vite 在 :5173 並 proxy `/api`。
- `pnpm test` — 金額模組測試。`pnpm build && pnpm start` — server 直接 serve `web/dist`。
- SQLite 檔在 `server/data/app.db`；可用 `PORT`、`DB_PATH` 環境變數覆蓋。

## 為現場加功能預留（不實作）

可能的題目：記錄「已結清」、多幣別、分攤之上加小費／稅。讓 `money.ts` 保持純函式、
`expenses` 可擴充（例如未來的 `kind` 欄位），任何一題都是「新增一個函式 + 一個 migration」，
不是重寫。
