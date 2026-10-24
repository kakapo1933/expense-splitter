// Request shapes. zod checks structure and string format only; numeric rules
// (> 0, ≤ max, percent sum, exact sum, duplicates) live in money.ts.
import { z } from "zod";

const DECIMAL_RE = /^\d+(\.\d{1,2})?$/;
const decimalString = z.string().regex(DECIMAL_RE, "expected a decimal string with up to 2 decimals");

export const NameInput = z.object({
  name: z.string().trim().min(1).max(50),
});
export type NameInput = z.infer<typeof NameInput>;

export const ExpenseInput = z.object({
  description: z.string().trim().min(1).max(200),
  amount: decimalString,
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
