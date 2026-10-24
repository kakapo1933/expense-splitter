import { useState, type FormEvent } from "react";
import { api } from "../api";
import { navigate } from "../router";

export function CreateGroup() {
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addDraft() {
    const t = draft.trim();
    if (!t) return;
    if (members.some((m) => m.toLowerCase() === t.toLowerCase())) {
      setError(`"${t}" is already in the list`);
      return;
    }
    setMembers([...members, t]);
    setDraft("");
    setError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    const pending = draft.trim();
    const all = pending && !members.includes(pending) ? [...members, pending] : members;
    setBusy(true);
    setError(null);
    try {
      const group = await api.createGroup(trimmed);
      for (const m of all) await api.addMember(group.id, m); // sequential: member order = insertion order
      navigate(`/g/${group.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <main className="center">
      <div className="logo" aria-hidden="true">
        🧾
      </div>
      <h1>Split a trip</h1>
      <p>Name the group, add who's coming. Share the link afterwards — no sign-up.</p>
      <form onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="g-name">Group name</label>
          <input
            id="g-name"
            className="input"
            autoFocus
            maxLength={50}
            placeholder="Tokyo trip"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="g-member">Members</label>
          <div className="member-list">
            {members.map((m, i) => (
              <div className="input between" key={`${m}-${i}`}>
                <span>{m}</span>
                <button
                  type="button"
                  className="x"
                  aria-label={`Remove ${m}`}
                  onClick={() => setMembers(members.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </div>
            ))}
            <input
              id="g-member"
              className="input"
              placeholder="Add a name…"
              maxLength={50}
              enterKeyHint="next"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addDraft();
                }
              }}
              onBlur={addDraft}
            />
          </div>
          <div className="hint">Members can also be added later from the group page.</div>
        </div>
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        <button type="submit" className="btn primary block" disabled={busy || !name.trim()}>
          {busy ? "Creating…" : "Create group"}
        </button>
      </form>
    </main>
  );
}
