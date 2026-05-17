/**
 * Observability cross-check.
 *
 * The canonical log line's `db.storage.class_a_ops_total` and
 * `db.storage.class_b_ops_total` are the load-bearing fields for
 * the cost-model story (see `docs/guide/observability.md` and
 * `docs/about/cost-model.md`). This test proves they match physical
 * reality: a workload that performs N PUTs + M DELETEs + L LISTs
 * against the underlying `Storage` must emit a canonical line
 * with `class_a_ops_total = N + M + L`, and likewise for class B
 * (GETs).
 *
 * Method:
 *
 * 1. Build a counting `Storage` proxy over `MemoryStorage` that
 *    counts every PUT / DELETE / LIST / GET as a physical op.
 *    `LIST` is counted once per kicked-off iterable regardless of
 *    how many entries it yields — matches the S3 pricing model
 *    (one ListObjectsV2 request = one Class A op even with
 *    multiple keys in the response page).
 * 2. Wrap the proxy with `observableStorage(proxy, recorder)` so
 *    the recorder sees the same physical events from the kernel's
 *    side.
 * 3. Drive the workload inside `runWithContext(ctx, ...)` with an
 *    `alsAwareRecorder` so the per-request bag (`ctx.recorder`)
 *    fills.
 * 4. Call `flushCanonicalLine` and inspect the emitted record's
 *    `db.storage.class_a_ops_total` / `class_b_ops_total`.
 * 5. Assert: canonical-line totals === physical proxy totals.
 *
 * If this gate ever fails the canonical line is lying about the
 * deployment's cost shape; treat as P0.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reset, type LogRecord, type Sink } from "@logtape/logtape";
import {
  BaerlyError,
  CURRENT_JSON_SCHEMA_VERSION,
  MemoryStorage,
  createCurrentJson,
  noopMetricsRecorder,
  type JSONArraylessObject,
  type Storage,
  type StorageGetOptions,
  type StorageGetResult,
  type StorageListEntry,
  type StoragePutOptions,
  type StoragePutResult,
} from "@baerly/protocol";
import { Db } from "@baerly/server";
import {
  alsAwareRecorder,
  configureObservability,
  createObservabilityContext,
  flushCanonicalLine,
  observableStorage,
  runWithContext,
  type ObservabilityContext,
} from "@baerly/server/observability";

const APP = "app";
const TENANT = "tenant";
const COLLECTION = "tickets";
const TABLE_PREFIX = `app/${APP}/tenant/${TENANT}/manifests/${COLLECTION}`;
const CURRENT_JSON_KEY = `${TABLE_PREFIX}/current.json`;

interface Ticket extends JSONArraylessObject {
  _id: string;
  status: "open" | "closed";
  priority: number;
}

/**
 * Counting `Storage` proxy. Mirrors the pattern in
 * `tests/integration/phase5-end-to-end.test.ts` but exposes per-op
 * counts so we can assert against the canonical line's per-op
 * breakdown as well as the aggregate class-A / class-B totals.
 *
 * `LIST` counts once per call regardless of how many entries the
 * iterable yields — that's the S3 / R2 pricing model (one
 * ListObjectsV2 request = one Class A op even if it returns many
 * pages-worth of keys in a single response).
 */
interface CountingProxy {
  readonly storage: Storage;
  readonly counts: {
    get: number;
    put: number;
    delete: number;
    list: number;
  };
}

