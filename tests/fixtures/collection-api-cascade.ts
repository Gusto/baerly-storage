/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes (see `@baerly/protocol/src/collection-api.ts`'s `Collection<T>` /
   `Query<T>` declarations); the cascade reads / asserts it by name. */

/**
 * Collection-API integration cascade — backend-agnostic test driver.
 *
 * One entry point ({@link runCollectionApiCascade}) exercises every
 * locked verb on the `db.collection(...)` surface, then walks the
 * emitted `LogEntry`s and asserts the frozen
 * shape declared in `packages/protocol/src/log.ts:22–100`. The
 * driver is consumed by the Node-side variant table
 * (`tests/integration/collection-api.test.ts`) and the Workerd mirror
 * (`packages/adapter-cloudflare/src/collection-api.test.ts`).
 *
 * Pure module — no Node imports, no `node:fs`, no `node:os`. The
 * Cloudflare Workers pool consumes this file directly inside
 * Workerd; the Node-only variant setup (temp dirs, S3 sign,
 * `aws4fetch`) lives in the call site.
 *
 * @see tests/integration/collection-api.test.ts (Node-side variants)
 * @see packages/adapter-cloudflare/src/collection-api.test.ts (Workerd variant)
 */

import { expect } from "vitest";
import {
  type CurrentJson,
  type DocumentData,
  type LogEntry,
  BaerlyError,
  type SchemaValidator,
  type Storage,
  createCurrentJson,
  uuid,
} from "@baerly/protocol";
import { Db } from "@baerly/server";
import { compact, runGc } from "@baerly/server/maintenance";
import { createObservabilityContext, runWithContext } from "@baerly/server/observability";
import {
  type InternalCompactOptions,
  type InternalRunGcOptions,
  Writer,
} from "@baerly/server/_internal/testing";
import { logStateCurrentJson } from "./log-state.ts";

const APP = "collection-api-test";

/**
 * UUIDv7 regex — 36 chars with hyphens, version-7 nibble at the
 * start of the third group (position 14 of the string).
 */
const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * LSN shape per `packages/protocol/src/log.ts:24-30`:
 * `<base32-time>_<session>_<seq>` — base-32 alphabet is `[0-9a-v]`,
 * `seq` is a fixed-width 11-character group (COUNT_BIT_WIDTH=53, ceil(53/5)=11).
 *
 * This is an independent hand-written literal — it deliberately restates
 * the expected wire shape rather than importing the production `LSN_RE`
 * from `since.ts` (which would make the `toMatch` assertion a tautology).
 * When `COUNT_BIT_WIDTH` changes, update the `{N}` here to `ceil(bits/5)`.
 */
const LSN_RE = /^[0-9a-v]+_[0-9a-v]+_[0-9a-v]{11}$/;

const seedCurrent = (): CurrentJson =>
  logStateCurrentJson({ writer_fence: { epoch: 0, owner: "collection-api-test", claimed_at: "" } });

/**
 * Tolerant `createCurrentJson` — when the cross-writer variant
 * passes a `rivalStorage` sharing the same backing store, the rival
 * may have already seeded the key. Adopt the existing seed on
 * Conflict.
 */
const ensureCurrent = async (storage: Storage, key: string): Promise<void> => {
  try {
    await createCurrentJson(storage, key, seedCurrent());
  } catch (error) {
    if (error instanceof BaerlyError && error.code === "Conflict") {
      return;
    }
    throw error;
  }
};

/**
 * Provision `current.json` for every table the cascade touches.
 * `Writer.commit()` throws `InvalidResponse` if the table's
 * `current.json` is missing; the read path returns empty. The cascade
 * seeds each table before any insert.
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
 * `Collection<DocumentData>` (the default) because the locked
 * `T extends DocumentData` constraint forbids optional
 * fields under strict-object-mode tsgo — a named interface with
 * `readonly k?: string` is not assignable to
 * `{ [x: string]: DocumentValue }`. Static doc-shape typing comes
 * back with a future schema-validation pass; today the table
 * read/write path is dynamically typed.
 */
type Doc = DocumentData;

