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
- **Rates are stored as an integer scaled by 10^6** (`rate_micros`), never a float.
  Conversion: `base_minor = round(orig_minor × rate_micros / 10^6)`, adjusted for the two
  currencies' decimals. Rounding is half-up to the base currency's minor unit.
- **Seeded table** of ~20 common currencies with decimals (TWD, JPY, KRW 0; most 2) and a fixed
  rate to USD. Cross rates go through USD. Seed values are a starting point, not a live feed.
- **Group overrides** replace the seeded rate for a pair; new expenses default to the override.
- **Settlements stay in base currency.** The converter shows a transfer in another currency for
  display only; what gets recorded is the base amount.
- Out of scope: live rate API, changing the base after expenses exist, per-group rounding mode.

## 1. Server — rates module (`server/src/rates.ts` + `rates.test.ts`)
- [ ] `CURRENCIES`: code, name, decimals, seeded `usdRateMicros`
- [ ] `convert(amountMinor, from, to, rateMicros)` — integer-only, half-up rounding to `to.decimals`
- [ ] `crossRateMicros(from, to, table)` — derived through USD, integer arithmetic
- [ ] `parseAmount` becomes decimals-aware: `"1200"` valid for TWD, `"12.345"` rejected for USD
- [ ] Tests: USD→TWD / TWD→USD round trip within 1 minor unit; JPY (0 decimals) rounding;
      identity rate = 1_000_000 returns the same amount; rate 0 or negative rejected;
      overflow guard on `MAX_AMOUNT`
- Verify: `pnpm test` green; hand-check three conversions against the seeded table

## 2. DB — schema and additive migrations (`server/src/db.ts`)
- [ ] `groups.currency` is now honoured (was hard-coded `'USD'` on insert)
- [ ] `expenses` + `currency TEXT`, `original_cents INTEGER`, `rate_micros INTEGER`
      — migration backfills `currency = group.currency`, `original_cents = amount_cents`,
      `rate_micros = 1_000_000` so every old expense reads as "paid in base at rate 1"
- [ ] new table `group_rates (group_id, currency, rate_micros, updated_at)` — override of the
      rate from `currency` to the group's base; PK `(group_id, currency)`
- Verify: open a copy of `server/data/app.db`, confirm columns and backfilled values, old
  groups return the same balances as before

## 3. Service + API (`service.ts`, `schemas.ts`, `routes.ts`)
- [ ] `POST /api/groups { name, currency? }` — validates against `CURRENCIES`
- [ ] `PATCH /api/groups/:id { currency }` — 409 `GROUP_NOT_EMPTY` once expenses exist
- [ ] `ExpenseInput` + `currency?` (default base) and `rate?` (decimal string; default from
      override, then seeded cross rate). Service converts, stores all three, splits the base amount
- [ ] `PUT /api/groups/:id/rates/:currency { rate }` and `DELETE` to drop the override
- [ ] `GET /api/groups/:id` view adds `rates: { base, table: [{ currency, decimals,
      rateMicros, source: "seed" | "override" }] }` and each expense carries `currency`,
      `originalCents`, `rateMicros`
- [ ] Errors: `UNKNOWN_CURRENCY`, `INVALID_RATE`, `GROUP_NOT_EMPTY`
- [ ] Service tests: expense in TWD on a USD group converts and splits in USD; override changes the
      default rate for new expenses but not existing ones; edit with a new rate re-converts;
      base change rejected when expenses exist
- Verify: `pnpm test` green; curl pass for every new endpoint including each 4xx

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
