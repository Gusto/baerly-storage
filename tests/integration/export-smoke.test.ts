import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "pg";
import { merge } from "@baerly/protocol";
import { POSTGRES_HOST_PORT } from "../setup/ports.ts";

/**
 * Local JSON value types — the test deliberately does NOT import
 * `JSONValue` / `DocumentData` from `@baerly/protocol`. The
 * point of the smoke test is to simulate an external consumer of
 * the frozen `LogEntry` contract, so any drift in the protocol
 * package shows up as a TS compile error here. Trimmed to the
 * subset the fixtures need.
 */
type JSONValue = string | number | boolean | null | JSONValue[] | { [k: string]: JSONValue };
type DocumentData = {
  [k: string]: string | number | boolean | DocumentData;
};

/**
 * RFC 7386 merge-patch bodies use `null` as a delete sentinel. The
 * `LogEntry.patch` is typed as `DocumentData` (no
 * nulls allowed inside doc bodies), but a *patch* body legitimately
 * uses nulls to remove fields. Widen the local `patch` type to
 * allow nulls so fixture #4 ("null deletes nested field") is legal
 * TypeScript without `as any`. This widening is deliberate and
 * matches RFC 7386 — see `docs/spec/json-merge-patch.md`.
 */
type JSONMergePatchObject = {
  [k: string]: string | number | boolean | null | JSONMergePatchObject;
};

/**
 * Local copy — kept in sync with `packages/protocol/src/log.ts`; do
 * NOT import. The test is an external consumer of the frozen
 * contract; any drift in `@baerly/protocol` should fail TypeScript
 * here. See ticket 07 §2.
 */
interface LogEntry {
  lsn: string;
  commit_ts: string;
  op: "I" | "U" | "D" | "T" | "M";
  collection: string;
  doc_id?: string;
  schema_version: number;
  new?: DocumentData;
  patch?: JSONMergePatchObject;
  old?: DocumentData;
  key_old?: { readonly [pk: string]: JSONValue };
  origin?: string;
  session: string;
  seq: number;
}

/**
 * Postgres connection for the smoke test. Single source of truth —
 * any tweak (port, db name, creds) here must match the `postgres`
 * service in `docker-compose.yml`. Host port 5433 to avoid clashing
 * with a local dev Postgres on 5432.
 */
const PG_CONFIG = {
  host: "127.0.0.1",
  port: POSTGRES_HOST_PORT,
  user: "baerly",
  password: "baerly-local",
  database: "baerly_export_smoke",
};

/**
 * Translate a single `LogEntry` into SQL against a hard-coded
 * `users (id text PRIMARY KEY, doc jsonb)` table.
 *
 * Translation rules (kept inline — this is NOT the production
 * exporter, which lands later):
 *
 * - `I` → `INSERT … ON CONFLICT (id) DO UPDATE` (idempotent
 *   replay).
 * - `U` → read current `doc`, apply RFC 7386 `merge()` in JS,
 *   write back (or `DELETE` if the merge collapses to
 *   `undefined`).
 * - `D` → `DELETE FROM users WHERE id = $1`.
 * - `T` / `M` → throw (today's emitter doesn't produce them).
 *
 * The translator orders by ascending `seq`; the `lsn` is treated
 * as opaque (it sorts lex-DESC in production, which is why we
 * can't use it directly).
 */
async function applyEntry(client: Client, entry: LogEntry): Promise<void> {
  if (entry.op === "I") {
    if (!entry.doc_id || !entry.new) {
      throw new Error("I requires doc_id+new");
    }
    await client.query(
      "INSERT INTO users (id, doc) VALUES ($1, $2) " +
        "ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc",
      [entry.doc_id, entry.new],
    );
    return;
  }
  if (entry.op === "U") {
    if (!entry.doc_id || !entry.patch) {
      throw new Error("U requires doc_id+patch");
    }
    const prior = await client.query<{ doc: object | null }>(
      "SELECT doc FROM users WHERE id = $1",
      [entry.doc_id],
    );
    const priorDoc = prior.rows[0]?.doc ?? undefined;
    const next = merge(priorDoc as never, entry.patch as never);
    if (next === undefined) {
      await client.query("DELETE FROM users WHERE id = $1", [entry.doc_id]);
    } else {
      await client.query(
        "INSERT INTO users (id, doc) VALUES ($1, $2) " +
          "ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc",
        [entry.doc_id, next],
      );
    }
    return;
  }
  if (entry.op === "D") {
    if (!entry.doc_id) {
      throw new Error("D requires doc_id");
    }
    await client.query("DELETE FROM users WHERE id = $1", [entry.doc_id]);
    return;
  }
  throw new Error(`unsupported op: ${entry.op}`);
}