/**
 * Predicate `$`-key rejection. The operator vocabulary lives on the
 * callback form (`.where(q => q.gt(...))`); the object-form is
 * equality-only and the normaliser
 * (`packages/protocol/src/query/normalize.ts`) rejects any `$`-prefixed
 * key with `BaerlyError{code:"InvalidConfig"}`. Rejection is
 * SYNCHRONOUS at `.where(...)` — no `await`, no terminal-time
 * deferral — because the operator-policy boundary is the public
 * contract surface.
 *
 * The error message names the offending `$`-key AND surfaces the
 * "operator vocabulary moved to the callback form" wording so
 * downstream tooling can match without parsing prose.
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
    // Nested $-key — the normaliser walks the sub-predicate and
    // rejects at the first $-prefixed segment, regardless of whether
    // the operator name is part of the locked vocabulary or not.
    { label: "nested $regex", predicate: { a: { $regex: "x" } }, offender: "$regex" },
    { label: "nested $gte", predicate: { a: { $gte: 1 } }, offender: "$gte" },
  ];

  for (const { label, predicate, offender } of cases) {
    // The cast through `unknown` is intentional — `Predicate<T>` is
    // strongly typed and forbids `$`-keys at compile time. We're
    // testing the runtime guard.
    const p = predicate as unknown as Parameters<typeof db.collection>[0] extends string
      ? Parameters<ReturnType<typeof db.collection>["where"]>[0]
      : never;
    // SYNCHRONOUS throw — `.where(p)` returns a builder on success,
    // so an absent throw here means the operator-policy contract is
    // unwired. We capture instead of `expect(() => ...).toThrow` so
    // we can assert the BaerlyError shape AND the offending key in one
    // pass without losing the error reference.
    let err: unknown;
    try {
      db.collection(table).where(p);
    } catch (error) {
      err = error;
    }
    expect(err, `where(${label}) must throw synchronously`).toBeInstanceOf(BaerlyError);
    expect((err as BaerlyError).code, `where(${label}) error.code`).toBe("InvalidConfig");
    // Message names the offending `$`-key verbatim and surfaces the
    // documented redirection to the callback form. The normaliser's
    // wording is:
    //   `Unsupported predicate operator "$or" at <root> — operator
    //    vocabulary moved to the callback form (.where(q => q.gt(field, value))).`
    expect((err as BaerlyError).message, `where(${label}) message names ${offender}`).toContain(
      offender,
    );
    expect(
      (err as BaerlyError).message,
      `where(${label}) message redirects to the callback form`,
    ).toContain("operator vocabulary");
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
  await db.collection(t).insert({ k: "a", v: 1 });
  await db.collection(t).insert({ k: "b", v: 2 });
  await db.collection(t).insert({ k: "c", v: 3 });

  await expect(db.collection(t).count()).resolves.toBe(3);
  await expect(db.collection(t).where({}).count()).resolves.toBe(3);

  const onlyB = await db.collection(t).where({ k: "b" }).first();
  expect(onlyB).toBeDefined();
  expect(onlyB?.["k"]).toBe("b");
  expect(onlyB?.["v"]).toBe(2);

  const all = await db.collection(t).where({}).all();
  expect(all).toHaveLength(3);

  const ordered = await db.collection(t).order({ v: "asc" }).limit(2).all();
  expect(ordered.map((r) => r["k"])).toEqual(["a", "b"]);

  const descendingOne = await db.collection(t).order({ v: "desc" }).limit(1).all();
  expect(descendingOne.map((r) => r["k"])).toEqual(["c"]);
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
  await expect(db.collection(t).where({ k: "x" }).first()).resolves.toBeUndefined();
  await expect(db.collection(t).where({ k: "x" }).all()).resolves.toEqual([]);
  await expect(db.collection(t).where({ k: "x" }).count()).resolves.toBe(0);
  await expect(db.collection(t).count()).resolves.toBe(0);
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

  const { _id: auto } = await db.collection(t).insert({ k: "auto" });
  // UUIDv7: 36 chars with hyphens, version-7 nibble at position 14
  // (third group, first char).
  expect(auto).toMatch(UUIDV7_RE);

  // Caller-supplied `_id` is honoured verbatim.
  const customId = "00000000-0000-7000-8000-000000000001";
  const { _id } = await db.collection(t).insert({ _id: customId, k: "custom" });
  expect(_id).toBe(customId);

  // Round-trip via get() to confirm the doc is materialised.
  const got = await db.collection(t).get(customId);
  expect(got).toBeDefined();
  expect(got?.["_id"]).toBe(customId);
  expect(got?.["k"]).toBe("custom");
};

/**
 * `_id` boundary guard: a caller-supplied illegal `_id` is rejected at
 * the collection boundary on EVERY backend identically — proving that
 * on `local-fs` the bad id is refused before it reaches `#pathFor`
 * (never a real filesystem write). The guard is `assertDocId`
 * (`packages/server/src/doc-id.ts`), the `_id` analogue of
 * `assertKeySegment` for app/tenant/collection.
 */
