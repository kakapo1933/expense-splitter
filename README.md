# Group Expense Splitter

A small full-stack app for friends splitting shared costs on a trip. Create a group, add members
by name, log expenses (paid by whom, how much, split equally / by exact amounts / by percentages),
and see each person's balance plus a settle-up plan. Expenses can be edited or deleted; data lives
in SQLite; two browsers on the same group see each other's changes live.

## Run it

Requires Node ≥ 24 and pnpm (`corepack enable` gives you pnpm).

```bash
pnpm install
pnpm dev        # server on :3000, web on :5173 (proxies /api) → open http://localhost:5173
```

```bash
pnpm test       # 31 tests: money logic + service layer on an in-memory DB
pnpm build      # web → web/dist, server → server/dist
pnpm start      # production: one process on :3000 serving the API and the built SPA
```

Environment: `PORT` (default 3000), `DB_PATH` (default `server/data/app.db`, created on first run).

## Stack

| Layer    | Choice                                   | Why                                                                                              |
|----------|------------------------------------------|--------------------------------------------------------------------------------------------------|
| Server   | Node 24 · TypeScript · Hono              | Web-standard `Request`/`Response`, zero deps, typed route params, built-in SSE helper.           |
| Storage  | `node:sqlite` (built into Node ≥ 22)     | Real SQL with transactions and foreign keys, no native build step, one file to back up.          |
| Validate | zod                                      | Shape validation at the edge; money rules live in one pure module (below).                       |
| Web      | Vite · React 19                          | No router or state library — two routes and one data hook were enough.                           |
| Live     | Server-Sent Events                       | One-directional "something changed, refetch" is all the UI needs; simpler than WebSockets.       |

## Design decisions

**All money is integer cents.** Amounts arrive as decimal strings (`"12.34"`), are parsed with
string arithmetic, and never touch a float. The web app only formats cents for display.

**Splitting is one pure module — [`server/src/money.ts`](server/src/money.ts).** No DB, no HTTP,
fully unit-tested, and the only place that knows the rounding rules:

- *Equal*: `floor(total / n)` each; the remaining cents go one each to the first members in
  member order. `$100 / 3 → 33.34, 33.33, 33.33`.
- *Percent*: computed in integer basis points (`33.33% → 3333`), floor each share, then hand out
  the residual by largest remainder. Percents must sum to 100 ± 0.01 (so `33.33 × 3` is accepted);
  because of that tolerance the residual can be several cents or negative on large totals, and the
  distribution loops until shares sum to the total exactly. `$1000 at 33.33 × 3 → 333.34, 333.33, 333.33`.
- *Exact*: shares must sum to the total to the cent, else 400.
- *Settle up*: creditors and debtors sorted by size, two-pointer greedy, each step clears the
  smaller side. At most n − 1 transfers. This is not guaranteed globally minimal (that problem is
  NP-hard); it is the same heuristic the well-known apps use and is predictable for users.

**Balances are derived, never stored.** `balance = Σ paid − Σ share`, recomputed from
`expenses` + `expense_splits` on every read. Editing an expense replaces its row and its splits in
one transaction; deleting cascades. There is no stored total that can drift out of sync.

**Splits store both the result and the input.** `expense_splits.share_cents` is what the member
owes; `input_value` is what the user typed (`"33.33"` percent or `"87.50"` exact). The edit form
round-trips the original intent instead of showing rounded cents.

**Member order is insertion order (`rowid`), not a timestamp.** The remainder cent goes to "the
first member", so that order has to be deterministic; two members created in the same millisecond
would otherwise swap. (Found by a reviewer running the tests on a faster machine.)

**The API returns one view.** `GET /api/groups/:id` carries group, members, expenses with splits,
balances and the settlement plan. The frontend renders it and never computes money itself; the
per-person preview inside the expense sheet is display-only and the saved result comes from the server.

**No accounts.** Knowing the group URL (a UUID v4) is the invite. Fine for a trip with friends;
a non-goal for this exercise.

## API

```
POST   /api/groups                    { name }                → 201 group
GET    /api/groups/:id                                         → view (see above)
POST   /api/groups/:id/members        { name }                → 201 member · 409 if name exists
POST   /api/groups/:id/expenses       ExpenseInput            → 201 expense
PUT    /api/groups/:id/expenses/:eid  ExpenseInput            → 200 expense
DELETE /api/groups/:id/expenses/:eid                           → 204
GET    /api/groups/:id/events         text/event-stream: `hello`, then `changed` after any write
```

```ts
ExpenseInput = {
  description: string;            // 1–200 chars
  amount: string;                 // "12.34", > 0, ≤ 10,000,000.00
  payerId: string;
  split:
    | { mode: "equal";   memberIds: string[] }
    | { mode: "exact";   shares: { memberId: string; amount:  string }[] }
    | { mode: "percent"; shares: { memberId: string; percent: string }[] };
}
```

Errors are `400 { error, message | issues }` (`VALIDATION`, `PERCENT_SUM_MISMATCH`,
`EXACT_SUM_MISMATCH`, `UNKNOWN_MEMBER`, `DUPLICATE_MEMBER`, …), `404`, `409`.

## Frontend

Mobile-first, one page per group. The fastest path to log an expense is description → amount →
Save: payer defaults to the last one used and split defaults to everyone equally, with both
controls visible so the default is also a confirmation (an earlier collapsed "Kai paid · split
equally" summary row tested as too easy to miss). Balances use colour *and* sign (`+$12.34 gets back` / `−$12.34 owes` / `settled`), and the
settle-up card sits above balances because "who pays whom" is the question people open the app for.
The sheet previews each person's share and says where the odd cent goes.

The design was researched before it was built — see [`docs/design/research.md`](docs/design/research.md)
for the conventions borrowed from Splitwise / Tricount / Settle Up and the ones deliberately dropped,
and [`docs/design/mockup.html`](docs/design/mockup.html) for the static mockup the UI follows.

## Project layout

```
server/src/money.ts        pure split / balance / settle logic (+ money.test.ts)
server/src/db.ts           node:sqlite schema, WAL, foreign keys
server/src/service.ts      transactions, group checks, view assembly (+ service.test.ts)
server/src/routes.ts       Hono routes + zod validation + SSE
server/src/events.ts       per-group subscriber set
web/src/useGroup.ts        fetch + EventSource → refetch
web/src/components/        Header · SettleCard · BalancesCard · ExpenseList · ExpenseSheet
docs/SPEC.md               the spec the code was written against
docs/TODO.md               phase-by-phase log with what was verified and what was caught
```

## How it was built

Spec first, then four phases (scaffold → money logic → persistence/API → UI), each implemented in
its own AI-assisted session against the written spec and reviewed by a separate "lead" session
before moving on. That review loop caught two real bugs before the UI existed: the percent residual
under-distributing on large totals, and member order depending on a timestamp. Both are recorded in
[`docs/TODO.md`](docs/TODO.md) with the failing input and the spec change that fixed them.

## What I'd do next

1. **Record settlements.** A `transfer` expense kind so "Mia paid Kai $40.83" clears the balance,
   with a "mark as paid" action on each settle-up row.
2. **Soft delete + audit log** instead of hard delete, so a group can see who changed what.
3. **Multi-currency** per expense with a group base currency; `currency` is already a column.
4. **Optimistic UI** on save (today every write waits for the server and the SSE refetch).
5. **Rate limiting / shareable-link expiry** if this ever left a friends-only context.
