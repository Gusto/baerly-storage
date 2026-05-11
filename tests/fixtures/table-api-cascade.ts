/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes (see `@baerly/protocol/src/db.ts`'s `Table<T>` /
   `Query<T>` declarations); the cascade reads / asserts it by name. */

/**
 * Table-API integration cascade — backend-agnostic test driver.
 *
 * One entry point ({@link runTableApiCascade}) exercises every
 * locked verb on the `db.table(...)` and `db.transaction(...)`
 * surface, then walks the emitted `LogEntry`s and asserts the frozen
 * shape declared in `packages/protocol/src/log.ts:22–100`. The
 * driver is consumed by the Node-side variant table
 * (`tests/integration/table-api.test.ts`) and the Workerd mirror
 * (`packages/adapter-cloudflare/src/table-api.test.ts`).
 *
 * Pure module — no Node imports, no `node:fs`, no `node:os`. The
 * Cloudflare Workers pool consumes this file directly inside
 * Workerd; the Node-only variant setup (temp dirs, S3 sign,
 * `aws4fetch`) lives in the call site.
 *
 * @see tests/integration/table-api.test.ts (Node-side variants)
 * @see packages/adapter-cloudflare/src/table-api.test.ts (Workerd variant)
 */

import { expect } from "vitest";
import {
  CURRENT_JSON_SCHEMA_VERSION,
  type CurrentJson,
  type JSONArraylessObject,
  type LogEntry,
  MPS3Error,
  type Storage,
  createCurrentJson,
  uuid,
} from "@baerly/protocol";
import { Db, compact, runGc } from "@baerly/server";

const APP = "table-api-test";

/**
 * UUIDv7 regex — 36 chars with hyphens, version-7 nibble at the
 * start of the third group (position 14 of the string).
 */
const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * LSN shape per `packages/protocol/src/log.ts:24-30`:
 * `<base32-time>_<session>_<seq>` — base-32 alphabet is `[0-9a-v]`,
 * `seq` is the trailing two-character group.
 */
const LSN_RE = /^[0-9a-v]+_[0-9a-v]+_[0-9a-v]{2}$/;

const seedCurrent = (): CurrentJson => ({
  schema_version: CURRENT_JSON_SCHEMA_VERSION,
  snapshot: null,
  next_seq: 0,
  writer_fence: { epoch: 0, owner: "table-api-test", claimed_at: "" },
});

/**
 * Tolerant `createCurrentJson` — when the cross-writer variant
 * passes a `rivalStorage` sharing the same backing store, the rival
 * may have already seeded the key. Adopt the existing seed on
 * Conflict.
 */
const ensureCurrent = async (storage: Storage, key: string): Promise<void> => {
  try {
    await createCurrentJson(storage, key, seedCurrent());
  } catch (err) {
    if (err instanceof MPS3Error && err.code === "Conflict") return;
    throw err;
  }
};

/**
 * Provision `current.json` for every table the cascade touches.
 * `ServerWriter.commit()` throws `InvalidResponse` if the table's
 * `current.json` is missing; the read path returns empty. Mirroring
 * the `transaction.test.ts` pattern, the cascade seeds each table
 * before any insert.
 */
const provision = async (
  storage: Storage,
  app: string,
  tenant: string,
  table: string,
): Promise<void> => {
  await ensureCurrent(storage, `app/${app}/tenant/${tenant}/manifests/${table}/current.json`);
};

const freshTableName = (prefix: string): string => `${prefix}-${uuid().slice(0, 8)}`;

/**
 * Doc shape threaded through the cascade. We type generic verbs as
 * `Table<JSONArraylessObject>` (the default) because the locked
 * `T extends JSONArraylessObject` constraint forbids optional
 * fields under strict-object-mode tsgo — a named interface with
 * `readonly k?: string` is not assignable to
 * `{ [x: string]: JSONArrayless }`. Static doc-shape typing comes
 * back with Phase 9 schema validation; today the table read/write
 * path is dynamically typed.
 */
type Doc = JSONArraylessObject;

