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
- Settle-up rows can be marked as paid (recorded settlements, deletable).
- A member can leave and rejoin; a left member keeps history and balances but is no longer pre-selected.
- Expenses in any of 20 currencies, converted to the group's base at a locked rate (see Currency).

Out of scope (README "next steps"): auth/permissions, soft delete + audit log,
offline, globally-minimal settlement.

## Stack

- Backend: Node 24, TypeScript, Hono, `node:sqlite` (built-in; zero native deps).
- Frontend: Vite + React, mobile-first single page.
- Tests: `node:test` on the money module.
- Workspace: pnpm, `server/` + `web/`.

## Data model

All money columns are **integer minor units** (cents for USD; see Currency).

| Table            | Columns                                                                                                     |
|------------------|-------------------------------------------------------------------------------------------------------------|
| `groups`         | id, name, currency (base, see Currency), created_at                                                        |
| `members`        | id, group_id, name, created_at, left_at (nullable) — unique (group_id, name); ordered by `rowid` (insertion order) |
| `expenses`       | id, group_id, payer_id, description, amount_cents, split_mode (`equal`/`exact`/`percent`), created_at, updated_at |
| `expense_splits` | expense_id, member_id, share_cents, input_value — PK (expense_id, member_id)                                |
| `settlements`    | id, group_id, from_id, to_id, amount_cents, created_at — a recorded payment from one member to another     |

Decisions:

- **Balances are derived, never stored.** balance = sum(paid) − sum(share). Editing or deleting an
  expense touches only that row and its splits; balances cannot drift.
- **Splits store both the result (`share_cents`) and the user's input (`input_value`)** — the
  percent or exact amount typed. Result is computed once at write time; input lets the edit form
  round-trip (e.g. show "33.33%" again).
- Edit = replace expense row + delete and re-insert its splits in one transaction.
- Delete = hard delete (cascade splits).
- **Settlements are payments, not flags.** The settle-up plan is derived, so "mark as paid" cannot
  flag a plan row; it records a payment `from → to, amount`. A settlement enters balances like an
  expense paid by `from` whose only split is `to` (from +amount, to −amount). The plan is recomputed
  from the new balances, so the paid row disappears or shrinks. Settlements can be deleted (mis-tap).
- **Leaving is a flag, not a delete.** A member who leaves mid-trip keeps their history and may
  still owe or be owed. `left_at` set → excluded from the default participants and default payer of
  new expenses, shown under a "Left" heading, still selectable by hand, still in balances and in the
  plan until they are at zero. Reversible (`left_at = null`).

## Money logic (`server/src/money.ts`, pure, no DB)

- `splitEqual(total, memberIds)`: `floor(total / n)` each; remainder `r` cents go one each to the
  first `r` members in member order. $100 / 3 → 3334 / 3333 / 3333.
- `splitPercent(total, [{id, pct}])`: `round-down(total * pct / 100)` each (integer basis points,
  no float), then distribute the residual `total − Σfloor` by **largest remainder**, ties broken by
  member order. Percent sum must equal 100 ± 0.01, else 400. Because of the tolerance the residual
  can exceed one cent per member (e.g. $1000 at 33.33 × 3 leaves 7 cents) or be negative (sum
  100.01): cycle through the largest-remainder order adding (or, when negative, subtracting from
  the smallest-remainder order) one cent at a time until the shares sum to `total` exactly.
  Invariant: Σ share = total, always.
- `splitExact(total, [{id, cents}])`: sum must equal `total` exactly, else 400.
- `balances(expenses, settlements)`: per member, paid − owed, where a settlement counts as
  `from` paid and `to` owed. Sum over all members is always 0.
- `settle(balances)` ("fewest payments"): sort creditors desc, debtors desc; two-pointer greedy,
  each step pays `min(credit, debt)`. At most n−1 transfers. Not guaranteed globally minimal (that
  is NP-hard); stated as a tradeoff. Debts are netted across everyone, so a member may pay someone
  who never paid for them.
- `settleDirect(expenses)` ("pay who paid for you"): for every expense and every split whose
  member ≠ payer, `debt[member→payer] += share`. Then for each unordered pair, net the two
  directions (`a→b − b→a`) and emit one transfer for the positive side. Sorted by amount desc, ties
  by member order. More transfers than `settle`, but every transfer goes to someone who actually
  paid for you. Its total is usually larger than `settle`'s (debts are only netted per pair, not
  across everyone), but both plans zero every balance.

Remainder cents always go to the first members in **member order** (= insertion order, i.e.
SQLite `rowid` of `members`; never a timestamp, which can tie within a millisecond). Chosen over "give to payer" because it is simpler and predictable.

## API

```
POST   /api/groups                        { name }                         → group
GET    /api/groups/:id                                                     → group + members + expenses(+splits) + balances + settlement
POST   /api/groups/:id/members            { name }                         → member
POST   /api/groups/:id/expenses           ExpenseInput                     → expense
PUT    /api/groups/:id/expenses/:eid      ExpenseInput                     → expense
DELETE /api/groups/:id/expenses/:eid                                       → 204
POST   /api/groups/:id/settlements        { fromId, toId, amount }        → 201 settlement (from ≠ to, both in group)
DELETE /api/groups/:id/settlements/:sid                                   → 204
PATCH  /api/groups/:id/members/:mid       { left: boolean }               → 200 member (sets/clears left_at)
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
  members: { id, name, createdAt, leftAt }[],      // in member order; leftAt null = active
  expenses: { id, description, amountCents, payerId, splitMode, createdAt, updatedAt,
              splits: { memberId, shareCents, inputValue }[] }[],   // newest first
  settlements: { id, fromId, toId, amountCents, createdAt }[],      // newest first
  balances: { memberId, paidCents, owedCents, netCents }[],         // net = paid − owed (expenses + settlements)
  settlement: { fromId, toId, cents }[],                            // fewest payments (greedy)
  settlementDirect: { fromId, toId, cents }[]                       // pay who paid for you
}
```

