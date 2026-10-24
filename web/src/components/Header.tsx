import { useEffect, useRef, useState, type FormEvent } from "react";
import type { GroupView } from "../api";
import { isComposingEnter } from "../keys";
import { formatCents } from "../money";
import { navigate } from "../router";
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
  const [copied, setCopied] = useState(false);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const copiedTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (addSignal > 0) setAdding(true);
  }, [addSignal]);

  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  // The group URL is the invite link: native share sheet on phones, clipboard elsewhere,
  // and a selectable URL when neither is available (http over LAN has no clipboard API).
  async function share() {
    const url = location.href;
    setFallbackUrl(null);
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: view.group.name, url });
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return; // user dismissed
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setFallbackUrl(url);
    }
  }

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
      <a
        className="back"
        href="/"
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let the browser open a new tab
          e.preventDefault();
          navigate("/");
        }}
      >
        ‹ Groups
      </a>
      <div className="title-row">
        <h1>{view.group.name}</h1>
        <div className="hdr-right">
          <span className={`live ${live === "live" ? "" : "off"}`} role="status">
            {live === "live" ? "live" : live === "connecting" ? "connecting…" : "reconnecting…"}
          </span>
          <button
            type="button"
            className={`share ${copied ? "done" : ""}`}
            onClick={() => void share()}
            aria-label="Share group link"
            aria-live="polite"
          >
            {copied ? "Link copied" : "Share"}
          </button>
        </div>
      </div>
      {fallbackUrl && (
        <div className="share-fallback">
          Couldn't copy automatically — select the link:
          <input className="input" readOnly value={fallbackUrl} onFocus={(e) => e.currentTarget.select()} />
        </div>
      )}
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
