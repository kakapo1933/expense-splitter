// Recorded settlements ("mark paid"), newest first. Hidden when there are none. Each row can be
// deleted (mis-tap) after an inline confirm, same pattern as ExpenseList.
import { useState } from "react";
import type { GroupView, Settlement } from "../api";
import { formatMoney } from "../money";
import { Avatar } from "./Avatar";

interface Props {
  view: GroupView;
  onDelete: (s: Settlement) => Promise<void>;
}

function dateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function PaymentsList({ view, onDelete }: Props) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idx = new Map(view.members.map((m, i) => [m.id, i]));
  const name = (id: string) => view.members[idx.get(id) ?? -1]?.name ?? "?";

  if (view.settlements.length === 0) return null;

  async function del(s: Settlement) {
    setBusyId(s.id);
    setError(null);
    try {
      await onDelete(s);
      setConfirmId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="card payments" aria-labelledby="pay-h">
      <div className="card-h">
        <h2 id="pay-h">Payments</h2>
        <span className="meta">recorded as paid · newest first</span>
      </div>
      {view.settlements.map((s) => (
        <div className="row" key={s.id}>
          {confirmId === s.id ? (
            <div className="confirm-row">
              <span>
                Delete payment {name(s.fromId)} → {name(s.toId)} {formatMoney(s.amountCents, view.group.currency)}?
              </span>
              <span className="confirm-actions">
                <button type="button" className="danger" disabled={busyId === s.id} onClick={() => void del(s)}>
                  Delete
                </button>
                <button type="button" className="keep" onClick={() => setConfirmId(null)}>
                  Keep
                </button>
              </span>
            </div>
          ) : (
            <>
              <div className="flow">
                <span className="who">
                  <Avatar name={name(s.fromId)} index={idx.get(s.fromId) ?? 0} size={22} />
                  <span className="name">{name(s.fromId)}</span>
                </span>
                <span className="arrow" aria-label="paid">
                  →
                </span>
                <span className="who">
                  <Avatar name={name(s.toId)} index={idx.get(s.toId) ?? 0} size={22} />
                  <span className="name">{name(s.toId)}</span>
                </span>
                <span className="meta">· {dateLabel(s.createdAt)}</span>
              </div>
              <span className="amt">{formatMoney(s.amountCents, view.group.currency)}</span>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Delete payment ${name(s.fromId)} to ${name(s.toId)} ${formatMoney(s.amountCents, view.group.currency)}`}
                onClick={() => setConfirmId(s.id)}
              >
                ×
              </button>
            </>
          )}
        </div>
      ))}
      {error && (
        <div className="hint warn" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