/**
 * Predicate `$`-key rejection. The day-one operator policy
 * (`packages/protocol/src/db.ts:101-103` + `packages/protocol/src/query/predicate.ts:50-75`)
 * rejects `$`-prefixed predicate keys with
 * `MPS3Error{code:"InvalidConfig"}`. Rejection is SYNCHRONOUS at
 * `.where(...)` — no `await`, no terminal-time deferral — because
 * the operator-policy boundary is the public contract surface
 * (ticket 12 §Hard constraints: "Runtime rejects $-keys with
 * InvalidConfig, not a later phase.").
 *
 * The error message names the offending `$`-key so downstream
 * tooling can match without parsing prose.
 */
const predicateRejection = (db: Db, table: string): void => {
  const cases: ReadonlyArray<{
    readonly label: string;
    readonly predicate: Record<string, unknown>;
    readonly offender: string;
  }> = [
    { label: "$or at root", predicate: { $or: [{ a: 1 }, { b: 2 }] }, offender: "$or" },
    { label: "$gt at root", predicate: { $gt: 1 }, offender: "$gt" },
    { label: "$in at root", predicate: { $in: ["x"] }, offender: "$in" },
    { label: "$regex at root", predicate: { $regex: "x" }, offender: "$regex" },
    { label: "nested $eq", predicate: { a: { $eq: 1 } }, offender: "$eq" },
  ];

  for (const { label, predicate, offender } of cases) {
    // The cast through `unknown` is intentional — `Predicate<T>` is
    // strongly typed and forbids `$`-keys at compile time. We're
    // testing the runtime guard.
    const p = predicate as unknown as Parameters<typeof db.table>[0] extends string
      ? Parameters<ReturnType<typeof db.table>["where"]>[0]
      : never;
    // SYNCHRONOUS throw — `.where(p)` returns a builder on success,
    // so an absent throw here means the operator-policy contract is
    // unwired. We capture instead of `expect(() => ...).toThrow` so
    // we can assert the MPS3Error shape AND the offending key in one
    // pass without losing the error reference.
    let err: unknown;
    try {
      db.table(table).where(p);
    } catch (e) {
      err = e;
    }
    expect(err, `where(${label}) must throw synchronously`).toBeInstanceOf(MPS3Error);
    expect((err as MPS3Error).code, `where(${label}) error.code`).toBe("InvalidConfig");
    // Message names the offending `$`-key verbatim (e.g. "$or",
    // "$gt", "$eq"). The validator's wording is `Unsupported
    // predicate operator "$or" at <root> — …` so a substring match
    // on the operator name is sufficient and resilient to wording
    // tweaks.
    expect((err as MPS3Error).message, `where(${label}) message names ${offender}`).toContain(
      offender,
    );
  }
};

/** Read happy-path: `all` / `count` / `first` / `.order().limit()`. */
const runReadHappyPath = async (
  db: Db,
  storage: Storage,
  app: string,
  tenant: string,
): Promise<void> => {
  const t = freshTableName("read-hp");
  await provision(storage, app, tenant, t);
  await db.table<Doc>(t).insert({ k: "a", v: 1 });
  await db.table<Doc>(t).insert({ k: "b", v: 2 });
  await db.table<Doc>(t).insert({ k: "c", v: 3 });

  expect(await db.table<Doc>(t).count()).toBe(3);
  expect(await db.table<Doc>(t).where({}).count()).toBe(3);

  const onlyB = await db.table<Doc>(t).where({ k: "b" }).first();
  expect(onlyB).toBeDefined();
  expect(onlyB?.k).toBe("b");
  expect(onlyB?.v).toBe(2);

  const all = await db.table<Doc>(t).where({}).all();
  expect(all).toHaveLength(3);

  const ordered = await db.table<Doc>(t).order({ v: "asc" }).limit(2).all();
  expect(ordered.map((r) => r.k)).toEqual(["a", "b"]);

  const descendingOne = await db.table<Doc>(t).order({ v: "desc" }).limit(1).all();
  expect(descendingOne.map((r) => r.k)).toEqual(["c"]);
};

