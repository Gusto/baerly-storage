/* eslint-disable no-underscore-dangle -- `__BAERLY_R2_BINDING__` is the
   miniflare-pool ↔ test contract (set by `tests/setup/r2-binding.ts`);
   `_id` is the locked primary-key field on document shapes. */

/**
 * In-band write-tick maintenance wiring for the Cloudflare adapter.
 *
 * Runs under the `cloudflare-pool` vitest project (workerd + miniflare)
 * so `ExecutionContext` resolves and `ctx.waitUntil` behaves like the
 * platform: the task is enqueued during the request and drained AFTER
 * the response. These tests pin the four CF-specific contracts:
 *
 *   1. `cfMaintenanceDispatch` reads `BAERLY_MAINTENANCE_*` off the
 *      `env` binding (strings) and threads CF-free caps +
 *      `phasesPerTick: "single"` + `dispatch = ctx.waitUntil`.
 *   2. A real fold lands under the CF free-tier 50-subrequest budget
 *      and advances `log_seq_start` by the per-pass slice.
 *   3. `db.compaction.cas_lost_total` records from INSIDE the
 *      `waitUntil` continuation — the ALS store survives past the
 *      response.
 *   4. An over-raised `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` (above
 *      `CF_FREE_MAX_SAFE_FOLD_BYTES`) warns LOUDLY once at handler init.
 */

import {
  type BaerlyAppConfig,
  CF_FREE_MAX_SAFE_FOLD_BYTES,
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  type Storage,
  type Verifier,
  WRITE_TICK_FOLD_ENTRIES_PER_PASS,
  WRITE_TICK_GC_INTERVAL,
  WRITE_TICK_GC_MAX_MARKS,
  WRITE_TICK_GC_MAX_SWEEPS,
} from "@baerly/protocol";
import { runBoundedMaintenance } from "@baerly/server/maintenance";
import {
  createObservabilityContext,
  getCurrentContext,
  runWithContext,
} from "@baerly/server/observability";
import { Writer } from "@baerly/server/_internal/testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import { wrapCountingStorage } from "../../../tests/fixtures/counting-storage.ts";
import { r2BindingStorage } from "./r2-binding-storage.ts";
import { baerlyWorker, type BaerlyEnv, cfMaintenanceDispatch } from "./worker.ts";

const testConfig: BaerlyAppConfig = {
  app: "test-app",
  tenant: "test-tenant",
  target: "cloudflare",
  auth: "none",
  collections: {},
};

const getBinding = (): R2Bucket => {
  const bucket = (globalThis as { __BAERLY_R2_BINDING__?: R2Bucket }).__BAERLY_R2_BINDING__;
  if (bucket === undefined) {
    throw new Error("worker-maintenance.test: globalThis.__BAERLY_R2_BINDING__ missing");
  }
  return bucket;
};

const KEY = (tenant: string): string => `app/t/tenant/${tenant}/manifests/c/current.json`;

const provision = async (storage: Storage, tenant: string): Promise<void> => {
  await createCurrentJson(storage, KEY(tenant), {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    next_seq: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "maint-test", claimed_at: "" },
    tail_bytes: 0,
    snapshot_bytes: 0,
    snapshot_rows: 0,
  });
};

/**
 * Seed `n` real log entries via the kernel Writer WITHOUT folding the
 * tail. The Writer maintains in-band by default, so we run the seed
 * under a `maintenance: { disabled: true }` context — otherwise the seed
 * loop would fold incrementally and leave no foldable tail to exercise.
 */
const seedTail = async (storage: Storage, key: string, n: number): Promise<void> => {
  const writer = new Writer({ storage, currentJsonKey: key });
  const noMaint = createObservabilityContext({ maintenance: { disabled: true } });
  await runWithContext(noMaint, async () => {
    for (let i = 0; i < n; i++) {
      await writer.commit({
        op: "I",
        collection: "c",
        docId: `d${i}`,
        // Pad the body so the tail clears MAINTENANCE_MIN_LIVE_BYTES and
        // the ratio gate trips, while staying far under the fold ceiling.
        body: { _id: `d${i}`, n: i, pad: "x".repeat(800) },
      });
    }
  });
};