/**
 * Representative log entries covering every code path today's
 * emitter exercises:
 *
 *   - scalar insert / nested insert
 *   - merge-patch scalar change
 *   - merge-patch null-deletes-nested-field (RFC 7386)
 *   - per-doc-replace (today's default emit mode)
 *   - delete of an existing row
 *   - tombstone-revive (D then I at same doc_id)
 *   - multi-step merge convergence on the same doc
 *   - SQL-injection canaries in body strings
 *   - I → D → I cycle at same doc_id
 *
 * All entries share `collection: "users"` and `session:
 * "smoke-sess"`. `seq` is dense 0..N-1; `lsn` is synthetic —
 * lex-ASC in `seq` order — and is NOT parsed by the translator
 * (translator sorts by `seq`). 4 distinct doc_ids:
 * `users/{u_a, u_b, u_c, u_d}`.
 */
const FIXTURES: LogEntry[] = [
  // I — scalar insert
  {
    lsn: "lsn-00",
    commit_ts: "2026-01-01T00:00:00.000Z",
    op: "I",
    collection: "users",
    doc_id: "users/u_a",
    schema_version: 0,
    new: { name: "Ada", email: "ada@x", age: 36 },
    patch: { name: "Ada", email: "ada@x", age: 36 },
    session: "smoke-sess",
    seq: 0,
  },
  // I — nested-object insert
  {
    lsn: "lsn-01",
    commit_ts: "2026-01-01T00:00:01.000Z",
    op: "I",
    collection: "users",
    doc_id: "users/u_b",
    schema_version: 0,
    new: { name: "Bo", profile: { city: "PDX", title: "engineer" } },
    patch: { name: "Bo", profile: { city: "PDX", title: "engineer" } },
    session: "smoke-sess",
    seq: 1,
  },
  // U — merge-patch, single scalar change
  {
    lsn: "lsn-02",
    commit_ts: "2026-01-01T00:00:02.000Z",
    op: "U",
    collection: "users",
    doc_id: "users/u_a",
    schema_version: 0,
    new: { name: "Ada", email: "ada@x", age: 37 },
    patch: { age: 37 },
    session: "smoke-sess",
    seq: 2,
  },
  // U — null deletes nested field. RFC 7386 delete-sentinel —
  // translator must DROP `profile.title`, not store SQL NULL.
  {
    lsn: "lsn-03",
    commit_ts: "2026-01-01T00:00:03.000Z",
    op: "U",
    collection: "users",
    doc_id: "users/u_b",
    schema_version: 0,
    new: { name: "Bo", profile: { city: "PDX" } },
    patch: { profile: { title: null } },
    session: "smoke-sess",
    seq: 3,
  },
  // U — per-doc-replace (today's default emit mode). patch == new;
  // `age` survives because patch doesn't null it.
  {
    lsn: "lsn-04",
    commit_ts: "2026-01-01T00:00:04.000Z",
    op: "U",
    collection: "users",
    doc_id: "users/u_a",
    schema_version: 0,
    new: { name: "Ada Lovelace", email: "ada@x" },
    patch: { name: "Ada Lovelace", email: "ada@x" },
    session: "smoke-sess",
    seq: 4,
  },
  // D — delete an existing row (and start of tombstone-revive)
  {
    lsn: "lsn-05",
    commit_ts: "2026-01-01T00:00:05.000Z",
    op: "D",
    collection: "users",
    doc_id: "users/u_a",
    schema_version: 0,
    session: "smoke-sess",
    seq: 5,
  },
  // I — tombstone-revive of users/u_a after the previous D
  {
    lsn: "lsn-06",
    commit_ts: "2026-01-01T00:00:06.000Z",
    op: "I",
    collection: "users",
    doc_id: "users/u_a",
    schema_version: 0,
    new: { name: "Ada Reborn", reborn: true },
    patch: { name: "Ada Reborn", reborn: true },
    session: "smoke-sess",
    seq: 6,
  },
  // U — extend profile with a new nested key (country)
  {
    lsn: "lsn-07",
    commit_ts: "2026-01-01T00:00:07.000Z",
    op: "U",
    collection: "users",
    doc_id: "users/u_b",
    schema_version: 0,
    new: { name: "Bo", profile: { city: "PDX", country: "US" } },
    patch: { profile: { country: "US" } },
    session: "smoke-sess",
    seq: 7,
  },
  // U — overwrite nested city. Final profile:
  // { country: "US", city: "SEA" }.
  {
    lsn: "lsn-08",
    commit_ts: "2026-01-01T00:00:08.000Z",
    op: "U",
    collection: "users",
    doc_id: "users/u_b",
    schema_version: 0,
    new: { name: "Bo", profile: { city: "SEA", country: "US" } },
    patch: { profile: { city: "SEA" } },
    session: "smoke-sess",
    seq: 8,
  },
  // I — reserved SQL chars in body. Canary that `pg` binds via
  // $1/$2, no string interpolation. The body strings would
  // truncate or drop the table if naively interpolated.
  {
    lsn: "lsn-09",
    commit_ts: "2026-01-01T00:00:09.000Z",
    op: "I",
    collection: "users",
    doc_id: "users/u_c",
    schema_version: 0,
    new: {
      name: "O'Brien;\"--\\",
      note: '{"nested":true}; DROP TABLE users; --',
    },
    patch: {
      name: "O'Brien;\"--\\",
      note: '{"nested":true}; DROP TABLE users; --',
    },
    session: "smoke-sess",
    seq: 9,
  },
  // I — first part of I → D → I cycle on u_d
  {
    lsn: "lsn-10",
    commit_ts: "2026-01-01T00:00:10.000Z",
    op: "I",
    collection: "users",
    doc_id: "users/u_d",
    schema_version: 0,
    new: { v: 1 },
    patch: { v: 1 },
    session: "smoke-sess",
    seq: 10,
  },
  // D — middle of I → D → I cycle on u_d
  {
    lsn: "lsn-11",
    commit_ts: "2026-01-01T00:00:11.000Z",
    op: "D",
    collection: "users",
    doc_id: "users/u_d",
    schema_version: 0,
    session: "smoke-sess",
    seq: 11,
  },
  // I — final part of I → D → I cycle on u_d. Final: v: 3.
  {
    lsn: "lsn-12",
    commit_ts: "2026-01-01T00:00:12.000Z",
    op: "I",
    collection: "users",
    doc_id: "users/u_d",
    schema_version: 0,
    new: { v: 3 },
    patch: { v: 3 },
    session: "smoke-sess",
    seq: 12,
  },
];