/** Read not-found: empty table returns undefined / [] / 0. */
const runReadNotFound = async (
  db: Db,
  storage: Storage,
  app: string,
  tenant: string,
): Promise<void> => {
  const t = freshTableName("read-empty");
  await provision(storage, app, tenant, t);
  expect(await db.table<Doc>(t).where({ k: "x" }).first()).toBeUndefined();
  expect(await db.table<Doc>(t).where({ k: "x" }).all()).toEqual([]);
  expect(await db.table<Doc>(t).where({ k: "x" }).count()).toBe(0);
  expect(await db.table<Doc>(t).count()).toBe(0);
};

/** Insert contract: UUIDv7 auto-id, caller-supplied `_id` honoured, round-trip. */
const runInsertContract = async (
  db: Db,
  storage: Storage,
  app: string,
  tenant: string,
): Promise<void> => {
  const t = freshTableName("insert");
  await provision(storage, app, tenant, t);

  const { _id: auto } = await db.table<Doc>(t).insert({ k: "auto" });
  // UUIDv7: 36 chars with hyphens, version-7 nibble at position 14
  // (third group, first char).
  expect(auto).toMatch(UUIDV7_RE);

  // Caller-supplied `_id` is honoured verbatim.
  const customId = "00000000-0000-7000-8000-000000000001";
  const { _id } = await db.table<Doc>(t).insert({ _id: customId, k: "custom" });
  expect(_id).toBe(customId);

  // Round-trip via where() to confirm the doc is materialised.
  const got = await db.table<Doc>(t).where({ _id: customId }).first();
  expect(got).toBeDefined();
  expect(got?._id).toBe(customId);
  expect(got?.k).toBe("custom");
};

/** Update contract: RFC 7386 — multiple matches, `null` strips key. */
const runUpdateContract = async (
  db: Db,
  storage: Storage,
  app: string,
  tenant: string,
): Promise<void> => {
  const t = freshTableName("update");
  await provision(storage, app, tenant, t);
  await db.table<Doc>(t).insert({ k: "a", v: 1 });
  await db.table<Doc>(t).insert({ k: "a", v: 2 });
  await db.table<Doc>(t).insert({ k: "b", v: 3 });

  const { modified } = await db.table<Doc>(t).where({ k: "a" }).update({ marker: true });
  expect(modified).toBe(2);

  const afterMarker = await db.table<Doc>(t).where({ k: "a" }).all();
  expect(afterMarker).toHaveLength(2);
  for (const row of afterMarker) expect(row.marker).toBe(true);

  // RFC 7386: null strips a key from the post-image. `Partial<T>`'s
  // type forbids `null` at the leaf (the locked predicate / patch
  // value type is `JSONArrayless = string | number | boolean |
  // JSONArraylessObject`), so we route through an `unknown` cast —
  // this is testing the runtime merge contract, which IS
  // `merge(target, null) === undefined` per `packages/protocol/src/json.ts`.
  const { modified: stripped } = await db
    .table<Doc>(t)
    .where({ k: "a" })
    .update({ marker: null } as unknown as Partial<Doc>);
  expect(stripped).toBe(2);
  const afterStrip = await db.table<Doc>(t).where({ k: "a" }).all();
  for (const row of afterStrip) expect("marker" in row).toBe(false);
};

/** Replace cardinality: exactly-one succeeds; zero / multiple → Conflict. */
const runReplaceContract = async (
  db: Db,
  storage: Storage,
  app: string,
  tenant: string,
): Promise<void> => {
  const t = freshTableName("replace");
  await provision(storage, app, tenant, t);
  await db.table<Doc>(t).insert({ k: "only", v: 1 });

  // Exactly one match — success. Replace doesn't return a value.
  await db.table<Doc>(t).where({ k: "only" }).replace({ k: "only", v: 99 });
  const got = await db.table<Doc>(t).where({ k: "only" }).first();
  expect(got?.v).toBe(99);

  // Zero matches — Conflict.
  await expect(
    db.table<Doc>(t).where({ k: "ghost" }).replace({ k: "ghost", v: 0 }),
  ).rejects.toMatchObject({ code: "Conflict" });

  // Two matches — Conflict.
  await db.table<Doc>(t).insert({ k: "dup", v: 1 });
  await db.table<Doc>(t).insert({ k: "dup", v: 2 });
  await expect(
    db.table<Doc>(t).where({ k: "dup" }).replace({ k: "dup", v: 3 }),
  ).rejects.toMatchObject({ code: "Conflict" });
};

