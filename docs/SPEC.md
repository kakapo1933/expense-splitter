# Group Expense Splitter — Spec

A small full-stack web app for friends splitting shared costs on a trip. Someone creates a
group and adds members by name. Anyone in the group logs an expense — who paid, how much, and
how it is split (equally, by exact amounts, or by percentages). The app shows each person's
current balance and a settle-up plan that clears all debts in as few payments as practical.
Expenses can be edited or deleted and balances follow. Data survives a server restart, and two
people using the app in different browsers see each other's changes.

(Mirror: `SPEC.zh-TW.md` — change both together.)

## Scope

- Create a group; add members by name.
- Anyone can log an expense: payer, amount, split mode (equal / exact / percent).
- Show each member's balance and a settle-up plan.
- Edit / delete expenses; balances follow.
- Data survives restart (SQLite). Two browsers see each other's changes (SSE).

Out of scope (README "next steps"): auth/permissions, multi-currency, soft delete + audit log,
offline, recording settlements as paid, globally-minimal settlement.

## Stack

- Backend: Node 24, TypeScript, Hono, `node:sqlite` (built-in; zero native deps).
- Frontend: Vite + React, mobile-first single page.
- Tests: `node:test` on the money module.
- Workspace: pnpm, `server/` + `web/`.

## Data model

All money columns are **integer cents**.

| Table            | Columns                                                                                                     |
|------------------|-------------------------------------------------------------------------------------------------------------|
| `groups`         | id, name, currency (fixed `USD` for now), created_at                                                        |
| `members`        | id, group_id, name — unique (group_id, name)                                                                |
| `expenses`       | id, group_id, payer_id, description, amount_cents, split_mode (`equal`/`exact`/`percent`), created_at, updated_at |
| `expense_splits` | expense_id, member_id, share_cents, input_value — PK (expense_id, member_id)                                |

Decisions:

- **Balances are derived, never stored.** balance = sum(paid) − sum(share). Editing or deleting an
  expense touches only that row and its splits; balances cannot drift.
- **Splits store both the result (`share_cents`) and the user's input (`input_value`)** — the
  percent or exact amount typed. Result is computed once at write time; input lets the edit form
  round-trip (e.g. show "33.33%" again).
- Edit = replace expense row + delete and re-insert its splits in one transaction.
- Delete = hard delete (cascade splits).

## Money logic (`server/src/money.ts`, pure, no DB)

- `splitEqual(total, memberIds)`: `floor(total / n)` each; remainder `r` cents go one each to the
  first `r` members in member order. $100 / 3 → 3334 / 3333 / 3333.
- `splitPercent(total, [{id, pct}])`: `round-down(total * pct / 100)` each, then distribute the
  remaining cents by **largest remainder**, ties broken by member order. Percent sum must equal
  100 (tolerance 0.01), else 400.
- `splitExact(total, [{id, cents}])`: sum must equal `total` exactly, else 400.
- `balances(expenses)`: per member, paid − owed. Sum over all members is always 0.
- `settle(balances)`: sort creditors desc, debtors desc; two-pointer greedy, each step pays
  `min(credit, debt)`. At most n−1 transfers. Not guaranteed globally minimal (that is NP-hard);
  stated as a tradeoff.

Remainder cents always go to the first members in **member order** (= join order: `created_at`,
then id). Chosen over "give to payer" because it is simpler and predictable.

## API

```
POST   /api/groups                        { name }                         → group
GET    /api/groups/:id                                                     → group + members + expenses(+splits) + balances + settlement
POST   /api/groups/:id/members            { name }                         → member
POST   /api/groups/:id/expenses           ExpenseInput                     → expense
PUT    /api/groups/:id/expenses/:eid      ExpenseInput                     → expense
DELETE /api/groups/:id/expenses/:eid                                       → 204
GET    /api/groups/:id/events             SSE: `changed` after any write
```

`ExpenseInput`:

```ts
{
  description: string,            // 1..200 chars
  amount: string,                 // decimal string "12.34" — parsed server-side to cents, never float
  payerId: string,
  split: { mode: "equal", memberIds: string[] }
       | { mode: "exact",   shares: { memberId, amount: string }[] }
       | { mode: "percent", shares: { memberId, percent: string }[] }
}
```

Validation (zod + group checks) → 400 with `{ error, issues }`. Unknown group/expense → 404.

- `amount`: `^\d+(\.\d{1,2})?$`, > 0, ≤ 10,000,000.00.
- `description`: trimmed, 1..200 chars. `name` (group/member): trimmed, 1..50 chars.
- `payerId` and every `memberId` in `split` must belong to the group; no duplicate members in a split.
- `equal`: at least one member. `percent`: each ≤ 2 decimals, ≥ 0, sum = 100 ± 0.01.
  `exact`: each ≥ 0, sum = amount.

`GET /api/groups/:id` response:

```ts
{
  group: { id, name, currency, createdAt },
  members: { id, name, createdAt }[],              // in member order
  expenses: { id, description, amountCents, payerId, splitMode, createdAt, updatedAt,
              splits: { memberId, shareCents, inputValue }[] }[],   // newest first
  balances: { memberId, paidCents, owedCents, netCents }[],         // net = paid − owed
  settlement: { fromId, toId, cents }[]
}
```

All calculation lives in the backend; the frontend only renders this payload.
Ids are UUID v4 (`crypto.randomUUID()`), so group URLs are not guessable.
Members cannot be renamed or deleted (deleting one would orphan its splits) — out of scope.

No auth: knowing the group URL is the invite.

## Frontend

One page, mobile-first:

1. Header: group name, member chips, "+ member".
2. Balances card + settle-up list ("A → B $12.34" per line) — most-read, so near the top.
3. Expense list; fixed bottom "+ Add expense" opening a bottom sheet.

Fastest path to log an expense: description + amount + submit (payer defaults to last used,
split defaults to equal across all members). `inputmode="decimal"` on amount.

Routes: `/` create a group (then redirect); `/g/:id` group page. The group URL is the invite link.

Sync: on SSE `changed`, refetch `GET /api/groups/:id`. `EventSource` reconnects on its own;
refetch once after reconnect.

## Running

- `pnpm install && pnpm dev` — server on :3000, Vite on :5173 proxying `/api`.
- `pnpm test` — money module tests. `pnpm build && pnpm start` — server serves `web/dist`.
- SQLite file at `server/data/app.db`; `PORT` and `DB_PATH` env override.

## Reserved for the live-interview extension (not implemented)

Likely asks: record a settlement as paid, multi-currency, tip/tax on top of a split. Keep
`money.ts` pure and `expenses` extensible (e.g. a future `kind` column) so any of these is a
new function + one migration, not a rewrite.
