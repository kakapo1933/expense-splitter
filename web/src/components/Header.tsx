import { useEffect, useState, type FormEvent } from "react";
import type { GroupView } from "../api";
import { isComposingEnter } from "../keys";
import { formatCents } from "../money";
import type { LiveState } from "../useGroup";
import { Avatar } from "./Avatar";

interface Props {
  view: GroupView;
  live: LiveState;
  onAddMember: (name: string) => Promise<void>;
  /** Increment to open the inline "+ member" field from elsewhere (e.g. the empty state). */
  addSignal?: number;
}

export function Header({ view, live, onAddMember, addSignal = 0 }: Props) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (addSignal > 0) setAdding(true);
  }, [addSignal]);

  const total = view.expenses.reduce((a, e) => a + e.amountCents, 0);
  const n = view.members.length;
  const m = view.expenses.length;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setAdding(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onAddMember(trimmed);
      setName("");
      // keep the field open so several names can be typed in a row
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <header className="app-header">
      <div className="title-row">
        <h1>{view.group.name}</h1>
        <span className={`live ${live === "live" ? "" : "off"}`} role="status">
          {live === "live" ? "live" : live === "connecting" ? "connecting…" : "reconnecting…"}
        </span>
      </div>
      <div className="sub">
        {n} {n === 1 ? "member" : "members"} · {m} {m === 1 ? "expense" : "expenses"} · {formatCents(total)} total
      </div>
      <div className="chips">
        {view.members.map((mem, i) => (
          <span className="chip" key={mem.id}>
            <Avatar name={mem.name} index={i} size={18} />
            {mem.name}
          </span>
        ))}
        {adding ? (
          <form className="chip-form" onSubmit={submit}>
            <input
              className="chip-input"
              autoFocus
              placeholder="Name"
              maxLength={50}
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                if (!name.trim()) setAdding(false);
              }}
              onKeyDown={(e) => {
                // Enter inside the form submits implicitly; swallow the IME-confirm Enter.
                if (isComposingEnter(e)) {
                  e.preventDefault();
                  return;
                }
                if (e.key === "Escape") {
                  setName("");
                  setAdding(false);
                }
              }}
              aria-label="New member name"
            />
            <button type="submit" className="chip-ok" disabled={busy || !name.trim()} aria-label="Add member">
              ✓
            </button>
          </form>
        ) : (
          <button type="button" className="chip add" onClick={() => setAdding(true)}>
            + member
          </button>
        )}
      </div>
      {error && (
        <div className="hint warn" role="alert">
          {error}
        </div>
      )}
    </header>
  );
}