const countingProxy = (inner: Storage): CountingProxy => {
  const counts = { get: 0, put: 0, delete: 0, list: 0 };
  const storage: Storage = {
    get: (key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> => {
      counts.get++;
      return inner.get(key, opts);
    },
    put: (key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult> => {
      counts.put++;
      return inner.put(key, body, opts);
    },
    delete: (key: string, opts?: { signal?: AbortSignal }): Promise<void> => {
      counts.delete++;
      return inner.delete(key, opts);
    },
    list: (
      prefix: string,
      opts?: { startAfter?: string; maxKeys?: number; signal?: AbortSignal },
    ): AsyncIterable<StorageListEntry> => {
      counts.list++;
      return inner.list(prefix, opts);
    },
  };
  return { storage, counts };
};

const bootstrap = async (storage: Storage): Promise<void> => {
  await createCurrentJson(storage, CURRENT_JSON_KEY, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    next_seq: 0,
    writer_fence: { epoch: 0, owner: "phase9-observability", claimed_at: "" },
  });
};

const collectingSink = (): { records: LogRecord[]; sink: Sink } => {
  const records: LogRecord[] = [];
  const sink: Sink = (record) => records.push(record);
  return { records, sink };
};

const sampledCtx = (): ObservabilityContext => {
  const ctx = createObservabilityContext();
  ctx.sampled_by_head = true;
  return ctx;
};

describe("observability integration — canonical line vs physical reality", () => {
  let records: LogRecord[];
  let sink: Sink;

  beforeEach(async () => {
    ({ records, sink } = collectingSink());
    await configureObservability({ level: "info", sink, sampleRate: 1 });
  });

  afterEach(async () => {
    await reset();
  });

  it("single insert: canonical class_a_ops_total matches physical PUT count", async () => {
    // Bootstrap current.json BEFORE wiring the proxy so the bootstrap
    // PUT isn't counted against the workload. The workload is "the
    // application code", not "the operator's one-time setup".
    const memory = new MemoryStorage();
    await bootstrap(memory);

    const proxy = countingProxy(memory);
    const recorder = alsAwareRecorder(noopMetricsRecorder);
    const wrapped = observableStorage(proxy.storage, recorder);
    const db = Db.create({ storage: wrapped, app: APP, tenant: TENANT, metrics: recorder });

    const ctx = sampledCtx();
    await runWithContext(ctx, async () => {
      await db.table<Ticket>(COLLECTION).insert({
        _id: "t-0001",
        status: "open",
        priority: 1,
      });
    });
    flushCanonicalLine(ctx, ctx.recorder, {
      unit: "http",
      outcome: "ok",
      status: 200,
    });

    expect(records).toHaveLength(1);
    const props = records[0]!.properties;

    // Physical class A = PUT + DELETE + LIST. Physical class B = GET.
    const physicalA = proxy.counts.put + proxy.counts.delete + proxy.counts.list;
    const physicalB = proxy.counts.get;

    // The canonical line's reported totals are the load-bearing
    // assertion. Per-op breakdown checked separately for diagnostic
    // clarity when a regression flips one but not the others.
    expect(props["db.storage.class_a_ops_total"]).toBe(physicalA);
    expect(props["db.storage.class_b_ops_total"]).toBe(physicalB);
    expect(props["db.storage.put.calls_total"]).toBe(proxy.counts.put);
    expect(props["db.storage.get.calls_total"]).toBe(proxy.counts.get);

    // Sanity: a fresh-bucket single insert through Db.table().insert()
    // performs exactly 3 PUTs (content + log entry + current.json
    // CAS-advance). No DELETEs / no LISTs (no indexes declared, no
    // stale-key fixups). The _id-collision precheck and the writer's
    // log-integrity walk are GET-only. If this count drifts a regression
    // in the writer changed the per-write physical-op shape; investigate
    // before relaxing the literal.
    expect(proxy.counts.put).toBe(3);
    expect(proxy.counts.delete).toBe(0);
    expect(proxy.counts.list).toBe(0);
  });

  it("transaction with 3 inserts: canonical line tracks commitBatch's physical PUTs", async () => {
    const memory = new MemoryStorage();
    await bootstrap(memory);

    const proxy = countingProxy(memory);
    const recorder = alsAwareRecorder(noopMetricsRecorder);
    const wrapped = observableStorage(proxy.storage, recorder);
    const db = Db.create({ storage: wrapped, app: APP, tenant: TENANT, metrics: recorder });

    const ctx = sampledCtx();
    await runWithContext(ctx, async () => {
      await db.transaction<Ticket>(COLLECTION, async (tx) => {
        await tx.insert({ _id: "t-1", status: "open", priority: 1 });
        await tx.insert({ _id: "t-2", status: "open", priority: 2 });
        await tx.insert({ _id: "t-3", status: "closed", priority: 3 });
      });
    });
    flushCanonicalLine(ctx, ctx.recorder, {
      unit: "http",
      outcome: "ok",
      status: 200,
    });

    expect(records).toHaveLength(1);
    const props = records[0]!.properties;

    const physicalA = proxy.counts.put + proxy.counts.delete + proxy.counts.list;
    const physicalB = proxy.counts.get;

    expect(props["db.storage.class_a_ops_total"]).toBe(physicalA);
    expect(props["db.storage.class_b_ops_total"]).toBe(physicalB);
    expect(props["db.storage.put.calls_total"]).toBe(proxy.counts.put);

    // Transaction via commitBatch: 3 content PUTs + 3 log entry PUTs
    // + 1 current.json CAS-advance = 7 PUTs. Insert-time _id-collision
    // checks (inside the tx body) are GET-only (no LIST, no PUT). No
    // DELETEs (all inserts, no stale-key fixups, no indexes). If this
    // count drifts a regression in `commitBatch` changed the per-batch
    // physical-op shape; investigate before relaxing the literal.
    expect(proxy.counts.put).toBe(7);
    expect(proxy.counts.delete).toBe(0);
    expect(proxy.counts.list).toBe(0);
  });

  it("duplicate-_id Conflict emits an error-level line with the canonical totals", async () => {
    const memory = new MemoryStorage();
    await bootstrap(memory);

    const proxy = countingProxy(memory);
    const recorder = alsAwareRecorder(noopMetricsRecorder);
    const wrapped = observableStorage(proxy.storage, recorder);
    const db = Db.create({ storage: wrapped, app: APP, tenant: TENANT, metrics: recorder });

    // Seed one doc OUTSIDE the observed window so the seed's physical
    // ops don't pollute the assertion. The retry / collision path
    // is what's under test — the in-bucket pre-state isn't.
    await db.table<Ticket>(COLLECTION).insert({
      _id: "t-dup",
      status: "open",
      priority: 1,
    });

    // Reset counts so the assertion targets only the second (failing)
    // insert.
    proxy.counts.get = 0;
    proxy.counts.put = 0;
    proxy.counts.delete = 0;
    proxy.counts.list = 0;

    const ctx = sampledCtx();
    let caught: unknown;
    try {
      await runWithContext(ctx, async () => {
        // Duplicate `_id` — Query.insert's pre-commit collision
        // precondition throws BaerlyError{code:"Conflict"} BEFORE
        // issuing a writer commit. The failing precondition is a
        // GET-only path; we assert the canonical line still tracks
        // the exact physical-op count.
        await db.table<Ticket>(COLLECTION).insert({
          _id: "t-dup",
          status: "closed",
          priority: 2,
        });
      });
    } catch (err) {
      caught = err;
    }
    flushCanonicalLine(ctx, ctx.recorder, {
      unit: "http",
      outcome: "conflict",
      status: 409,
      error: caught,
    });

    expect(caught).toBeInstanceOf(BaerlyError);
    expect((caught as BaerlyError).code).toBe("Conflict");

    expect(records).toHaveLength(1);
    const record = records[0]!;
    const props = record.properties;
    // Level mapping: any thrown error escalates to `error` level,
    // overriding the 409 → warn mapping.
    expect(record.level).toBe("error");
    expect(props["outcome"]).toBe("conflict");
    const err = props["error"] as { code: string };
    expect(err.code).toBe("Conflict");

    const physicalA = proxy.counts.put + proxy.counts.delete + proxy.counts.list;
    const physicalB = proxy.counts.get;

    // The load-bearing assertion: canonical totals === physical totals.
    expect(props["db.storage.class_a_ops_total"] ?? 0).toBe(physicalA);
    expect(props["db.storage.class_b_ops_total"] ?? 0).toBe(physicalB);

    // The collision precondition is the only physical I/O before the
    // Conflict throw: zero PUTs, zero DELETEs. The class A total may
    // be zero (GET-only path) — if it ever flips non-zero, the read
    // path took a LIST and the cost-model story needs updating.
    expect(proxy.counts.put).toBe(0);
    expect(proxy.counts.delete).toBe(0);
  });

  it("emits zero canonical lines when sampling is off and the unit succeeds", async () => {
    const memory = new MemoryStorage();
    await bootstrap(memory);

    const proxy = countingProxy(memory);
    const recorder = alsAwareRecorder(noopMetricsRecorder);
    const wrapped = observableStorage(proxy.storage, recorder);
    const db = Db.create({ storage: wrapped, app: APP, tenant: TENANT, metrics: recorder });

    // Default head-sampling decision is `false`; without
    // `sampled_by_head = true` the flusher should drop the line.
    const ctx = createObservabilityContext();
    await runWithContext(ctx, async () => {
      await db.table<Ticket>(COLLECTION).insert({
        _id: "t-drop",
        status: "open",
        priority: 1,
      });
    });
    flushCanonicalLine(ctx, ctx.recorder, {
      unit: "http",
      outcome: "ok",
      status: 200,
    });

    expect(records).toHaveLength(0);
    // The work still happened; sampling only suppresses the log line.
    expect(proxy.counts.put).toBe(3);
  });
});