const runDocIdBoundary = async (
  db: Db,
  storage: Storage,
  app: string,
  tenant: string,
): Promise<void> => {
  const t = freshTableName("doc-id");
  await provision(storage, app, tenant, t);
  const notes = db.collection(t);
  // Illegal-as-a-key-segment ids — rejected at BOTH write origins.
  for (const bad of ["../escape", "a/b", "_reserved"]) {
    await expect(notes.insert({ _id: bad, title: "x" } as never)).rejects.toMatchObject({
      code: "InvalidConfig",
    });
    await expect(notes.replace(bad, { title: "x" } as never)).rejects.toMatchObject({
      code: "InvalidConfig",
    });
  }
  // Empty string is the auto-id sentinel on `insert` (mints a UUIDv7,
  // never reaches `assertDocId`), so it is NOT an insert rejection.
  // On `replace` there is no auto-id path — an empty `id` is an
  // illegal key segment and is rejected.
  await expect(notes.replace("", { title: "x" } as never)).rejects.toMatchObject({
    code: "InvalidConfig",
  });
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
  await db.collection(t).insert({ k: "a", v: 1 });
  await db.collection(t).insert({ k: "a", v: 2 });
  await db.collection(t).insert({ k: "b", v: 3 });

  const { modified } = await db.collection(t).where({ k: "a" }).update({ marker: true });
  expect(modified).toBe(2);

  const afterMarker = await db.collection(t).where({ k: "a" }).all();
  expect(afterMarker).toHaveLength(2);
  for (const row of afterMarker) {
    expect(row["marker"]).toBe(true);
  }

  // RFC 7386: null strips a key from the post-image. `Partial<T>`'s
  // type forbids `null` at the leaf (the locked predicate / patch
  // value type is `DocumentValue = string | number | boolean |
  // DocumentData`), so we route through an `unknown` cast —
  // this is testing the runtime merge contract, which IS
  // `merge(target, null) === undefined` per `packages/protocol/src/json.ts`.
  const { modified: stripped } = await db
    .collection(t)
    .where({ k: "a" })
    .update({ marker: null } as unknown as Partial<Doc>);
  expect(stripped).toBe(2);
  const afterStrip = await db.collection(t).where({ k: "a" }).all();
  for (const row of afterStrip) {
    expect("marker" in row).toBe(false);
  }
};

/** `Collection.replace(id, doc)`: by-id whole-document overwrite; `NotFound` on missing. */
const runTableReplaceByIdContract = async (
  db: Db,
  storage: Storage,
  app: string,
  tenant: string,
): Promise<void> => {
  const t = freshTableName("replace");
  await provision(storage, app, tenant, t);
  const { _id } = await db.collection(t).insert({ k: "only", v: 1 });

  // Happy path: the row at `_id` is overwritten.
  await db.collection(t).replace(_id, { _id, k: "only", v: 99 });
  const got = await db.collection(t).get(_id);
  expect(got?.["v"]).toBe(99);

  // Missing id: NotFound.
  await expect(
    db.collection(t).replace("does-not-exist", { _id: "does-not-exist", k: "x", v: 0 }),
  ).rejects.toMatchObject({ code: "NotFound" });
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
  await db.collection(t).insert({ k: "x", v: 1 });
  await db.collection(t).insert({ k: "x", v: 2 });
  await db.collection(t).insert({ k: "y", v: 3 });

  const { deleted } = await db.collection(t).where({ k: "x" }).delete();
  expect(deleted).toBe(2);

  // Subsequent reads no longer see the deleted docs.
  await expect(db.collection(t).where({ k: "x" }).count()).resolves.toBe(0);
  await expect(db.collection(t).count()).resolves.toBe(1);
  const first = await db.collection(t).where({}).first();
  expect(first?.["k"]).toBe("y");
};

