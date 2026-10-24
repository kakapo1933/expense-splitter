// SQLite via Node's built-in `node:sqlite` (DatabaseSync). No native deps.
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

// Resolved from this file, not from cwd: src/db.ts and dist/db.js both map to server/data/app.db.
const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB_PATH = resolve(here, "../data/app.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  currency   TEXT NOT NULL DEFAULT 'USD',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  left_at    TEXT,             -- set when the member leaves mid-trip; NULL = active (see migrate())
  UNIQUE (group_id, name)
);
CREATE INDEX IF NOT EXISTS members_group_idx ON members(group_id);

CREATE TABLE IF NOT EXISTS expenses (
  id           TEXT PRIMARY KEY,
  group_id     TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  payer_id     TEXT NOT NULL REFERENCES members(id),
  description  TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  split_mode   TEXT NOT NULL CHECK (split_mode IN ('equal', 'exact', 'percent')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS expenses_group_idx ON expenses(group_id);

CREATE TABLE IF NOT EXISTS expense_splits (
  expense_id  TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  member_id   TEXT NOT NULL REFERENCES members(id),
  share_cents INTEGER NOT NULL CHECK (share_cents >= 0),
  input_value TEXT,            -- percent / exact amount as typed; NULL for equal mode
  PRIMARY KEY (expense_id, member_id)
);

CREATE TABLE IF NOT EXISTS settlements (
  id           TEXT PRIMARY KEY,
  group_id     TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  from_id      TEXT NOT NULL REFERENCES members(id),
  to_id        TEXT NOT NULL REFERENCES members(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS settlements_group_idx ON settlements(group_id);
`;

/**
 * Additive migrations for databases created before a column existed. SQLite has no
 * ADD COLUMN IF NOT EXISTS, so check PRAGMA table_info first. Existing rows keep their data;
 * the new column is NULL for them.
 */
const COLUMN_MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  { table: "members", column: "left_at", ddl: "ALTER TABLE members ADD COLUMN left_at TEXT" },
];

function migrate(db: DatabaseSync): void {
  for (const m of COLUMN_MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${m.table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === m.column)) db.exec(m.ddl);
  }
}

/** Open (or create) the database and ensure the schema exists. Pass ":memory:" in tests. */
export function openDb(path: string = process.env.DB_PATH ?? DEFAULT_DB_PATH): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Run `fn` inside a transaction; rolls back on throw. node:sqlite has no built-in helper. */
export function withTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