const smokeEnabled = process.env["EXPORT_SMOKE"] === "1";

describe.runIf(smokeEnabled)("LogEntry → Postgres round-trip", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client(PG_CONFIG);
    await client.connect();
    await client.query("DROP TABLE IF EXISTS users");
    await client.query("CREATE TABLE users (id text PRIMARY KEY, doc jsonb NOT NULL)");
  });

  afterAll(async () => {
    await client.end();
  });

  test("replays representative entries and round-trips", async () => {
    const ordered = FIXTURES.toSorted((a, b) => a.seq - b.seq);
    for (const entry of ordered) {
      await applyEntry(client, entry);
    }

    // Build the expected end state by replaying the same
    // fixtures through `merge()` in memory — never pre-compute.
    const expected = new Map<string, unknown>();
    for (const entry of ordered) {
      if (entry.op === "I" || entry.op === "U") {
        if (!entry.doc_id) {
          continue;
        }
        const prior = expected.get(entry.doc_id);
        const next = merge(prior as never, (entry.patch ?? entry.new) as never);
        if (next === undefined) {
          expected.delete(entry.doc_id);
        } else {
          expected.set(entry.doc_id, next);
        }
      } else if (entry.op === "D" && entry.doc_id) {
        expected.delete(entry.doc_id);
      }
    }

    const actual = new Map<string, unknown>();
    const result = await client.query<{ id: string; doc: unknown }>("SELECT id, doc FROM users");
    for (const row of result.rows) {
      actual.set(row.id, row.doc);
    }

    expect(actual.size).toBe(expected.size);
    for (const [id, expectedDoc] of expected) {
      expect(actual.get(id)).toEqual(expectedDoc);
    }
  });
});