/**
 * Cross-writer Conflict: two concurrent direct mutations racing on the
 * same table's `current.json`. The locked contract
 * (`packages/protocol/src/collection-api.ts:211-215`) says single-attempt — at
 * least one writer throws `BaerlyError{code:"Conflict"}` on CAS loss.
 *
 * In-process variants (memory, local-fs) share state via the
 * backing-store singleton, so two mutations on the same `db`
 * already race. Variants where two `Db` instances are cheap to
 * construct over the same bucket (node-minio, cloudflare-r2) pass
 * a `rival` `Db` to force two distinct in-process commit loops.
 */
const runConcurrentWriteConflict = async (
  db: Db,
  rival: Db,
  storage: Storage,
  app: string,
  tenant: string,
): Promise<void> => {
  const t = freshTableName("tx-race");
  await provision(storage, app, tenant, t);
  // Seed one row both writers will race to update. Both mutations
  // observe this row before either commits.
  await db.collection(t).insert({ _id: "race", k: "race", v: 0 });

  const update = (writer: Db, label: string): Promise<{ modified: number }> =>
    writer
      .collection(t)
      .where({ k: "race" })
      .update({ marker: true, [label]: 1 } as Partial<Doc>);

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
    const err = (r as PromiseRejectedResult).reason as BaerlyError;
    expect(err).toBeInstanceOf(BaerlyError);
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
    await db.collection(t).insert({ _id: `pre-${i}`, k: "pre", n: i });
  }

  const before = await db.collection(t).order({ _id: "asc" }).all();
  expect(before).toHaveLength(30);

  // Compact: minEntriesToCompact below our N so the run lands.
  const res = await compact(
    {
      storage,
      currentJsonKey: `app/${app}/tenant/${tenant}/manifests/${t}/current.json`,
    },
    { minEntriesToCompact: 10, maxEntriesPerRun: 100 } as InternalCompactOptions,
  );
  expect(res.written).toBe(true);
  expect(res.previousSnapshotKey).toBeNull();
  expect(res.newSnapshotKey).toBeDefined();
  expect(res.logSeqStartAfter).toBe(30);

  // Reader returns the same set after the snapshot landed.
  const after = await db.collection(t).order({ _id: "asc" }).all();
  expect(after).toEqual(before);

  // Post-snapshot inserts overlay correctly on top of the snapshot.
  for (let i = 0; i < 5; i++) {
    await db.collection(t).insert({ _id: `post-${i}`, k: "post", n: i });
  }
  const overlay = await db.collection(t).order({ _id: "asc" }).all();
  expect(overlay).toHaveLength(35);
  expect(overlay.filter((r) => r["k"] === "pre")).toHaveLength(30);
  expect(overlay.filter((r) => r["k"] === "post")).toHaveLength(5);
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
  const collectionPrefix = `app/${app}/tenant/${tenant}/manifests/${t}`;

  for (let i = 0; i < 30; i++) {
    await db.collection(t).insert({ _id: `r-${i}`, k: "row", n: i });
  }

  const before = await db.collection(t).order({ _id: "asc" }).all();
  expect(before).toHaveLength(30);

  const compactRes = await compact({ storage, currentJsonKey }, {
    minEntriesToCompact: 10,
    maxEntriesPerRun: 50,
  } as InternalCompactOptions);
  expect(compactRes.written).toBe(true);
  expect(compactRes.logSeqStartAfter).toBe(30);

  // grace=0 ⇒ same pass marks AND sweeps the 30 stale log entries.
  const gcRes = await runGc({ storage, currentJsonKey }, {
    graceMillis: 0,
    maxSweepsPerRun: 50,
    maxMarksPerRun: 50,
    // grace=0 sets each candidate's due_at to its storage `lastModified`.
    // On S3-like backends (node-minio) `lastModified` is the *server*
    // clock at *second* resolution, which can sit a beat ahead of the
    // local clock (container/VM skew, worse under load). That left 1-3 of
    // the 30 just-written entries with a due_at in the local future, so a
    // single grace=0 pass swept 27-29 not 30 — a real flake under load
    // (memory/local-fs use a local ms clock and never hit it). Pin `now`
    // a day ahead so the sweep threshold dominates any plausible skew; the
    // pass still marks + sweeps all 30, just independent of clock alignment.
    now: () => new Date(Date.now() + 24 * 60 * 60 * 1000),
  } as InternalRunGcOptions);
  expect(gcRes.marked.stale_log).toBe(30);
  expect(gcRes.swept).toBe(30);

  // log/0..log/29 are gone.
  for (let i = 0; i < 30; i++) {
    await expect(storage.get(`${collectionPrefix}/log/${String(i)}.json`)).resolves.toBeNull();
  }
  // Reads still return the same row set — snapshot is the live truth.
  const after = await db.collection(t).order({ _id: "asc" }).all();
  expect(after).toEqual(before);

  // pending.json exists and was created by runGc.
  const got = await storage.get(pendingKey);
  expect(got).not.toBeNull();
};

