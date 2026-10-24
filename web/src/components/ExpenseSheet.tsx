// Add / edit bottom sheet. Fast path: description → amount → Save (payer = last used, split =
// equal across everyone). Split previews are computed client-side with the server's integer rules
// for display only; the saved result is whatever the server returns.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Expense, ExpenseInput, Member, SplitMode } from "../api";
import { isComposingEnter } from "../keys";
import {
  centsToDecimal,
  formatCents,
  parseBasisPoints,
  parseCents,
  PERCENT_TOLERANCE_BP,
  previewEqual,
  previewPercent,
} from "../money";
import { Avatar } from "./Avatar";

interface Props {
  groupId: string;
  members: Member[];
  /** undefined → add mode */
  expense?: Expense;
  onSave: (input: ExpenseInput) => Promise<void>;
  onDelete?: () => Promise<void>;
  onClose: () => void;
}

const lastPayerKey = (groupId: string) => `expense-splitter:lastPayer:${groupId}`;

export function readLastPayer(groupId: string): string | null {
  try {
    return localStorage.getItem(lastPayerKey(groupId));
  } catch {
    return null;
  }
}

function writeLastPayer(groupId: string, payerId: string) {
  try {
    localStorage.setItem(lastPayerKey(groupId), payerId);
  } catch {
    /* private mode etc. — the default is a convenience only */
  }
}

type Inputs = Record<string, string>;

function initialState(members: Member[], groupId: string, expense?: Expense) {
  const ids = members.map((m) => m.id);
  const last = readLastPayer(groupId);
  const inputs = (mode: SplitMode): Inputs => {
    const out: Inputs = {};
    if (expense?.splitMode === mode) for (const s of expense.splits) out[s.memberId] = s.inputValue ?? "";
    return out;
  };
  return {
    description: expense?.description ?? "",
    amount: expense ? centsToDecimal(expense.amountCents) : "",
    payerId: expense?.payerId ?? (last && ids.includes(last) ? last : ids[0] ?? ""),
    mode: expense?.splitMode ?? ("equal" as SplitMode),
    equalIds: new Set(expense?.splitMode === "equal" ? expense.splits.map((s) => s.memberId) : ids),
    exact: inputs("exact"),
    percent: inputs("percent"),
  };
}