/**
 * An `ExecutionContext` whose `waitUntil` COLLECTS the continuation
 * promise instead of running it eagerly. Tests drain it explicitly
 * AFTER `handler.fetch` resolves — that's exactly the platform's
 * post-response continuation, where an ALS-lifetime mistake would
 * silently degrade `getCurrentContext()` to `undefined`.
 */
const makeCollectingCtx = (): { ctx: ExecutionContext; drain: () => Promise<void> } => {
  const collected: Array<Promise<unknown>> = [];
  const ctx: ExecutionContext = {
    waitUntil(p: Promise<unknown>): void {
      collected.push(Promise.resolve(p));
    },
    passThroughOnException(): void {},
    props: {},
  };
  return {
    ctx,
    drain: async (): Promise<void> => {
      await Promise.all(collected);
    },
  };
};

const tenantId = (label: string): string =>
  `${label}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

describe("cfMaintenanceDispatch", () => {
  test("threads ctx.waitUntil + CF-free caps + phasesPerTick:single, no env", () => {
    const ctx: ExecutionContext = {
      waitUntil(p: Promise<unknown>): void {
        void p;
      },
      passThroughOnException(): void {},
      props: {},
    };
    const m = cfMaintenanceDispatch(ctx, () => undefined);

    // The dispatch hands the task to ctx.waitUntil — fire-and-forget
    // off the ack. We assert by spying on waitUntil.
    const spy = vi.spyOn(ctx, "waitUntil");
    m.dispatch?.(async () => {});
    expect(spy).toHaveBeenCalledTimes(1);

    // No env → neither kill switch nor ceiling override.
    expect(m.disabled).toBeUndefined();
    expect(m.maxFoldBytes).toBeUndefined();

    // CF free-tier shape: single phase per tick (a CPU-killable isolate
    // does ONE of fold/GC per request), and the TESTED CF-free caps.
    expect(m.options?.phasesPerTick).toBe("single");
    expect(m.options?.profile?.maxFoldEntriesPerPass).toBe(WRITE_TICK_FOLD_ENTRIES_PER_PASS);
    expect(m.options?.profile?.gcMaxMarks).toBe(WRITE_TICK_GC_MAX_MARKS);
    expect(m.options?.profile?.gcMaxSweeps).toBe(WRITE_TICK_GC_MAX_SWEEPS);
    expect(m.options?.profile?.gcInterval).toBe(WRITE_TICK_GC_INTERVAL);
  });

  test("threads BAERLY_MAINTENANCE_MAX_FOLD_BYTES off the env binding (a low ceiling reaches the runner)", () => {
    const ctx: ExecutionContext = {
      waitUntil(): void {},
      passThroughOnException(): void {},
      props: {},
    };
    const m = cfMaintenanceDispatch(ctx, (k) =>
      k === "BAERLY_MAINTENANCE_MAX_FOLD_BYTES" ? "4096" : undefined,
    );
    expect(m.maxFoldBytes).toBe(4096);
  });

  test("ignores a non-numeric BAERLY_MAINTENANCE_MAX_FOLD_BYTES", () => {
    const ctx: ExecutionContext = {
      waitUntil(): void {},
      passThroughOnException(): void {},
      props: {},
    };
    const m = cfMaintenanceDispatch(ctx, (k) =>
      k === "BAERLY_MAINTENANCE_MAX_FOLD_BYTES" ? "not-a-number" : undefined,
    );
    expect(m.maxFoldBytes).toBeUndefined();
  });

  test("threads BAERLY_MAINTENANCE_DISABLE off the env binding; treats falsy values as not-disabled", () => {
    const ctx: ExecutionContext = {
      waitUntil(): void {},
      passThroughOnException(): void {},
      props: {},
    };
    expect(
      cfMaintenanceDispatch(ctx, (k) => (k === "BAERLY_MAINTENANCE_DISABLE" ? "1" : undefined))
        .disabled,
    ).toBe(true);
    for (const raw of ["0", "false", ""]) {
      expect(
        cfMaintenanceDispatch(ctx, (k) => (k === "BAERLY_MAINTENANCE_DISABLE" ? raw : undefined))
          .disabled,
      ).toBeUndefined();
    }
  });
});

describe("write-tick fold under the CF free-tier subrequest budget", () => {
  test("a real fold lands without exceeding 50 subrequests and advances log_seq_start by the per-pass slice", async () => {
    const bucket = getBinding();
    const tenant = tenantId("fold");
    const inner = r2BindingStorage(bucket);
    await provision(inner, tenant);

    // Seed a tail of >= 100 entries (NO inline fold during seeding), then
    // run ONE bounded maintenance pass with the CF-free caps the adapter
    // threads. (Driving 100 POSTs through the handler is the same fold but
    // far slower; the dispatch CONFIG is what we're pinning here.)
    await seedTail(inner, KEY(tenant), 110);

    const before = (await inner.get(KEY(tenant)))!;
    const beforeJson = JSON.parse(new TextDecoder().decode(before.body)) as {
      log_seq_start: number;
    };
    expect(beforeJson.log_seq_start).toBe(0);

    // One bounded pass with the EXACT config the CF adapter threads.
    const counting = wrapCountingStorage(inner);
    const noopCtx: ExecutionContext = {
      waitUntil(): void {},
      passThroughOnException(): void {},
      props: {},
    };
    const m = cfMaintenanceDispatch(noopCtx, () => undefined);
    await runBoundedMaintenance(
      { storage: counting.storage, currentJsonKey: KEY(tenant), prevSeq: 110 },
      m.options,
    );

    // (a) Stays under the CF free-tier 50-subrequest budget.
    expect(counting.classAOps).toBeLessThanOrEqual(50);

    // (b) Folded the per-pass slice — log_seq_start advanced by
    // maxFoldEntriesPerPass (= WRITE_TICK_FOLD_ENTRIES_PER_PASS = 20),
    // draining the 110-entry tail incrementally rather than all at once.
    const after = (await inner.get(KEY(tenant)))!;
    const afterJson = JSON.parse(new TextDecoder().decode(after.body)) as {
      log_seq_start: number;
    };
    expect(afterJson.log_seq_start).toBe(WRITE_TICK_FOLD_ENTRIES_PER_PASS);
    expect(afterJson.log_seq_start).toBeLessThan(110);
  });
});

describe("cas_lost_total records from inside the waitUntil continuation", () => {
  test("a CAS-lost fold dispatched via ctx.waitUntil still increments db.compaction.cas_lost_total", async () => {
    const realBucket = getBinding();
    const tenant = tenantId("caslost");

    // Wrap the R2 BINDING (not the Storage) so the handler's own
    // `r2BindingStorage(env.BUCKET)` routes every op through it. We:
    //   (a) capture the per-request recorder via ALS from inside a
    //       storage op (proves the ALS store survives into waitUntil), and
    //   (b) force the fold's current.json CAS PUT to lose EXACTLY once —
    //       R2 signals a failed `onlyIf.etagMatches` precondition by
    //       returning `null`, which `r2BindingStorage` maps to a
    //       `Conflict`; the compactor's cas-lost branch then fires.
    type Recorder = NonNullable<ReturnType<typeof getCurrentContext>>["recorder"];
    let capturedRecorder: Recorder | undefined;
    let armed = false; // only fail the CAS for the handler's write-tick, not the seed
    let failedFoldCasOnce = false;
    const racingBucket = new Proxy(realBucket, {
      get(target, prop, receiver) {
        if (prop === "put") {
          return async (
            key: string,
            value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
            options?: R2PutOptions,
          ): Promise<R2Object | null> => {
            // Capture whatever recorder the ALS context currently holds.
            const ctx = getCurrentContext();
            if (ctx !== undefined) {
              capturedRecorder = ctx.recorder;
            }
            const isManifestCas =
              key === KEY(tenant) &&
              options?.onlyIf !== undefined &&
              "etagMatches" in (options.onlyIf as Record<string, unknown>);
            if (armed && !failedFoldCasOnce && isManifestCas) {
              failedFoldCasOnce = true;
              // R2 returns null on a precondition miss → Conflict.
              return null;
            }
            return target.put(key, value, options);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as R2Bucket;

    const racingStorage = r2BindingStorage(racingBucket);
    await provision(racingStorage, tenant);
    // Seed a foldable tail (NO inline fold during seeding) so the very
    // next write trips the gate and dispatches the fold.
    await seedTail(racingStorage, KEY(tenant), 100);

    // Drive ONE write through the handler. The writer dispatches the
    // fold via ctx.waitUntil — it runs AFTER the response. The handler's
    // internal `r2BindingStorage(env.BUCKET)` uses our racing binding.
    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });
    const handler = baerlyWorker<BaerlyEnv>(() => ({ config: testConfig, verifier }));
    const env: BaerlyEnv = { BUCKET: racingBucket, APP: "t" };
    const { ctx, drain } = makeCollectingCtx();

    const res = await handler.fetch!(
      new Request("https://x/v1/c/c", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: { _id: "trigger", n: 1, pad: "x".repeat(800) } }),
      }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      ctx,
    );
    expect(res.status).toBe(201);

    // Arm the CAS-loss ONLY now — after the response resolved but BEFORE
    // we drain. The writer's own commit CAS already landed during fetch
    // (above); the only manifest CAS left is the FOLD's, which runs in
    // the waitUntil continuation. This pins the metric to the fold path,
    // not the commit path.
    armed = true;

    // The fold has NOT run yet — it's queued in waitUntil. Drain it now,
    // simulating the platform's post-response continuation.
    await drain();

    expect(capturedRecorder).toBeDefined();
    const casLost = capturedRecorder!
      .snapshot()
      .counters.filter((c) => c.name === "db.compaction.cas_lost_total")
      .reduce((acc, c) => acc + c.value, 0);
    expect(casLost).toBeGreaterThanOrEqual(1);
  });
});

describe("over-raised BAERLY_MAINTENANCE_MAX_FOLD_BYTES warns at init", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a value > CF_FREE_MAX_SAFE_FOLD_BYTES emits a one-time console.warn naming the risk and remedies", async () => {
    const bucket = getBinding();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const verifier: Verifier = async () => ({ tenantPrefix: "warn-t", identity: {} });
    const handler = baerlyWorker<BaerlyEnv>(() => ({ config: testConfig, verifier }));
    const env = {
      BUCKET: bucket,
      APP: "t",
      BAERLY_MAINTENANCE_MAX_FOLD_BYTES: String(CF_FREE_MAX_SAFE_FOLD_BYTES + 1),
    } as unknown as BaerlyEnv;

    const noopCtx: ExecutionContext = {
      waitUntil(): void {},
      passThroughOnException(): void {},
      props: {},
    };
    // Two healthz fetches: the warn must fire EXACTLY once (init-scoped).
    await handler.fetch!(
      new Request("https://x/v1/healthz") as Request<unknown, IncomingRequestCfProperties>,
      env,
      noopCtx,
    );
    await handler.fetch!(
      new Request("https://x/v1/healthz") as Request<unknown, IncomingRequestCfProperties>,
      env,
      noopCtx,
    );

    const maintWarns = warnSpy.mock.calls.filter((args) =>
      String(args[0] ?? "").includes("BAERLY_MAINTENANCE_MAX_FOLD_BYTES"),
    );
    expect(maintWarns).toHaveLength(1);
    const msg = String(maintWarns[0]![0]);
    // Names the risk: a too-large fold gets CPU-killed mid-rebuild and
    // silently never lands.
    expect(msg.toLowerCase()).toContain("cpu");
    // Names the remedies.
    expect(msg.toLowerCase()).toContain("paid");
    expect(msg.toLowerCase()).toContain("node");
  });

  test("a value <= CF_FREE_MAX_SAFE_FOLD_BYTES does NOT warn", async () => {
    const bucket = getBinding();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const verifier: Verifier = async () => ({ tenantPrefix: "nowarn-t", identity: {} });
    const handler = baerlyWorker<BaerlyEnv>(() => ({ config: testConfig, verifier }));
    const env = {
      BUCKET: bucket,
      APP: "t",
      BAERLY_MAINTENANCE_MAX_FOLD_BYTES: String(CF_FREE_MAX_SAFE_FOLD_BYTES),
    } as unknown as BaerlyEnv;

    const noopCtx: ExecutionContext = {
      waitUntil(): void {},
      passThroughOnException(): void {},
      props: {},
    };
    await handler.fetch!(
      new Request("https://x/v1/healthz") as Request<unknown, IncomingRequestCfProperties>,
      env,
      noopCtx,
    );
    const maintWarns = warnSpy.mock.calls.filter((args) =>
      String(args[0] ?? "").includes("BAERLY_MAINTENANCE_MAX_FOLD_BYTES"),
    );
    expect(maintWarns).toHaveLength(0);
  });
});