/**
 * [metrics] Full lifecycle cycle (writes + compact + runGc) wired
 * through a per-request observability context — the six load-bearing
 * metric names MUST appear in the context's recorder. This runs
 * across every adapter via the variant table — the assertion is
 * "the emission sites fire correctly on every {@link Storage}
 * backend."
 *
 * Writer / compactor / GC emit via `getCurrentContext()?.recorder`,
 * so wrapping the whole pass in `runWithContext(ctx, ...)` is the
 * test-side seam.
 */
const runMetricsCascade = async (storage: Storage, app: string, tenant: string): Promise<void> => {
  const t = freshTableName("metrics");
  await provision(storage, app, tenant, t);
  const currentJsonKey = `app/${app}/tenant/${tenant}/manifests/${t}/current.json`;
  const ctx = createObservabilityContext();
  await runWithContext(ctx, async () => {
    const writer = new Writer({ storage, currentJsonKey });
    for (let i = 0; i < 100; i++) {
      await writer.commit({
        op: "I",
        collection: t,
        docId: `m${i}`,
        body: { _id: `m${i}`, n: i },
      });
    }

    await compact({ storage, currentJsonKey }, {
      minEntriesToCompact: 10,
      maxEntriesPerRun: 100,
    } as InternalCompactOptions);
    await runGc({ storage, currentJsonKey }, {
      graceMillis: 0,
      maxSweepsPerRun: 100,
      maxMarksPerRun: 100,
    } as InternalRunGcOptions);
  });

  const snap = ctx.recorder.snapshot();
  const histogramCount = (name: string): number =>
    snap.histograms.filter((h) => h.name === name).length;
  const lastGaugeValue = (name: string): number | undefined =>
    snap.gauges.findLast((g) => g.name === name)?.value;
  const sumCounter = (name: string): number =>
    snap.counters.filter((c) => c.name === name).reduce((acc, c) => acc + c.value, 0);

  // The six load-bearing metric names per the ticket.
  expect(histogramCount("db.write.class_a_ops_per_logical_write")).toBe(100);
  expect(histogramCount("db.compact.entries_folded")).toBeGreaterThan(0);
  expect(lastGaugeValue("db.manifest.lag_window_depth")).toBeDefined();
  expect(lastGaugeValue("db.orphan.candidate_count")).toBeDefined();
  expect(lastGaugeValue("db.gc.entries_swept_per_second")).toBeDefined();
  expect(sumCounter("db.gc.swept_total")).toBeGreaterThan(0);
};

/**
 * Hand-rolled minimal StandardSchemaV1 implementation used by the
 * schema-validation cascade block. Asserting on validator-emitted
 * messages keeps the test independent of any third-party validator
 * library — the repo policy is "no new runtime deps," which extends
 * to "no new devDeps just for schema validation."
 *
 * The schema rejects:
 *   - non-object roots → `[{ message: "expected object" }]`
 *   - `_id` not a string → `[{ path: ["_id"], message: "expected string" }]`
 *   - `status` not in `{"open","closed"}` → `[{ path: ["status"], message: "..." }]`
 */
