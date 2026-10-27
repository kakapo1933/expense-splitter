# Multi-currency — todo list

Feature: record an expense in any currency, keep balances and settle-up in one group base
currency, ship a seeded rate table that a group can override, and let users convert amounts
in-app (inside the expense sheet and in a standalone converter).

Same working rules as `TODO.md`: each phase is implemented, verified, and ticked here with the
evidence before the next one starts. Nothing in `server/src/money.ts` changes — splitting,
balances and settlement keep running on integer minor units of the base currency.

## Decisions (fixed before coding)

- **One base currency per group.** Set at creation (default USD), editable only while the group
  has no expenses. Balances, settle plan and payments are always in the base currency.
- **Per-expense currency with a locked rate.** An expense stores the original amount and
  currency as paid, the rate used, and the converted base amount. The rate is frozen on the row
  so balances never drift when the table changes; the user may edit the rate on the expense.
- **Rates are stored as an integer scaled by 10^9** (`rate_nanos`), never a float. 10^6 was the
  first draft; KRW→USD (0.00072) would have kept only three significant digits. Conversion:
  `base_minor = round(orig_minor × rate_nanos × 10^(baseDec − origDec) / 10^9)` with BigInt,
  half-up to the base currency's minor unit.
- **Seeded table** of ~20 common currencies with decimals (TWD, JPY, KRW 0; most 2) and a fixed
  rate to USD. Cross rates go through USD. Seed values are a starting point, not a live feed.
- **Group overrides** replace the seeded rate for a pair; new expenses default to the override.
- **Settlements stay in base currency.** The converter shows a transfer in another currency for
  display only; what gets recorded is the base amount.
- Out of scope: live rate API, changing the base after expenses exist, per-group rounding mode.
- **Workflow:** this file is kept by the lead session. Each phase from 2 on runs in its own
  implementation session in this checkout (no worktree, so phases see each other's code), commits
  its own work, and does not edit `docs/`; the lead re-verifies and ticks here.

## 1. Server — rates module (`server/src/rates.ts` + `rates.test.ts`) — lead session
- [x] `CURRENCIES`: 20 codes with name, decimals (JPY/TWD/KRW/VND/IDR 0), seeded `usdPerUnit`
- [x] `convert(amountMinor, from, to, rate)` — BigInt, half-up to `to.decimals`, MAX guard
- [x] `seededRate(from, to)` — derived through USD; identity pair is exactly 10^9
- [x] `parseRate` / `formatRate` — up to 9 decimals, string arithmetic; `CurrencyError`
      (`UNKNOWN_CURRENCY`, `INVALID_RATE`, status 400)
- [x] `parseAmount(s, decimals = 2)` and `splitExact(…, decimals)` in `money.ts`; default keeps
      every existing caller and all 42 old tests unchanged
- [x] 10 tests: parse/format, table sanity, cross rate USD↔TWD / JPY→TWD, identity, $37.44→1208 TWD,
      1200 TWD→$37.20, half-up at 0 and 2 decimals, round trip ≤ 1 TWD, rate ≤ 0 and overflow rejected
- Verify: ✅ commit 1938b3f (amended to exclude an unrelated untracked doc); `pnpm test` 52/52,
  `tsc --noEmit` clean. Caught while writing: a first test expected $10M→TWD to overflow; it is
  only 322M TWD, under the cap — switched to KRW. Also a TDZ bug (regex declared after the table).

## 2. DB — schema and additive migrations (`server/src/db.ts`) — session mc-server
- [x] `groups.currency` honoured on insert (was hard-coded `'USD'`)
- [x] `expenses` + `currency`, `original_cents`, `rate_nanos` via `COLUMN_MIGRATIONS`; idempotent
      SQL backfill `currency = group base, original_cents = amount_cents, rate_nanos = 10^9`
- [x] `group_rates (group_id, currency, rate_nanos > 0, updated_at)`, PK `(group_id, currency)`
- Verify: ✅ in commit e0955b4; migration test opens an old-shape in-memory DB, inserts, migrates,
  checks the backfill. Lead re-ran `pnpm test` 62/62 and `tsc --noEmit` clean.

## 3. Service + API (`service.ts`, `schemas.ts`, `routes.ts`, `errors.ts`, `index.ts`) — session mc-server
- [x] `POST /api/groups { name, currency? }`; `PATCH /api/groups/:id { currency }` → 409
      `GROUP_NOT_EMPTY` once expenses exist
- [x] `ExpenseInput` + `currency?`, `rate?`; rate resolution explicit > override > seeded; a
      base-currency expense cannot carry a rate (`INVALID_RATE`); `amount_cents` = converted base
- [x] Exact shares are typed in the original currency; each converted, residual by largest
      remainder so Σ share == amount_cents
- [x] `PUT /api/groups/:id/rates/:currency { rate }` → rates block; `DELETE` → 204
- [x] View: expenses carry `currency`, `originalCents`, `rate`; `rates: { base, table[19] }`
      with `source: "seed" | "override"`
- [x] Errors `UNKNOWN_CURRENCY`, `INVALID_RATE` (400), `GROUP_NOT_EMPTY` (409) mapped in `index.ts`
- [x] 10 new service tests (62 total)
- Verify: ✅ commit e0955b4. Lead's independent curl pass on a throwaway DB (TWD group):
  JPY 3000 at seeded 0.216129032 → 648 TWD split 324/324; override JPY 0.22 → next JPY 1000 → 220,
  the earlier expense unchanged; exact 1000 + 2000 JPY → 220 + 440 = 660; TWD "12.5" → 400
  `INVALID_AMOUNT`; XXX → 400 `UNKNOWN_CURRENCY`; rate on base → 400 `INVALID_RATE`; PATCH base →
  409; balances +654 / −654 match by hand (Ann paid 1308, owes 654).

## 4. Web
- [ ] `web/src/money.ts`: `formatMoney(minor, currency)` with per-currency decimals and symbol;
      `parseMinor(input, decimals)`; `formatCents` callers migrate to it
- [ ] Create-group page: base currency select
- [ ] Expense sheet: currency select beside amount; when ≠ base, a rate line
      "1 TWD = 0.0312 USD · ≈ $37.44" with an editable rate; preview and shares in base currency
- [ ] Expense list: original amount, with a small base-currency line when they differ
- [ ] Header: base currency badge; opens the **Converter** panel
- [ ] Converter panel: amount + from + to, uses the group's table (override first); a row per
      other currency so "how much is this in X" is one glance; link to edit overrides
- [ ] Settle card: optional "show in …" select, display-only
- Verify (Browser pane, 375 px): create a TWD group → add USD expense at seeded rate → balances in
  TWD → override USD rate → new expense picks it up, old one unchanged → edit old expense's rate →
  converter TWD→JPY matches hand calculation → no horizontal scroll. Screenshots in `docs/evidence/`

## 5. Docs
- [ ] README: design decisions (base currency, locked rate, integer rates), API section, next
      steps (live rates, base change with re-conversion)
- [ ] `SPEC.md` / `SPEC.zh-TW.md`: currency section
- [ ] Tick this file with commits and verification notes
