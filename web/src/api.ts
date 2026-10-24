// Typed client for the server API. Shapes mirror docs/SPEC.md "API"; nothing here computes money.

export type SplitMode = "equal" | "exact" | "percent";

export interface Group {
  id: string;
  name: string;
  currency: string;
  createdAt: string;
}

export interface Member {
  id: string;
  name: string;
  createdAt: string;
}

export interface Split {
  memberId: string;
  shareCents: number;
  /** The percent or exact amount the user typed; null for equal splits. */
  inputValue: string | null;
}

export interface Expense {
  id: string;
  description: string;
  amountCents: number;
  payerId: string;
  splitMode: SplitMode;
  createdAt: string;
  updatedAt: string;
  splits: Split[];
}

export interface Balance {
  memberId: string;
  paidCents: number;
  owedCents: number;
  netCents: number;
}

export interface Transfer {
  fromId: string;
  toId: string;
  cents: number;
}

export interface GroupView {
  group: Group;
  members: Member[];
  expenses: Expense[];
  balances: Balance[];
  settlement: Transfer[];
}

export type SplitInput =
  | { mode: "equal"; memberIds: string[] }
  | { mode: "exact"; shares: { memberId: string; amount: string }[] }
  | { mode: "percent"; shares: { memberId: string; percent: string }[] };

export interface ExpenseInput {
  description: string;
  amount: string;
  payerId: string;
  split: SplitInput;
}

interface ZodIssue {
  path: (string | number)[];
  message: string;
}

/** Any non-2xx response. `message` is safe to show to the user. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function describeBody(status: number, body: unknown): { code: string; message: string } {
  if (typeof body === "object" && body !== null) {
    const b = body as { error?: unknown; message?: unknown; issues?: unknown };
    const code = typeof b.error === "string" ? b.error : `HTTP_${status}`;
    if (typeof b.message === "string") return { code, message: b.message };
    if (Array.isArray(b.issues)) {
      const lines = (b.issues as ZodIssue[]).map((i) =>
        i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message,
      );
      return { code, message: lines.join("; ") || "invalid input" };
    }
    return { code, message: `request failed (${status})` };
  }
  return { code: `HTTP_${status}`, message: `request failed (${status})` };
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (res.status === 204) return undefined as T;
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const { code, message } = describeBody(res.status, body);
    throw new ApiError(res.status, code, message);
  }
  return body as T;
}

const json = (data: unknown) => JSON.stringify(data);

export const api = {
  createGroup: (name: string) => fetchJson<Group>("/api/groups", { method: "POST", body: json({ name }) }),
  getGroup: (id: string) => fetchJson<GroupView>(`/api/groups/${id}`),
  addMember: (groupId: string, name: string) =>
    fetchJson<Member>(`/api/groups/${groupId}/members`, { method: "POST", body: json({ name }) }),
  createExpense: (groupId: string, input: ExpenseInput) =>
    fetchJson<Expense>(`/api/groups/${groupId}/expenses`, { method: "POST", body: json(input) }),
  updateExpense: (groupId: string, expenseId: string, input: ExpenseInput) =>
    fetchJson<Expense>(`/api/groups/${groupId}/expenses/${expenseId}`, { method: "PUT", body: json(input) }),
  deleteExpense: (groupId: string, expenseId: string) =>
    fetchJson<void>(`/api/groups/${groupId}/expenses/${expenseId}`, { method: "DELETE" }),
  eventsUrl: (groupId: string) => `/api/groups/${groupId}/events`,
};