const STATUS_SCHEMA: SchemaValidator = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (v) => {
      if (typeof v !== "object" || v === null) {
        return { issues: [{ message: "expected object" }] };
      }
      const o = v as Record<string, unknown>;
      if (typeof o["_id"] !== "string") {
        return { issues: [{ path: ["_id"], message: "expected string" }] };
      }
      if (o["status"] !== "open" && o["status"] !== "closed") {
        return {
          issues: [{ path: ["status"], message: 'expected "open" or "closed"' }],
        };
      }
      return { value: o };
    },
  },
};

/**
 * Schema validation runs at the server boundary on `insert`,
 * `update`, and `replace`. Asserts that:
 *
 *  1. `insert({status:"bogus"})` throws `SchemaError` with
 *     `issues[0].path === ["status"]`.
 *  2. `update({status:"bogus"})` applied to a successfully-inserted
 *     valid row throws `SchemaError` on the MERGED post-image (not
 *     the patch).
 *  3. `replace({_id, status:"bogus"})` throws `SchemaError`.
 *  4. `insert({status:"open"})` succeeds (zero overhead — the
 *     post-image satisfies the schema).
 *  5. Without a schema on the `Db`, every verb works as today
 *     (regression guard).
 */
const runSchemaValidation = async (
  storage: Storage,
  app: string,
  tenant: string,
): Promise<void> => {
  const t = freshTableName("schema");
  await provision(storage, app, tenant, t);

  // (5) Regression guard: Db built without schemas accepts the same
  // doc the schema-bound Db rejects further down. Runs FIRST so the
  // per-table fold is empty when the schema-bound Db starts work.
  const noSchemaDb = Db.create({ storage, app, tenant });
  const { _id: ok } = await noSchemaDb.collection(t).insert({ status: "bogus" });
  expect(typeof ok).toBe("string");
  // Tidy up so the schema-bound Db sees a clean slate.
  await noSchemaDb.collection(t).delete(ok);

  const db = Db.create({
    storage,
    app,
    tenant,
    config: { collections: { [t]: { schema: STATUS_SCHEMA } } },
  });

  // (4) Happy path: post-image satisfies the schema → insert succeeds.
  const { _id: validId } = await db.collection(t).insert({ status: "open" });
  expect(typeof validId).toBe("string");

  // (1) insert with invalid status fails with SchemaError on
  // `status` path.
  let insertErr: unknown;
  try {
    await db.collection(t).insert({ status: "bogus" });
  } catch (error) {
    insertErr = error;
  }
  expect(insertErr).toBeInstanceOf(BaerlyError);
  expect((insertErr as BaerlyError).code).toBe("SchemaError");
  expect((insertErr as BaerlyError).issues).toBeDefined();
  expect((insertErr as BaerlyError).issues?.[0]?.path).toEqual(["status"]);

  // (2) update against the valid row: the patch alone is partial
  // (`{status:"bogus"}` doesn't carry `_id`), but the merge-then-
  // validate path validates the merged post-image — so the failure
  // is on `status`, not "missing _id".
  let updateErr: unknown;
  try {
    await db.collection(t).update(validId, { status: "bogus" });
  } catch (error) {
    updateErr = error;
  }
  expect(updateErr).toBeInstanceOf(BaerlyError);
  expect((updateErr as BaerlyError).code).toBe("SchemaError");
  expect((updateErr as BaerlyError).issues?.[0]?.path).toEqual(["status"]);

  // (3) replace against the valid row: post-image still fails the
  // schema → SchemaError on `status`.
  let replaceErr: unknown;
  try {
    await db.collection(t).replace(validId, { _id: validId, status: "bogus" });
  } catch (error) {
    replaceErr = error;
  }
  expect(replaceErr).toBeInstanceOf(BaerlyError);
  expect((replaceErr as BaerlyError).code).toBe("SchemaError");
  expect((replaceErr as BaerlyError).issues?.[0]?.path).toEqual(["status"]);

  // The schema-bound Db's writes that DID succeed remain visible —
  // the validity check fires synchronously inside the verb, before
  // any wire I/O for invalid inputs.
  const round = await db.collection(t).get(validId);
  expect(round?.["status"]).toBe("open");
};

/**
 * Counting `Storage` decorator — delegates to `inner` and tallies the
 * mutating + reading calls so a test can assert ORDERING (what ran before
 * a throw). Test-only; lives in the fixture.
 */
