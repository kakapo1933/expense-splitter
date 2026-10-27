// Add / edit bottom sheet. Fast path: description → amount → Save (payer = last used, split =
// equal across everyone). Split previews are computed client-side with the server's integer rules
// for display only; the saved result is whatever the server returns.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Expense, ExpenseInput, Member, Rates, SplitMode } from "../api";
import { isComposingEnter } from "../keys";
import {
  convertPreview,
  decimalsOf,
  formatMoney,
  minorToDecimal,
  parseBasisPoints,
  parseMinor,
  parseRate,
  PERCENT_TOLERANCE_BP,
  previewEqual,
  previewPercent,
} from "../money";
import { Avatar } from "./Avatar";

interface Props {
  groupId: string;
  members: Member[];
  /** The group's base currency and rate table (override first); refreshes via SSE. */
  rates: Rates;
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

const lastCurrencyKey = (groupId: string) => `expense-splitter:lastCurrency:${groupId}`;

export function readLastCurrency(groupId: string): string | null {
  try {
    return localStorage.getItem(lastCurrencyKey(groupId));
  } catch {
    return null;
  }
}

function writeLastCurrency(groupId: string, code: string) {
  try {
    localStorage.setItem(lastCurrencyKey(groupId), code);
  } catch {
    /* convenience only */
  }
}

type Inputs = Record<string, string>;

function initialState(members: Member[], groupId: string, rates: Rates, expense?: Expense) {
  const ids = members.map((m) => m.id);
  // Left members are never a default payer or default participant (SPEC "Leaving is a flag").
  const activeIds = members.filter((m) => !m.leftAt).map((m) => m.id);
  const last = readLastPayer(groupId);
  const inputs = (mode: SplitMode): Inputs => {
    const out: Inputs = {};
    if (expense?.splitMode === mode) for (const s of expense.splits) out[s.memberId] = s.inputValue ?? "";
    return out;
  };
  const lastCur = readLastCurrency(groupId);
  const known = (c: string | null): c is string => c === rates.base || rates.table.some((r) => r.currency === c);
  const currency = expense?.currency ?? (known(lastCur) ? lastCur : rates.base);
  return {
    description: expense?.description ?? "",
    amount: expense ? minorToDecimal(expense.originalCents, decimalsOf(expense.currency)) : "",
    currency,
    // Editing keeps the expense's locked rate; a new expense starts from the table.
    rate: expense ? expense.rate : (rates.table.find((r) => r.currency === currency)?.rate ?? "1"),
    payerId: expense?.payerId ?? (last && activeIds.includes(last) ? last : activeIds[0] ?? ids[0] ?? ""),
    mode: expense?.splitMode ?? ("equal" as SplitMode),
    equalIds: new Set(expense?.splitMode === "equal" ? expense.splits.map((s) => s.memberId) : activeIds),
    exact: inputs("exact"),
    percent: inputs("percent"),
  };
}

export function ExpenseSheet({ groupId, members, rates, expense, onSave, onDelete, onClose }: Props) {
  // Only the first value seeds state, so an SSE refresh never resets what the user typed.
  const init = useMemo(() => initialState(members, groupId, rates, expense), [members, groupId, rates, expense]);
  const [description, setDescription] = useState(init.description);
  const [amount, setAmount] = useState(init.amount);
  const [currency, setCurrency] = useState(init.currency);
  const [rate, setRate] = useState(init.rate);
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

  // Two currencies: the expense's own (`currency`, typed amount and exact shares) and the group's
  // base (`rates.base`, the converted total that equal/percent previews and balances use).
  const base = rates.base;
  const baseDec = decimalsOf(base);
  const isBase = currency === base;
  const dec = decimalsOf(currency);
  const tableRow = rates.table.find((r) => r.currency === currency);
  const rateOk = isBase || parseRate(rate) !== null;
  const orig = parseMinor(amount, dec);
  const cents = orig === null ? null : isBase ? orig : rateOk ? convertPreview(orig, dec, baseDec, rate) : null;
  const amountTouched = amount.trim() !== "";
  const amountError =
    amountTouched && orig === null
      ? dec === 0
        ? `Enter a whole number of ${currency} (no decimals)`
        : `Enter an amount like 12.50 (digits, up to ${dec} decimals)`
      : amountTouched && orig === 0
        ? `Amount must be more than ${formatMoney(0, currency)}`
        : amountTouched && cents === 0
          ? `Converts to ${formatMoney(0, base)} — too small`
          : null;
  const unitWord = (n: number) => (baseDec === 0 ? `${n} ${base}` : `${n}¢`);
  const pickCurrency = (code: string) => {
    setCurrency(code);
    setRate(code === expense?.currency ? expense.rate : (rates.table.find((r) => r.currency === code)?.rate ?? "1"));
  };
  const payer = members.find((m) => m.id === payerId);
  const idx = (id: string) => members.findIndex((m) => m.id === id);
  const activeMembers = members.filter((m) => !m.leftAt);
  const leftMembers = members.filter((m) => m.leftAt);

  // ---- split previews (display only) ----
  const equalMembers = members.filter((m) => equalIds.has(m.id)); // member order, as the server sorts
  const equalShares = cents !== null ? previewEqual(cents, equalMembers.map((m) => m.id)) : [];
  const equalRemainder = cents !== null && equalMembers.length ? cents % equalMembers.length : 0;

  // Exact shares are typed in the expense's own currency; the server converts each one.
  const exactParsed = members.map((m) => ({ m, cents: (exact[m.id] ?? "").trim() === "" ? 0 : parseMinor(exact[m.id] ?? "", dec) }));
  const exactById = new Map(exactParsed.map((r) => [r.m.id, r]));
  const exactInvalid = exactParsed.some((r) => r.cents === null);
  const exactSum = exactParsed.reduce((a, r) => a + (r.cents ?? 0), 0);
  const exactDiff = orig !== null ? orig - exactSum : null;

  const pctParsed = members.map((m) => ({ m, bp: (percent[m.id] ?? "").trim() === "" ? 0 : parseBasisPoints(percent[m.id] ?? "") }));
  const pctById = new Map(pctParsed.map((r) => [r.m.id, r]));
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
    !busy && description.trim().length > 0 && cents !== null && cents > 0 && rateOk && Boolean(payer) && splitValid;

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
    const input: ExpenseInput = { description: description.trim(), amount: amount.trim(), payerId, split };
    // Always send the rate for a foreign expense so an edit keeps its locked rate instead of
    // re-resolving to today's override.
    return isBase ? input : { ...input, currency, rate: rate.trim() };
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(buildInput());
      writeLastPayer(groupId, payerId);
      writeLastCurrency(groupId, currency);
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

  // Renderers shared by the active and "Left" groups. Avatar colour follows the member's index in
  // the full list so it matches the header; a left member's chip is dimmed but still selectable.
  const gone = (m: Member) => (m.leftAt ? "gone" : "");
  const payerChip = (m: Member) => (
    <button
      type="button"
      role="radio"
      aria-checked={m.id === payerId}
      className={`chip ${gone(m)} ${m.id === payerId ? "on" : ""}`}
      key={m.id}
      onClick={() => setPayerId(m.id)}
    >
      <Avatar name={m.name} index={idx(m.id)} size={18} />
      {m.name}
    </button>
  );
  const equalChip = (m: Member) => (
    <button
      type="button"
      role="checkbox"
      aria-checked={equalIds.has(m.id)}
      className={`chip ${gone(m)} ${equalIds.has(m.id) ? "on" : ""}`}
      key={m.id}
      onClick={() => toggleEqual(m.id)}
    >
      <Avatar name={m.name} index={idx(m.id)} size={18} />
      {m.name}
    </button>
  );
  const exactRow = (m: Member) => (
    <div className={`srow ${gone(m)}`} key={m.id}>
      <label className="nm" htmlFor={`ex-${m.id}`}>
        <Avatar name={m.name} index={idx(m.id)} size={22} />
        {m.name}
      </label>
      <input
        id={`ex-${m.id}`}
        className={`input mini ${exactById.get(m.id)?.cents === null ? "invalid" : ""}`}
        type="text"
        inputMode="decimal"
        placeholder={minorToDecimal(0, dec)}
        value={exact[m.id] ?? ""}
        onChange={(e) => setExact({ ...exact, [m.id]: e.target.value })}
      />
    </div>
  );
  const pctShareById = new Map(pctShares.map((sh) => [sh.memberId, sh.cents]));
  const percentRow = (m: Member) => (
    <div className={`srow ${gone(m)}`} key={m.id}>
      <label className="nm" htmlFor={`pc-${m.id}`}>
        <Avatar name={m.name} index={idx(m.id)} size={22} />
        {m.name}
      </label>
      <div className={`input mini pct ${pctById.get(m.id)?.bp === null ? "invalid" : ""}`}>
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
      <span className="res">{cents !== null && !pctInvalid ? formatMoney(pctShareById.get(m.id) ?? 0, base) : "—"}</span>
    </div>
  );

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

        <div className="sheet-body">
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
          <label htmlFor="f-amount">Amount</label>
          <div className={`input amount ${amountError ? "invalid" : ""}`}>
            <select
              className="cur-select"
              aria-label="Currency"
              value={currency}
              onChange={(e) => pickCurrency(e.target.value)}
            >
              <option value={base}>{base}</option>
              {rates.table.map((r) => (
                <option key={r.currency} value={r.currency}>
                  {r.currency}
                </option>
              ))}
            </select>
            <input
              id="f-amount"
              type="text"
              inputMode={dec === 0 ? "numeric" : "decimal"}
              placeholder={minorToDecimal(0, dec)}
              enterKeyHint="done"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-invalid={Boolean(amountError)}
            />
          </div>
          {amountError && <div className="hint warn">{amountError}</div>}
          {!isBase && (
            <div className="rate-line">
              <span>1 {currency} =</span>
              <input
                className={`input mini rate ${rateOk ? "" : "invalid"}`}
                aria-label={`Rate, ${base} per 1 ${currency}`}
                type="text"
                inputMode="decimal"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
              <span>{base}</span>
              {expense && expense.currency === currency && rate === expense.rate ? (
                <span className="tag">locked</span>
              ) : tableRow && rate.trim() === tableRow.rate ? (
                <span className="tag">{tableRow.source}</span>
              ) : (
                <span className="tag">custom</span>
              )}
              {tableRow && rate.trim() !== tableRow.rate && (
                <button type="button" className="linklike" onClick={() => setRate(tableRow.rate)}>
                  reset to {tableRow.rate}
                </button>
              )}
              <b className="conv">{cents !== null ? `≈ ${formatMoney(cents, base)}` : rateOk ? "" : "rate like 0.2161"}</b>
            </div>
          )}
        </div>

        <div className="field">
          <label>Paid by</label>
          <div className="chips" role="radiogroup" aria-label="Paid by">
            {activeMembers.map(payerChip)}
            {leftMembers.length > 0 && <span className="divider">Left</span>}
            {leftMembers.map(payerChip)}
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
                {activeMembers.map(equalChip)}
                {leftMembers.length > 0 && <span className="divider">Left</span>}
                {leftMembers.map(equalChip)}
              </div>
              {equalMembers.length === 0 ? (
                <div className="hint warn">Pick at least one person.</div>
              ) : cents !== null && cents > 0 ? (
                <>
                  <div className="preview">
                    {equalShares.map((s) => (
                      <span className="each" key={s.memberId}>
                        {members[idx(s.memberId)]?.name} <b>{formatMoney(s.cents, base)}</b>
                      </span>
                    ))}
                  </div>
                  <div className="hint">
                    {equalRemainder > 0
                      ? `Extra ${unitWord(equalRemainder)} ${equalRemainder === 1 ? "goes" : "go"} to ${equalMembers
                          .slice(0, equalRemainder)
                          .map((m) => m.name)
                          .join(", ")} (first ${equalRemainder === 1 ? "member" : "members"}). `
                      : "Splits evenly, nothing left over. "}
                    Tap a name to exclude or include them.
                  </div>
                </>
              ) : (
                <div className="hint">Tap a name to exclude or include them.</div>
              )}
            </>
          )}

          {mode === "exact" && (
            <>
              <div className="split-rows mt">
                {activeMembers.map(exactRow)}
                {leftMembers.length > 0 && (
                  <div className="srow divider-row">
                    <span className="divider">Left</span>
                  </div>
                )}
                {leftMembers.map(exactRow)}
              </div>
              {exactInvalid ? (
                <div className="hint warn">
                  Each amount must look like {dec === 0 ? "1200" : "12.50"} ({currency}).
                </div>
              ) : orig === null ? (
                <div className="hint">Enter the total amount first.</div>
              ) : exactDiff === 0 ? (
                <div className="hint ok">✓ Sums to {formatMoney(orig, currency)}</div>
              ) : exactDiff !== null && exactDiff > 0 ? (
                <div className="hint warn">{formatMoney(exactDiff, currency)} left to assign</div>
              ) : (
                <div className="hint warn">{formatMoney(-(exactDiff ?? 0), currency)} over</div>
              )}
            </>
          )}

          {mode === "percent" && (
            <>
              <div className="split-rows mt">
                {activeMembers.map(percentRow)}
                {leftMembers.length > 0 && (
                  <div className="srow divider-row">
                    <span className="divider">Left</span>
                  </div>
                )}
                {leftMembers.map(percentRow)}
              </div>
              {pctInvalid ? (
                <div className="hint warn">Each percent must look like 33.33.</div>
              ) : pctOk ? (
                <div className="hint ok">
                  ✓ {formatPct(pctSum)}%{cents !== null ? ` · shares sum to ${formatMoney(cents, base)}` : ""}
                  {pctResidual !== 0 && cents !== null
                    ? ` · ${pctResidual > 0 ? "+" : "−"}${unitWord(Math.abs(pctResidual))} spread by largest remainder`
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

        </div>

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