export function ExpenseSheet({ groupId, members, expense, onSave, onDelete, onClose }: Props) {
  const init = useMemo(() => initialState(members, groupId, expense), [members, groupId, expense]);
  const [description, setDescription] = useState(init.description);
  const [amount, setAmount] = useState(init.amount);
  const [payerId, setPayerId] = useState(init.payerId);
  const [mode, setMode] = useState<SplitMode>(init.mode);
  const [equalIds, setEqualIds] = useState<Set<string>>(init.equalIds);
  const [exact, setExact] = useState<Inputs>(init.exact);
  const [percent, setPercent] = useState<Inputs>(init.percent);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lock background scroll while the sheet is open; Escape closes.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const cents = parseCents(amount);
  const amountTouched = amount.trim() !== "";
  const amountError = amountTouched && cents === null ? "Enter an amount like 12.50 (digits, up to 2 decimals)" : amountTouched && cents === 0 ? "Amount must be more than $0.00" : null;
  const payer = members.find((m) => m.id === payerId);
  const idx = (id: string) => members.findIndex((m) => m.id === id);

  // ---- split previews (display only) ----
  const equalMembers = members.filter((m) => equalIds.has(m.id)); // member order, as the server sorts
  const equalShares = cents !== null ? previewEqual(cents, equalMembers.map((m) => m.id)) : [];
  const equalRemainder = cents !== null && equalMembers.length ? cents % equalMembers.length : 0;

  const exactParsed = members.map((m) => ({ m, cents: (exact[m.id] ?? "").trim() === "" ? 0 : parseCents(exact[m.id] ?? "") }));
  const exactInvalid = exactParsed.some((r) => r.cents === null);
  const exactSum = exactParsed.reduce((a, r) => a + (r.cents ?? 0), 0);
  const exactDiff = cents !== null ? cents - exactSum : null;

  const pctParsed = members.map((m) => ({ m, bp: (percent[m.id] ?? "").trim() === "" ? 0 : parseBasisPoints(percent[m.id] ?? "") }));
  const pctInvalid = pctParsed.some((r) => r.bp === null);
  const pctSum = pctParsed.reduce((a, r) => a + (r.bp ?? 0), 0);
  const pctOk = !pctInvalid && Math.abs(pctSum - 10000) <= PERCENT_TOLERANCE_BP;
  const pctShares =
    cents !== null && !pctInvalid ? previewPercent(cents, pctParsed.map((r) => ({ memberId: r.m.id, bp: r.bp ?? 0 }))) : [];
  const pctFloorSum = cents !== null ? pctParsed.reduce((a, r) => a + Math.floor((cents * (r.bp ?? 0)) / 10000), 0) : 0;
  const pctResidual = cents !== null ? cents - pctFloorSum : 0;

  const splitValid =
    mode === "equal" ? equalMembers.length > 0 : mode === "exact" ? !exactInvalid && exactDiff === 0 : pctOk;
  const canSave =
    !busy && description.trim().length > 0 && cents !== null && cents > 0 && Boolean(payer) && splitValid;

  function buildInput(): ExpenseInput {
    const split: ExpenseInput["split"] =
      mode === "equal"
        ? { mode, memberIds: equalMembers.map((m) => m.id) }
        : mode === "exact"
          ? {
              mode,
              shares: exactParsed
                .filter((r) => (r.cents ?? 0) > 0 || (exact[r.m.id] ?? "").trim() !== "")
                .map((r) => ({ memberId: r.m.id, amount: (exact[r.m.id] ?? "").trim() || "0" })),
            }
          : {
              mode,
              shares: pctParsed
                .filter((r) => (r.bp ?? 0) > 0 || (percent[r.m.id] ?? "").trim() !== "")
                .map((r) => ({ memberId: r.m.id, percent: (percent[r.m.id] ?? "").trim() || "0" })),
            };
    return { description: description.trim(), amount: amount.trim(), payerId, split };
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(buildInput());
      writeLastPayer(groupId, payerId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err)); // server 400 lands here
    } finally {
      setBusy(false);
    }
  }

  async function del() {
    if (!onDelete) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const toggleEqual = (id: string) =>
    setEqualIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="sheet-root" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <div className="dim" onClick={onClose} />
      <form className="sheet" onSubmit={submit} noValidate>
        <div className="handle" />
        <div className="sheet-h">
          <h3 id="sheet-title">{expense ? "Edit expense" : "Add expense"}</h3>
          {expense && onDelete && !confirmDelete && (
            <button type="button" className="danger" onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
          )}
        </div>

        <div className="field">
          <label htmlFor="f-desc">Description</label>
          <input
            id="f-desc"
            className="input"
            autoFocus={!expense}
            placeholder="Dinner, taxi, tickets…"
            maxLength={200}
            enterKeyHint="next"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (isComposingEnter(e)) return;
              if (e.key === "Enter") {
                e.preventDefault();
                document.getElementById("f-amount")?.focus();
              }
            }}
          />
        </div>

        <div className="field">
          <label htmlFor="f-amount">Amount (USD)</label>
          <div className={`input amount ${amountError ? "invalid" : ""}`}>
            <span className="cur">$</span>
            <input
              id="f-amount"
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              enterKeyHint="done"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-invalid={Boolean(amountError)}
            />
          </div>
          {amountError && <div className="hint warn">{amountError}</div>}
        </div>

        <div className="field">
          <label>Paid by</label>
          <div className="chips" role="radiogroup" aria-label="Paid by">
            {members.map((m, i) => (
              <button
                type="button"
                role="radio"
                aria-checked={m.id === payerId}
                className={`chip ${m.id === payerId ? "on" : ""}`}
                key={m.id}
                onClick={() => setPayerId(m.id)}
              >
                <Avatar name={m.name} index={i} size={18} />
                {m.name}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>Split</label>
          <div className="seg" role="tablist" aria-label="Split mode">
            {(["equal", "exact", "percent"] as SplitMode[]).map((m) => (
              <button
                type="button"
                role="tab"
                aria-selected={mode === m}
                className={mode === m ? "on" : ""}
                key={m}
                onClick={() => setMode(m)}
              >
                {m === "equal" ? "Equally" : m === "exact" ? "Exact" : "Percent"}
              </button>
            ))}
          </div>

          {mode === "equal" && (
            <>
              <div className="chips mt" role="group" aria-label="Split between">
                {members.map((m, i) => (
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={equalIds.has(m.id)}
                    className={`chip ${equalIds.has(m.id) ? "on" : ""}`}
                    key={m.id}
                    onClick={() => toggleEqual(m.id)}
                  >
                    <Avatar name={m.name} index={i} size={18} />
                    {m.name}
                  </button>
                ))}
              </div>
              {equalMembers.length === 0 ? (
                <div className="hint warn">Pick at least one person.</div>
              ) : cents !== null && cents > 0 ? (
                <>
                  <div className="preview">
                    {equalShares.map((s) => (
                      <span className="each" key={s.memberId}>
                        {members[idx(s.memberId)]?.name} <b>{formatCents(s.cents)}</b>
                      </span>
                    ))}
                  </div>
                  <div className="hint">
                    {equalRemainder > 0
                      ? `Extra ${equalRemainder}¢ ${equalRemainder === 1 ? "goes" : "go"} to ${equalMembers
                          .slice(0, equalRemainder)
                          .map((m) => m.name)
                          .join(", ")} (first ${equalRemainder === 1 ? "member" : "members"}). `
                      : "Splits evenly, no leftover cents. "}
                    Tap a name to exclude them.
                  </div>
                </>
              ) : (
                <div className="hint">Tap a name to exclude them.</div>
              )}
            </>
          )}

          {mode === "exact" && (
            <>
              <div className="split-rows mt">
                {members.map((m, i) => (
                  <div className="srow" key={m.id}>
                    <label className="nm" htmlFor={`ex-${m.id}`}>
                      <Avatar name={m.name} index={i} size={22} />
                      {m.name}
                    </label>
                    <input
                      id={`ex-${m.id}`}
                      className={`input mini ${exactParsed[i]?.cents === null ? "invalid" : ""}`}
                      type="text"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={exact[m.id] ?? ""}
                      onChange={(e) => setExact({ ...exact, [m.id]: e.target.value })}
                    />
                  </div>
                ))}
              </div>
              {exactInvalid ? (
                <div className="hint warn">Each amount must look like 12.50.</div>
              ) : cents === null ? (
                <div className="hint">Enter the total amount first.</div>
              ) : exactDiff === 0 ? (
                <div className="hint ok">✓ Sums to {formatCents(cents)}</div>
              ) : exactDiff !== null && exactDiff > 0 ? (
                <div className="hint warn">{formatCents(exactDiff)} left to assign</div>
              ) : (
                <div className="hint warn">{formatCents(-(exactDiff ?? 0))} over</div>
              )}
            </>
          )}

          {mode === "percent" && (
            <>
              <div className="split-rows mt">
                {members.map((m, i) => (
                  <div className="srow" key={m.id}>
                    <label className="nm" htmlFor={`pc-${m.id}`}>
                      <Avatar name={m.name} index={i} size={22} />
                      {m.name}
                    </label>
                    <div className={`input mini pct ${pctParsed[i]?.bp === null ? "invalid" : ""}`}>
                      <input
                        id={`pc-${m.id}`}
                        type="text"
                        inputMode="decimal"
                        placeholder="0"
                        value={percent[m.id] ?? ""}
                        onChange={(e) => setPercent({ ...percent, [m.id]: e.target.value })}
                      />
                      <span className="ph">%</span>
                    </div>
                    <span className="res">
                      {cents !== null && !pctInvalid ? formatCents(pctShares[i]?.cents ?? 0) : "—"}
                    </span>
                  </div>
                ))}
              </div>
              {pctInvalid ? (
                <div className="hint warn">Each percent must look like 33.33.</div>
              ) : pctOk ? (
                <div className="hint ok">
                  ✓ {formatPct(pctSum)}%{cents !== null ? ` · shares sum to ${formatCents(cents)}` : ""}
                  {pctResidual !== 0 && cents !== null
                    ? ` · ${pctResidual > 0 ? "+" : "−"}${Math.abs(pctResidual)}¢ spread by largest remainder`
                    : ""}
                </div>
              ) : pctSum < 10000 ? (
                <div className="hint warn">{formatPct(10000 - pctSum)}% left · percents must total 100</div>
              ) : (
                <div className="hint warn">{formatPct(pctSum - 10000)}% over · percents must total 100</div>
              )}
            </>
          )}
        </div>

        {confirmDelete && (
          <div className="toggle-row confirm">
            <span>Delete this expense?</span>
            <span className="confirm-actions">
              <button type="button" className="danger" disabled={busy} onClick={() => void del()}>
                Delete
              </button>
              <button type="button" className="keep" onClick={() => setConfirmDelete(false)}>
                Keep
              </button>
            </span>
          </div>
        )}

        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}

        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!canSave}>
            {busy ? "Saving…" : expense ? "Save changes" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

/** 3333 bp → "33.33", 10000 → "100" */
function formatPct(bp: number): string {
  const s = (bp / 100).toFixed(2);
  return s.replace(/\.?0+$/, "");
}