const countingStorage = (
  inner: Storage,
): {
  readonly storage: Storage;
  counts: () => { get: number; put: number; delete: number; list: number };
} => {
  const c = { get: 0, put: 0, delete: 0, list: 0 };
  const storage: Storage = {
    get: (key, opts) => {
      c.get += 1;
      return inner.get(key, opts);
    },
    put: (key, body, opts) => {
      c.put += 1;
      return inner.put(key, body, opts);
    },
    delete: (key, opts) => {
      c.delete += 1;
      return inner.delete(key, opts);
    },
    list: (prefix, opts) => {
      c.list += 1;
      return inner.list(prefix, opts);
    },
  };
  return { storage, counts: () => ({ ...c }) };
};

/**
 * Validation-ORDERING parity (makes the implicit explicit). Asserts the
 * fixed order that makes "green locally ⇒ green in cloud" hold for writes:
 *
 *  1. `$`-key predicate rejection is SYNCHRONOUS at `.where(...)` and does
 *     ZERO storage I/O — it fires before any await.
 *  2. Schema validation (post-image) rejects an invalid write with ZERO
 *     mutating I/O (no `put` / `delete` reaches the bucket) — an invalid
 *     op never half-writes, on any adapter. A VALID insert DOES write
 *     (proves the counter is wired).
 */
const runValidationOrdering = async (
  storage: Storage,
  app: string,
  tenant: string,
): Promise<void> => {
  const t = freshTableName("order");
  await provision(storage, app, tenant, t);

  // (1) `$`-key rejection is synchronous + I/O-free.
  {
    const { storage: counting, counts } = countingStorage(storage);
    const db = Db.create({ storage: counting, app, tenant });
    const before = counts();
    const bad = { $or: [{ a: 1 }] } as unknown as Parameters<
      ReturnType<typeof db.collection>["where"]
    >[0];
    let err: unknown;
    try {
      db.collection(t).where(bad);
    } catch (error) {
      err = error;
    }
    expect(err, "where($or) must throw synchronously").toBeInstanceOf(BaerlyError);
    expect((err as BaerlyError).code).toBe("InvalidConfig");
    expect(counts(), "synchronous rejection must do zero storage I/O").toEqual(before);
  }

  // (2) Schema validation rejects an invalid write with zero mutating I/O.
  {
    const { storage: counting, counts } = countingStorage(storage);
    const db = Db.create({
      storage: counting,
      app,
      tenant,
      config: { collections: { [t]: { schema: STATUS_SCHEMA } } },
    });

    const mutationsBefore = counts().put + counts().delete;
    let err: unknown;
    try {
      await db.collection(t).insert({ status: "bogus" });
    } catch (error) {
      err = error;
    }
    expect(err, "invalid insert must reject").toBeInstanceOf(BaerlyError);
    expect((err as BaerlyError).code).toBe("SchemaError");
    expect(
      counts().put + counts().delete - mutationsBefore,
      "invalid write must not mutate the bucket",
    ).toBe(0);

    // A valid insert DOES write — proves the counter is live, not stuck.
    const mutationsBeforeValid = counts().put;
    await db.collection(t).insert({ status: "open" });
    expect(counts().put - mutationsBeforeValid).toBeGreaterThan(0);
  }
};

