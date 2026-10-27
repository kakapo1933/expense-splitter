// Request shapes. zod checks structure and string format only; numeric rules
// (> 0, ≤ max, percent sum, exact sum, duplicates) live in money.ts.
import { z } from "zod";

// Up to 9 decimals here; the real limit is the currency's `decimals` and is enforced by
// parseAmount(s, decimals) in the service (TWD "12.5" → INVALID_AMOUNT there, not here).
const DECIMAL_RE = /^\d+(\.\d{1,9})?$/;
const decimalString = z.string().regex(DECIMAL_RE, "expected a decimal string with up to 9 decimals");
const CURRENCY_RE = /^[A-Z]{3}$/;
const currencyCode = z.string().regex(CURRENCY_RE, "expected a 3-letter uppercase currency code");
const RATE_RE = /^\d+(\.\d{1,9})?$/;
const rateString = z.string().regex(RATE_RE, "expected a decimal string with up to 9 decimals");

export const NameInput = z.object({
  name: z.string().trim().min(1).max(50),
});
export type NameInput = z.infer<typeof NameInput>;

/** Group creation: base currency optional (default USD); existence is checked in the service. */
export const GroupInput = z.object({
  name: z.string().trim().min(1).max(50),
  currency: currencyCode.optional(),
});
export type GroupInput = z.infer<typeof GroupInput>;

export const GroupPatch = z.object({
  currency: currencyCode,
});
export type GroupPatch = z.infer<typeof GroupPatch>;

/** Override of the rate from a currency to the group's base: base units per 1 unit. */
export const RateInput = z.object({
  rate: rateString,
});
export type RateInput = z.infer<typeof RateInput>;

export const ExpenseInput = z.object({
  description: z.string().trim().min(1).max(200),
  amount: decimalString,
  /** Currency as paid; default = group base. Exact shares are typed in this currency too. */
  currency: currencyCode.optional(),
  /** Base units per 1 unit of `currency`; default = group override, then seeded cross rate. */
  rate: rateString.optional(),
  payerId: z.string().min(1),
  split: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("equal"), memberIds: z.array(z.string().min(1)) }),
    z.object({
      mode: z.literal("exact"),
      shares: z.array(z.object({ memberId: z.string().min(1), amount: decimalString })),
    }),
    z.object({
      mode: z.literal("percent"),
      shares: z.array(z.object({ memberId: z.string().min(1), percent: decimalString })),
    }),
  ]),
});
export type ExpenseInput = z.infer<typeof ExpenseInput>;

/** "Mark paid": a payment from one member to another. from ≠ to is checked in the service. */
export const SettlementInput = z.object({
  fromId: z.string().min(1),
  toId: z.string().min(1),
  amount: decimalString,
});
export type SettlementInput = z.infer<typeof SettlementInput>;

/** Member leaving (left: true sets left_at) or rejoining (left: false clears it). */
export const MemberPatch = z.object({
  left: z.boolean(),
});
export type MemberPatch = z.infer<typeof MemberPatch>;
