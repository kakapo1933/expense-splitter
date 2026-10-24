// Recent groups, per browser (no accounts). Most recent first, capped at 20.
export interface RecentGroup {
  id: string;
  name: string;
  lastVisited: number; // epoch ms
}

const KEY = "expense-splitter:recentGroups";
const MAX = 20;

export function readRecent(): RecentGroup[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is RecentGroup =>
        typeof r === "object" && r !== null && typeof (r as RecentGroup).id === "string" &&
        typeof (r as RecentGroup).name === "string" && typeof (r as RecentGroup).lastVisited === "number",
    );
  } catch {
    return [];
  }
}

function write(list: RecentGroup[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* private mode / quota — the list is a convenience only */
  }
}

export function recordVisit(id: string, name: string, now = Date.now()) {
  const rest = readRecent().filter((r) => r.id !== id);
  write([{ id, name, lastVisited: now }, ...rest].slice(0, MAX));
}

export function forgetGroup(id: string) {
  const list = readRecent();
  const next = list.filter((r) => r.id !== id);
  if (next.length !== list.length) write(next);
}

/** "today" / "yesterday" / "N days ago", by calendar day in local time. */
export function relativeDay(ts: number, now = Date.now()): string {
  const day = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const diff = Math.round((day(now) - day(ts)) / 86_400_000);
  if (diff <= 0) return "today";
  if (diff === 1) return "yesterday";
  return `${diff} days ago`;
}