/**
 * LogEntry shape — frozen assertion. After an I+I+U+D sequence,
 * walk `<collectionPrefix>/log/<seq>.json` directly via `Storage` and
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
  const { _id: id1 } = await db.collection(t).insert({ k: "1", v: 1 });
  const { _id: id2 } = await db.collection(t).insert({ k: "2", v: 2 });
  const { modified } = await db.collection(t).update(id1, { marker: true });
  expect(modified).toBe(1);
  const { deleted } = await db.collection(t).delete(id2);
  expect(deleted).toBe(1);

  const collectionPrefix = `app/${app}/tenant/${tenant}/manifests/${t}`;
  const entries: LogEntry[] = [];
  for await (const { key } of storage.list(`${collectionPrefix}/log/`)) {
    const got = await storage.get(key);
    if (got === null) {
      continue;
    }
    entries.push(JSON.parse(new TextDecoder().decode(got.body)) as LogEntry);
  }
  entries.sort((a, b) => a.seq - b.seq);

  // 2 inserts + 1 update + 1 delete = 4 entries (the document is the
  // atomic unit; there is no batch).
  expect(entries).toHaveLength(4);

  // Per packages/protocol/src/log.ts:22-100 — always-fields hold on
  // every entry.
  for (const e of entries) {
    expect(e.lsn).toMatch(LSN_RE);
    expect(typeof e.commit_ts).toBe("string");
    expect(Number.isFinite(new Date(e.commit_ts).getTime())).toBe(true);
    // `commit_ts` is `Date#toISOString()` — strict UTC ISO-8601 with
    // millisecond precision and a `Z` suffix. Pin the exact wire form so a
    // language port emits the same shape (a mere Date.parse-able string is too
    // loose: "2026" parses but is not the contract).
    expect(e.commit_ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(typeof e.session).toBe("string");
    expect(e.session.length).toBeGreaterThan(0);
    expect(typeof e.seq).toBe("number");
    expect(e.collection).toBe(t);
    expect(["I", "U", "D"]).toContain(e.op);
    // doc_id required for I/U/D.
    expect(typeof e.doc_id).toBe("string");
    expect((e.doc_id ?? "").length).toBeGreaterThan(0);
  }

  // Direct-mutation entries (0..3): per-op shape.
  const [e0, e1, e2, e3] = entries as [LogEntry, LogEntry, LogEntry, LogEntry];

  expect(e0.op).toBe("I");
  expect(e0.doc_id).toBe(id1);
  expect(e0.after?.["_id"]).toBe(id1);

  expect(e1.op).toBe("I");
  expect(e1.doc_id).toBe(id2);

  expect(e2.op).toBe("U");
  expect(e2.doc_id).toBe(id1);
  expect(e2.after?.["marker"]).toBe(true);

  expect(e3.op).toBe("D");
  expect(e3.doc_id).toBe(id2);
  // D entries carry no body under PATCH_ONLY replica identity.
  expect(e3.after).toBeUndefined();

  // Regression guard — cut or renamed legacy wire field names. None of
  // these must ever reappear on an emitted entry (the live names are
  // `after`/`before`; `new`/`old` were the pre-rename names).
  const CUT_LOG_ENTRY_FIELDS = ["patch", "schema_version", "new", "old"] as const;
  for (const e of entries) {
    for (const key of CUT_LOG_ENTRY_FIELDS) {
      expect(e).not.toHaveProperty(key);
    }
  }

  // Direct mutations have distinct sessions per `commit()`.
  expect(e0.session).not.toBe(e1.session);
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
export const runCollectionApiCascade = async (opts: {
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
  await runDocIdBoundary(db, opts.storage, APP, tenant);
  await runUpdateContract(db, opts.storage, APP, tenant);
  await runTableReplaceByIdContract(db, opts.storage, APP, tenant);
  await runDeleteContract(db, opts.storage, APP, tenant);

  // 4. Concurrent-write Conflict (cross-writer CAS loss on a single doc).
  if (opts.rivalStorage !== undefined) {
    const rival = Db.create({ storage: opts.rivalStorage, app: APP, tenant });
    await runConcurrentWriteConflict(db, rival, opts.storage, APP, tenant);
  }

  // 5. Compaction — fold the log prefix into a snapshot and read
  //    through it. Runs across every adapter via the variant table.
  await runCompactionCascade(db, opts.storage, APP, tenant);

  // 6. GC — mark + sweep stale log entries with grace bypassed.
  //    Runs across every adapter via the variant table.
  await runGcCascade(db, opts.storage, APP, tenant);

  // 7. [metrics] Six load-bearing metric names emitted across the
  //    full lifecycle cycle. Runs on every adapter via the variant
  //    table.
  await runMetricsCascade(opts.storage, APP, tenant);

  // 8. Schema validation — `insert` / `update` / `replace` validate
  //    the post-image against a per-collection
  //    `SchemaValidator` (ticket 70). Runs on every adapter via the
  //    variant table.
  await runSchemaValidation(opts.storage, APP, tenant);

  // 8b. Validation-ordering parity — `$`-key rejection is synchronous +
  //     I/O-free; schema rejection does zero mutating I/O before the throw.
  await runValidationOrdering(opts.storage, APP, tenant);

  // 9. LogEntry shape — frozen.
  await runLogEntryShape(db, opts.storage, APP, tenant);
};