All calculation lives in the backend; the frontend only renders this payload.
Ids are UUID v4 (`crypto.randomUUID()`), so group URLs are not guessable.
Members cannot be renamed or deleted (deleting one would orphan its splits) — out of scope.

No auth: knowing the group URL is the invite.

## Currency

Added after the first four phases (log: `TODO-multi-currency.md`). `money.ts` is unchanged apart
from an optional `decimals` argument; everything below converts into base before it runs.

**Data model.** Money columns hold integer **minor units**; each currency's `decimals` (in
`server/src/rates.ts`) says how many make one major unit — USD/EUR/… 2, TWD/JPY/KRW/VND/IDR 0.

- `groups.currency`: the base currency, set on create (default `USD`).
- `expenses.currency`, `expenses.original_cents` (amount as paid, in that currency's minor units),
  `expenses.rate_nanos` (locked rate) and `expenses.amount_cents` (converted, in base — what
  splits and balances use). Old rows are backfilled `currency = base, original_cents =
  amount_cents, rate_nanos = 10^9`.
- `group_rates (group_id, currency, rate_nanos > 0, updated_at)`, PK `(group_id, currency)`:
  per-group overrides.
- Splits and settlements are in base.

**Rate convention.** A rate is "base units per 1 unit of the foreign currency", stored as an
integer scaled by 10^9 (`rate_nanos`) and sent over the API as a decimal string with up to 9
decimals (`"0.216129032"`). Never a float. The seeded table has 20 currencies with an approximate
`usdPerUnit`; a seeded pair X → Y is derived through USD. A base-currency expense is always at
exactly 10^9.

**Resolution order** for a new or edited expense: explicit `rate` in the input > group override >
seeded cross rate. The resolved rate is stored on the row and never re-read from the table, so
later overrides do not move existing expenses.

**Conversion.** `base = round_half_up(orig × rate_nanos × 10^(baseDec − origDec) / 10^9)` in
BigInt; the result must be > 0 (`INVALID_AMOUNT` otherwise) and ≤ the max amount.

**Exact mode.** Shares are typed in the expense's currency and must sum to the original amount
there (`EXACT_SUM_MISMATCH`). Each share is converted with the same rate, floored, and the residual
up to `amount_cents` goes one unit at a time by largest remainder (ties → member order), so
Σ share_cents = amount_cents. Equal and percent split `amount_cents` in base as before.

**Base change.** Allowed only while the group has no expenses; otherwise 409 `GROUP_NOT_EMPTY`.
Changing it later would mean re-converting history — out of scope.

**API additions.**

```
POST   /api/groups                        { name, currency? }      → 201 group
PATCH  /api/groups/:id                    { currency }             → 200 group · 409 GROUP_NOT_EMPTY
PUT    /api/groups/:id/rates/:currency    { rate }                 → 200 rates block
DELETE /api/groups/:id/rates/:currency                             → 204 · 404 if no override
```

- `ExpenseInput` gains `currency?` (default base) and `rate?` (default override, then seeded).
  `amount` and exact `shares[].amount` are in `currency`, limited to its `decimals`. A `rate` on a
  base-currency expense → 400 `INVALID_RATE`. Setting an override for the base itself → 400
  `INVALID_RATE`.
- Errors: `UNKNOWN_CURRENCY` (400), `INVALID_RATE` (400), `GROUP_NOT_EMPTY` (409).
- View: each expense adds `currency`, `originalCents`, `rate`; top level adds
  `rates: { base, table: { currency, name, decimals, rate, source: "seed" | "override" }[] }`
  (one row per non-base currency).

**Frontend.** Base select on the create page; currency select + editable rate line + `≈` base total
in the expense sheet; a Converter bottom sheet (from the header's base badge) with the rate table
and overrides; a display-only "show in …" select on the settle card — Mark paid still records base.

## Frontend

One page, mobile-first:

1. Header: group name, member chips, "+ member".
2. Balances card + settle-up list ("A → B $12.34" per line) — most-read, so near the top. The
   settle card has a two-way toggle **Fewest payments / Pay who paid for you** (default: fewest,
   remembered per browser in localStorage); the header shows the payment count for the active mode.
   Each plan row has a **Mark paid** action that records a settlement for exactly that row (confirm
   inline, like delete). Recorded payments are listed in a **Payments** section under expenses,
   each deletable. Balances show active members first, then a **Left** subheading for members with
   `leftAt` (only if any). Member chips: a left member's chip is dimmed and opens an inline
   "Rejoin" action; an active member's chip opens "Mark as left". In the expense sheet, left
   members are not pre-selected and not the default payer, but remain selectable under a "Left"
   divider.
3. Expense list; fixed bottom "+ Add expense" opening a bottom sheet.

Fastest path to log an expense: description + amount + submit (payer defaults to last used,
split defaults to equal across all members). `inputmode="decimal"` on amount.

Routes: `/` create a group (then redirect); `/g/:id` group page. The group URL is the invite link;
the group page has a **Copy link** button (`navigator.share` on phones, clipboard otherwise) and a
**home link** back to `/` (to start another group or pick a recent one).

**Recent groups** (no accounts, so per browser): every successful load of `/g/:id` stores
`{id, name, lastVisited}` in localStorage; `/` lists them above the create form, most recent first,
and drops an entry when the group 404s. Stated limitation: it does not follow the user across devices.

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