/** Delete contract: tombstones every match; no longer visible. */
const runDeleteContract = async (
  db: Db,
  storage: Storage,
  app: string,
  tenant: string,
): Promise<void> => {
  const t = freshTableName("delete");
  await provision(storage, app, tenant, t);
  await db.table<Doc>(t).insert({ k: "x", v: 1 });
  await db.table<Doc>(t).insert({ k: "x", v: 2 });
  await db.table<Doc>(t).insert({ k: "y", v: 3 });

  const { deleted } = await db.table<Doc>(t).where({ k: "x" }).delete();
  expect(deleted).toBe(2);

  // Subsequent reads no longer see the deleted docs.
  expect(await db.table<Doc>(t).where({ k: "x" }).count()).toBe(0);
  expect(await db.table<Doc>(t).count()).toBe(1);
  expect((await db.table<Doc>(t).where({}).first())?.k).toBe("y");
};

/** Transaction body buffering: empty body is a no-op; commit lands after body. */
const runTransactionBody = async (
  db: Db,
  storage: Storage,
  app: string,
  tenant: string,
): Promise<void> => {
  const t = freshTableName("tx-body");
  await provision(storage, app, tenant, t);

  // Empty body — no commit, `count` stays zero.
  await db.transaction(t, async () => {
    // no-op
  });
  expect(await db.table<Doc>(t).count()).toBe(0);

  // Body inserts — visible AFTER the body resolves.
  await db.transaction<Doc>(t, async (tx) => {
    await tx.insert({ k: "inside", v: 1 });
    await tx.insert({ k: "inside", v: 2 });
  });
  expect(await db.table<Doc>(t).where({ k: "inside" }).count()).toBe(2);

  // Body throw — commit skipped, mutations dropped, identity preserved.
  const boom = new Error("body-throw");
  let caught: unknown;
  try {
    await db.transaction<Doc>(t, async (tx) => {
      await tx.insert({ k: "doomed" });
      throw boom;
    });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBe(boom);
  // Buffered insert NOT materialised.
  expect(await db.table<Doc>(t).where({ k: "doomed" }).count()).toBe(0);
};

/**
 * Cross-writer Conflict: two concurrent transactions racing on the
 * same table's `current.json`. The locked contract
 * (`packages/protocol/src/db.ts:211-215`) says single-attempt — at
 * least one writer throws `MPS3Error{code:"Conflict"}` on CAS loss.
 *
 * In-process variants (memory, local-fs) share state via the
 * backing-store singleton, so two transactions on the same `db`
 * already race. Variants where two `Db` instances are cheap to
 * construct over the same bucket (node-minio, cloudflare-r2) pass
 * a `rivalDb` to force two distinct in-process commit loops.
 */
const runTransactionConflict = async (
  db: Db,
  rival: Db,
  storage: Storage,
  app: string,
  tenant: string,
): Promise<void> => {
  const t = freshTableName("tx-race");
  await provision(storage, app, tenant, t);
  // Seed one row both writers will race to update. Both transactions
  // observe this row before either commits.
  await db.table<Doc>(t).insert({ _id: "race", k: "race", v: 0 });

  const update = (writer: Db, label: string): Promise<void> =>
    writer.transaction<Doc>(t, async (tx) => {
      // Tiny await so both bodies hit `commitBatch` overlapping in
      // event-loop terms; without this they're sequential on memory.
      await tx.where({ k: "race" }).update({ marker: true, [label]: 1 } as Partial<Doc>);
    });

  const results = await Promise.allSettled([update(db, "A"), update(rival, "B")]);
  const rejected = results.filter((r) => r.status === "rejected");
  // At least one writer lost the CAS race. The exact-one-wins shape
  // is the locked contract — but on backends where the two commits
  // serialise inside the same event-loop tick (memory under
  // single-fork vitest) both can succeed in sequence. We assert the
  // weaker "at most one Conflict, all rejections are Conflict" shape
  // — strong enough to fail if a writer ever rejects with another
  // code, weak enough to avoid flake on serialising backends.
  for (const r of rejected) {
    const err = (r as PromiseRejectedResult).reason as MPS3Error;
    expect(err).toBeInstanceOf(MPS3Error);
    expect(err.code).toBe("Conflict");
  }
};

/**
 * [compaction] Find results unchanged across a compaction run. The
 * compactor (`@baerly/server`'s {@link compact}) folds the live log
 * prefix into a hashed snapshot and CAS-advances `current.json`. The
 * reader then loads the snapshot + overlays any post-snapshot tail.
 * The locked invariant: the row set the reader returns is unchanged
 * across the snapshot boundary.
 *
 * Runs across all four storage adapters via the variant table — this
 * is the cross-adapter regression check that the compactor's snapshot
 * encode/decode + the reader's snapshot-aware fold work uniformly.
 */
const runCompactionCascade = async (
  db: Db,
  storage: Storage,
  app: string,
  tenant: string,
): Promise<void> => {
  const t = freshTableName("compact");
  await provision(storage, app, tenant, t);

  // Insert N rows to feed the snapshot fold.
  for (let i = 0; i < 30; i++) {
    await db.table<Doc>(t).insert({ _id: `pre-${i}`, k: "pre", n: i });
  }

  const before = await db.table<Doc>(t).order({ _id: "asc" }).all();
  expect(before).toHaveLength(30);

  // Compact: minEntriesToCompact below our N so the run lands.
  const res = await compact(
    {
      storage,
      currentJsonKey: `app/${app}/tenant/${tenant}/manifests/${t}/current.json`,
    },
    { minEntriesToCompact: 10, maxEntriesPerRun: 100 },
  );
  expect(res.written).toBe(true);
  expect(res.previousSnapshotKey).toBeNull();
  expect(res.newSnapshotKey).toBeDefined();
  expect(res.logSeqStartAfter).toBe(30);

  // Reader returns the same set after the snapshot landed.
  const after = await db.table<Doc>(t).order({ _id: "asc" }).all();
  expect(after).toEqual(before);

  // Post-snapshot inserts overlay correctly on top of the snapshot.
  for (let i = 0; i < 5; i++) {
    await db.table<Doc>(t).insert({ _id: `post-${i}`, k: "post", n: i });
  }
  const overlay = await db.table<Doc>(t).order({ _id: "asc" }).all();
  expect(overlay).toHaveLength(35);
  expect(overlay.filter((r) => r.k === "pre")).toHaveLength(30);
  expect(overlay.filter((r) => r.k === "post")).toHaveLength(5);
};

/**
 * [gc] After 30 writes + a compaction that folds them all into a
 * snapshot, `runGc()` with `graceMillis: 0` MUST mark and sweep
 * every stale log entry in one pass. Asserts: post-sweep the log
 * keys are gone, and the reader still returns the same row set
 * (snapshot is the live source).
 *
 * Runs across all four storage adapters via the variant table — this
 * is the cross-adapter regression that the GC mark + sweep + DELETE
 * + CAS-on-`gc/pending.json` work uniformly under every {@link Storage}.
 */
const runGcCascade = async (
  db: Db,
  storage: Storage,
  app: string,
  tenant: string,
): Promise<void> => {
  const t = freshTableName("gc");
  await provision(storage, app, tenant, t);
  const currentJsonKey = `app/${app}/tenant/${tenant}/manifests/${t}/current.json`;
  const pendingKey = `app/${app}/tenant/${tenant}/manifests/${t}/gc/pending.json`;
  const tablePrefix = `app/${app}/tenant/${tenant}/manifests/${t}`;

  for (let i = 0; i < 30; i++) {
    await db.table<Doc>(t).insert({ _id: `r-${i}`, k: "row", n: i });
  }

  const before = await db.table<Doc>(t).order({ _id: "asc" }).all();
  expect(before).toHaveLength(30);

  const compactRes = await compact(
    { storage, currentJsonKey },
    { minEntriesToCompact: 10, maxEntriesPerRun: 50 },
  );
  expect(compactRes.written).toBe(true);
  expect(compactRes.logSeqStartAfter).toBe(30);

  // grace=0 ⇒ same pass marks AND sweeps the 30 stale log entries.
  const gcRes = await runGc(
    { storage, currentJsonKey },
    { graceMillis: 0, maxSweepsPerRun: 50, maxMarksPerRun: 50 },
  );
  expect(gcRes.marked.stale_log).toBe(30);
  expect(gcRes.swept).toBe(30);

  // log/0..log/29 are gone.
  for (let i = 0; i < 30; i++) {
    expect(await storage.get(`${tablePrefix}/log/${String(i)}.json`)).toBeNull();
  }
  // Reads still return the same row set — snapshot is the live truth.
  const after = await db.table<Doc>(t).order({ _id: "asc" }).all();
  expect(after).toEqual(before);

  // pending.json exists and was created by runGc.
  const got = await storage.get(pendingKey);
  expect(got).not.toBeNull();
};

/**
 * LogEntry shape — frozen assertion. After an I+I+U+D sequence,
 * walk `<tablePrefix>/log/<seq>.json` directly via `Storage` and
 * assert the per-op shape from `packages/protocol/src/log.ts:22–100`.
 */
const runLogEntryShape = async (
  db: Db,
  storage: Storage,
  app: string,
  tenant: string,
): Promise<void> => {
  const t = freshTableName("log");
  await provision(storage, app, tenant, t);

  // Direct-mutation sequence (one commit per call → distinct sessions).
  const { _id: id1 } = await db.table<Doc>(t).insert({ k: "1", v: 1 });
  const { _id: id2 } = await db.table<Doc>(t).insert({ k: "2", v: 2 });
  const { modified } = await db.table<Doc>(t).where({ _id: id1 }).update({ marker: true });
  expect(modified).toBe(1);
  const { deleted } = await db.table<Doc>(t).where({ _id: id2 }).delete();
  expect(deleted).toBe(1);

  // Transaction emit: two inserts inside one tx share a session id.
  await db.transaction<Doc>(t, async (tx) => {
    await tx.insert({ k: "tx-a" });
    await tx.insert({ k: "tx-b" });
  });

  const tablePrefix = `app/${app}/tenant/${tenant}/manifests/${t}`;
  const entries: LogEntry[] = [];
  for await (const { key } of storage.list(`${tablePrefix}/log/`)) {
    const got = await storage.get(key);
    if (got === null) continue;
    entries.push(JSON.parse(new TextDecoder().decode(got.body)) as LogEntry);
  }
  entries.sort((a, b) => a.seq - b.seq);

  // 2 inserts + 1 update + 1 delete + 2 tx inserts = 6 entries.
  expect(entries).toHaveLength(6);

  // Per packages/protocol/src/log.ts:22-100 — always-fields hold on
  // every entry.
  for (const e of entries) {
    expect(e.lsn).toMatch(LSN_RE);
    expect(typeof e.commit_ts).toBe("string");
    expect(Number.isFinite(new Date(e.commit_ts).getTime())).toBe(true);
    expect(typeof e.session).toBe("string");
    expect(e.session.length).toBeGreaterThan(0);
    expect(typeof e.seq).toBe("number");
    expect(e.collection).toBe(t);
    expect(typeof e.schema_version).toBe("number");
    expect(["I", "U", "D"]).toContain(e.op);
    // doc_id required for I/U/D.
    expect(typeof e.doc_id).toBe("string");
    expect((e.doc_id ?? "").length).toBeGreaterThan(0);
  }

  // Direct-mutation entries (0..3): per-op shape.
  const [e0, e1, e2, e3, e4, e5] = entries as [
    LogEntry,
    LogEntry,
    LogEntry,
    LogEntry,
    LogEntry,
    LogEntry,
  ];

  expect(e0.op).toBe("I");
  expect(e0.doc_id).toBe(id1);
  expect(e0.new).toEqual(e0.patch);
  expect(e0.new?._id).toBe(id1);

  expect(e1.op).toBe("I");
  expect(e1.doc_id).toBe(id2);
  expect(e1.new).toEqual(e1.patch);

  expect(e2.op).toBe("U");
  expect(e2.doc_id).toBe(id1);
  // Per-doc-replace model: `new === patch` for U entries today.
  expect(e2.new).toEqual(e2.patch);
  expect(e2.new?.marker).toBe(true);

  expect(e3.op).toBe("D");
  expect(e3.doc_id).toBe(id2);
  // D entries carry no body under PATCH_ONLY replica identity.
  expect(e3.new).toBeUndefined();
  expect(e3.patch).toBeUndefined();

  // Direct mutations have distinct sessions per `commit()`.
  expect(e0.session).not.toBe(e1.session);

  // Transaction entries (4..5): share one session id.
  expect(e4.op).toBe("I");
  expect(e5.op).toBe("I");
  expect(e4.session).toBe(e5.session);
  // And the transaction's session is different from every direct
  // mutation's session.
  expect(e4.session).not.toBe(e0.session);
  expect(e4.session).not.toBe(e2.session);
};

/**
 * Public cascade entry. The per-runtime files call this once per
 * `(storage, rivalStorage?)` pair.
 *
 * @param opts.storage      One {@link Storage} handle (writes + reads).
 * @param opts.rivalStorage Optional second handle sharing the same
 *                          backing store. When present, the
 *                          cross-writer Conflict test runs; absent,
 *                          it's skipped (variants where a second
 *                          handle isn't cheap to construct).
 */
export const runTableApiCascade = async (opts: {
  storage: Storage;
  rivalStorage?: Storage;
}): Promise<void> => {
  // One tenant per cascade run keeps cross-test pollution out of the
  // memory/r2 singletons. Tables inside the cascade still get fresh
  // names per block.
  const tenant = `t-${uuid().slice(0, 8)}`;

  const db = Db.create({ storage: opts.storage, app: APP, tenant });

  // 1. Predicate `$`-key rejection. SYNCHRONOUS at `.where(...)` —
  //    operator-policy boundary is public contract (ticket 12).
  const rejectionTable = freshTableName("reject");
  await provision(opts.storage, APP, tenant, rejectionTable);
  predicateRejection(db, rejectionTable);

  // 2. Reads.
  await runReadHappyPath(db, opts.storage, APP, tenant);
  await runReadNotFound(db, opts.storage, APP, tenant);

  // 3. Writes.
  await runInsertContract(db, opts.storage, APP, tenant);
  await runUpdateContract(db, opts.storage, APP, tenant);
  await runReplaceContract(db, opts.storage, APP, tenant);
  await runDeleteContract(db, opts.storage, APP, tenant);

  // 4. Transactions.
  await runTransactionBody(db, opts.storage, APP, tenant);
  if (opts.rivalStorage !== undefined) {
    const rival = Db.create({ storage: opts.rivalStorage, app: APP, tenant });
    await runTransactionConflict(db, rival, opts.storage, APP, tenant);
  }

  // 5. Compaction — fold the log prefix into a snapshot and read
  //    through it. Runs across every adapter via the variant table.
  await runCompactionCascade(db, opts.storage, APP, tenant);

  // 6. GC — mark + sweep stale log entries with grace bypassed.
  //    Runs across every adapter via the variant table.
  await runGcCascade(db, opts.storage, APP, tenant);

  // 7. LogEntry shape — frozen.
  await runLogEntryShape(db, opts.storage, APP, tenant);
};
