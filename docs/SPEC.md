# Group Expense Splitter — Spec

Take-home from William (deadline 2026-10-25). Target: < 1 hour, working core + clear tradeoffs.
This file records the design agreed before writing code. The README summarises it for reviewers.
**Keep in sync with `SPEC.zh-TW.md`.**

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

Open points (to confirm): remainder goes to first members (Splitwise behaviour) vs. the payer.
Default: first members — simpler, predictable.

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

Validation (zod) → 400 with `{ error, issues }`. Unknown ids → 404. All calculation lives in the
backend; the frontend only renders what `GET /api/groups/:id` returns.

No auth: knowing the group URL is the invite.

## Frontend

One page, mobile-first:

1. Header: group name, member chips, "+ member".
2. Balances card + settle-up list ("A → B $12.34" per line) — most-read, so near the top.
3. Expense list; fixed bottom "+ Add expense" opening a bottom sheet.

Fastest path to log an expense: description + amount + submit (payer defaults to last used,
split defaults to equal across all members). `inputmode="decimal"` on amount.

Sync: on SSE `changed`, refetch `GET /api/groups/:id`.
