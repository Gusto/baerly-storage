/* eslint-disable no-underscore-dangle -- `__BAERLY_R2_BINDING__` is the
   miniflare-pool ↔ test contract (set by `tests/setup/r2-binding.ts`);
   `_id` is the locked primary-key field on document shapes. */

/**
 * In-band write-tick maintenance wiring for the Cloudflare adapter.
 *
 * Runs under the `cloudflare-pool` vitest project (workerd + miniflare)
 * so `ExecutionContext` resolves and `ctx.waitUntil` behaves like the
 * platform: the task is enqueued during the request and drained AFTER
 * the response. These tests pin the five CF-specific contracts:
 *
 *   1. `cfMaintenanceDispatch` reads `BAERLY_MAINTENANCE_*` off the
 *      `env` binding (strings) and threads CF-free caps +
 *      `phasesPerTick: "single"` + `dispatch = ctx.waitUntil`.
 *   2. A real fold over the R2 binding lands at a pinned storage-call
 *      count, charged to the Free request ledger and within its limit
 *      at full retries, and advances `log_seq_start` by the per-pass
 *      slice.
 *   3. `db.compaction.cas_lost_total` records from INSIDE the
 *      `waitUntil` continuation — the ALS store survives past the
 *      response.
 *   4. An over-raised `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` (above
 *      `CF_FREE_MAX_SAFE_FOLD_BYTES`) warns LOUDLY once at handler init
 *      — on the FREE profile only; `cf-paid` carries its own ceiling.
 *   5. An invalid `BAERLY_MAINTENANCE_DISABLE` leaves health/spec green
 *      and fails API requests through the ExportedHandler's exception
 *      path — CF's existing misconfig contract, not Node's envelope.
 */

import {
  type BaerlyAppConfig,
  CF_FREE_FETCH_FOLD_AT_TAIL_ENTRIES,
  CF_FREE_INTERNAL_REQUEST_LIMIT,
  CF_FREE_MAX_SAFE_FOLD_BYTES,
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  MAINTENANCE_MIN_LIVE_BYTES,
  MAINTENANCE_PROFILE_CF_FREE,
  MAINTENANCE_PROFILE_CF_PAID,
  MemoryStorage,
  readCurrentJson,
  type Storage,
  STORAGE_RETRY_MAX_ATTEMPTS,
  type Verifier,
  WRITE_TICK_FOLD_ENTRIES_PER_PASS,
  WRITE_TICK_GC_INTERVAL,
  WRITE_TICK_GC_MAX_MARKS,
  WRITE_TICK_GC_MAX_SWEEPS,
} from "@baerly/protocol";
import { compact } from "@baerly/server/maintenance";
import { runBoundedMaintenance } from "@baerly/server/_internal/maintenance";
import {
  createObservabilityContext,
  getCurrentContext,
  runWithContext,
} from "@baerly/server/observability";
import { Writer } from "@baerly/server/_internal/testing";
import { reset, type LogRecord, type Sink } from "@logtape/logtape";
import { afterEach, describe, expect, test, vi } from "vitest";
import { wrapCountingStorage } from "../../../tests/fixtures/counting-storage.ts";
import { mockExecutionContext } from "../../../tests/fixtures/mock-execution-context.ts";
import {
  FREE_FETCH_CACHE_API_CALLS,
  FREE_FETCH_TICK_OPTIONS,
} from "../../../tests/fixtures/request-count-free-fetch.ts";
import { r2BindingStorage } from "./r2-binding-storage.ts";
import {
  baerlyWorker,
  type BaerlyEnv,
  cfMaintenanceDispatch,
  cfRequestLedger,
  resolveCfMaintenanceProfile,
} from "./worker.ts";

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
    tail_hint: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "maint-test", claimed_at: "" },
    snapshot_bytes: 0,
    snapshot_rows: 0,
  });
};

/**
 * Seed `n` real log entries via the kernel Writer WITHOUT folding the
 * tail. The Writer maintains in-band by default, so we run the seed
 * under a `maintenance: { disabled: true }` context — otherwise the seed
 * loop would fold incrementally and leave no foldable tail to exercise.
 *
 * Under single-write commit the Writer no longer accumulates an exact
 * byte counter, and the ratio TRIGGER reads a DERIVED estimate
 * (`observedTail × mean_entry_bytes`). A freshly-seeded bucket has no
 * stamped `mean_entry_bytes` (the compactor stamps it at the first
 * fold), so it would fall back to the cold-start per-entry constant and
 * under-trigger (correct kernel behaviour — "folds later"). To exercise
 * the fold mechanics deterministically we stamp `mean_entry_bytes` after
 * seeding so the estimate clears the ratio gate — the same migration the
 * default-project maintenance tests use.
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
        // Pad the body so a real fold stays well above the byte floor
        // while remaining far under the fold ceiling.
        body: { _id: `d${i}`, n: i, pad: "x".repeat(800) },
      });
    }
  });
  // Stamp a mean so the DERIVED tail estimate trips the ratio gate
  // (`observedTail × mean ≥ MAINTENANCE_MIN_LIVE_BYTES` for any tail ≥ 1).
  const got = (await storage.get(key))!;
  const cur = JSON.parse(new TextDecoder().decode(got.body)) as Record<string, unknown>;
  cur["mean_entry_bytes"] = MAINTENANCE_MIN_LIVE_BYTES;
  await storage.put(key, new TextEncoder().encode(JSON.stringify(cur)), {
    contentType: "application/json",
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
  const ctx = mockExecutionContext((p) => {
    collected.push(Promise.resolve(p));
  });
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
    const ctx = mockExecutionContext();
    const m = cfMaintenanceDispatch(ctx, () => undefined);

    // The dispatch hands the task to ctx.waitUntil — fire-and-forget
    // off the ack. We assert by spying on waitUntil.
    const spy = vi.spyOn(ctx, "waitUntil");
    m.dispatch?.(async () => {});
    expect(spy).toHaveBeenCalledTimes(1);

    // No env → neither kill switch nor ceiling override.
    expect(m.disabled).toBeUndefined();
    expect(m.maxFoldBytes).toBeUndefined();

    // CF free-tier shape: single phase per tick (a CPU-limited isolate
    // does ONE of fold/GC per request), and the TESTED CF-free caps.
    expect(m.options?.phasesPerTick).toBe("single");
    expect(m.options?.profile?.maxFoldEntriesPerPass).toBe(WRITE_TICK_FOLD_ENTRIES_PER_PASS);
    expect(m.options?.profile?.gcMaxMarks).toBe(WRITE_TICK_GC_MAX_MARKS);
    expect(m.options?.profile?.gcMaxSweeps).toBe(WRITE_TICK_GC_MAX_SWEEPS);
    expect(m.options?.profile?.gcInterval).toBe(WRITE_TICK_GC_INTERVAL);
  });

  test("threads BAERLY_MAINTENANCE_MAX_FOLD_BYTES off the env binding (a low ceiling reaches the runner)", () => {
    const ctx = mockExecutionContext();
    const m = cfMaintenanceDispatch(ctx, (k) =>
      k === "BAERLY_MAINTENANCE_MAX_FOLD_BYTES" ? "4096" : undefined,
    );
    expect(m.maxFoldBytes).toBe(4096);
  });

  test.each(["8mb", "1O24"])(
    "rejects a non-numeric BAERLY_MAINTENANCE_MAX_FOLD_BYTES (%j) with InvalidConfig",
    (raw) => {
      const ctx = mockExecutionContext();
      expect(() =>
        cfMaintenanceDispatch(ctx, (k) =>
          k === "BAERLY_MAINTENANCE_MAX_FOLD_BYTES" ? raw : undefined,
        ),
      ).toThrow(expect.objectContaining({ code: "InvalidConfig" }));
    },
  );

  test("an empty BAERLY_MAINTENANCE_MAX_FOLD_BYTES keeps the profile default", () => {
    const ctx = mockExecutionContext();
    const m = cfMaintenanceDispatch(ctx, (k) =>
      k === "BAERLY_MAINTENANCE_MAX_FOLD_BYTES" ? "" : undefined,
    );
    expect(m.maxFoldBytes).toBeUndefined();
  });

  test("threads BAERLY_MAINTENANCE_DISABLE off the env binding; treats falsy values as not-disabled", () => {
    const ctx = mockExecutionContext();
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

describe("resolveCfMaintenanceProfile — profile selection from BAERLY_MAINTENANCE_PROFILE", () => {
  const makeCtx = (): ExecutionContext => mockExecutionContext();

  test("BAERLY_MAINTENANCE_PROFILE=cf-paid selects the paid profile on the write-tick path", () => {
    const ctx = makeCtx();
    const d = cfMaintenanceDispatch(ctx, (k) =>
      k === "BAERLY_MAINTENANCE_PROFILE" ? "cf-paid" : undefined,
    );
    expect(d.options?.profile).toBe(MAINTENANCE_PROFILE_CF_PAID);
  });

  test.each([undefined, "", "cf-free"])(
    "BAERLY_MAINTENANCE_PROFILE=%j selects cf-free on the write-tick path",
    (raw) => {
      const d = cfMaintenanceDispatch(makeCtx(), (k) =>
        k === "BAERLY_MAINTENANCE_PROFILE" ? raw : undefined,
      );
      expect(d.options?.profile).toBe(MAINTENANCE_PROFILE_CF_FREE);
    },
  );

  // Closed vocabulary: a misspelled profile used to resolve to cf-free
  // silently, leaving a paid Worker on free caps and ceilings.
  const badProfiles = ["garbage", "cf_paid", "CF-PAID", "cf-paid "];

  test.each(badProfiles)(
    "BAERLY_MAINTENANCE_PROFILE=%j throws InvalidConfig on the write-tick path",
    (raw) => {
      expect(() =>
        cfMaintenanceDispatch(makeCtx(), (k) =>
          k === "BAERLY_MAINTENANCE_PROFILE" ? raw : undefined,
        ),
      ).toThrow(expect.objectContaining({ code: "InvalidConfig" }));
    },
  );

  test.each(badProfiles)(
    "BAERLY_MAINTENANCE_PROFILE=%j throws InvalidConfig on the cron path, naming the variable, value, and accepted values",
    (raw) => {
      let caught: unknown;
      try {
        resolveCfMaintenanceProfile((k) => (k === "BAERLY_MAINTENANCE_PROFILE" ? raw : undefined));
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "InvalidConfig" });
      const message = (caught as Error).message;
      expect(message).toContain("BAERLY_MAINTENANCE_PROFILE");
      expect(message).toContain(JSON.stringify(raw));
      expect(message).toContain('"cf-free"');
      expect(message).toContain('"cf-paid"');
    },
  );

  // Step 11: cron-path selection — both triggers resolve the profile through
  // the same `resolveCfMaintenanceProfile` helper, so they stay coherent when
  // the operator wires it into their `scheduled` handler (see worker.ts).
  test("resolveCfMaintenanceProfile resolves cf-paid for the cron path", () => {
    expect(
      resolveCfMaintenanceProfile((k) =>
        k === "BAERLY_MAINTENANCE_PROFILE" ? "cf-paid" : undefined,
      ),
    ).toBe(MAINTENANCE_PROFILE_CF_PAID);
  });

  test("resolveCfMaintenanceProfile defaults to cf-free for the cron path", () => {
    expect(resolveCfMaintenanceProfile(() => undefined)).toBe(MAINTENANCE_PROFILE_CF_FREE);
    expect(resolveCfMaintenanceProfile(() => "")).toBe(MAINTENANCE_PROFILE_CF_FREE);
    expect(resolveCfMaintenanceProfile(() => "cf-free")).toBe(MAINTENANCE_PROFILE_CF_FREE);
  });
});

describe("early fold when storage is reached through fetch on Workers Free", () => {
  test("storage other than the R2 binding folds at CF_FREE_FETCH_FOLD_AT_TAIL_ENTRIES", () => {
    const ctx = mockExecutionContext();
    // Exactly the options the `free-fetch:*` request-count cells run with.
    expect(cfMaintenanceDispatch(ctx, () => undefined, new MemoryStorage()).options).toEqual(
      FREE_FETCH_TICK_OPTIONS,
    );
    expect(FREE_FETCH_TICK_OPTIONS.foldAtTailEntries).toBe(CF_FREE_FETCH_FOLD_AT_TAIL_ENTRIES);
  });

  test("the R2 binding, cf-paid, and an unknown storage keep the ratio trigger", () => {
    const ctx = mockExecutionContext();
    const binding = r2BindingStorage(getBinding());
    expect(cfMaintenanceDispatch(ctx, () => undefined, binding).options).not.toHaveProperty(
      "foldAtTailEntries",
    );
    expect(cfMaintenanceDispatch(ctx, () => undefined).options).not.toHaveProperty(
      "foldAtTailEntries",
    );
    const paid = cfMaintenanceDispatch(
      ctx,
      (k) => (k === "BAERLY_MAINTENANCE_PROFILE" ? "cf-paid" : undefined),
      new MemoryStorage(),
    );
    expect(paid.options).not.toHaveProperty("foldAtTailEntries");
  });

  test("a Worker given non-binding storage folds the tail at the trigger, with no configuration", async () => {
    const tenant = tenantId("fetchfold");
    const storage = new MemoryStorage();
    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });
    const handler = baerlyWorker<BaerlyEnv>(() => ({ config: testConfig, verifier, storage }));
    const env: BaerlyEnv = { APP: "t" };
    const post = async (n: number): Promise<void> => {
      const { ctx, drain } = makeCollectingCtx();
      const res = await handler.fetch!(
        new Request("https://x/v1/c/c", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ doc: { n } }),
        }) as Request<unknown, IncomingRequestCfProperties>,
        env,
        ctx,
      );
      expect(res.status).toBe(201);
      await drain();
    };
    const key = `app/t/tenant/${tenant}/manifests/c/current.json`;
    for (let n = 0; n < CF_FREE_FETCH_FOLD_AT_TAIL_ENTRIES - 1; n++) {
      await post(n);
    }
    expect((await readCurrentJson(storage, key))!.json.log_seq_start).toBe(0);
    // The write that brings the tail to the trigger folds it, far below
    // the ratio trigger's first fold.
    await post(CF_FREE_FETCH_FOLD_AT_TAIL_ENTRIES);
    expect((await readCurrentJson(storage, key))!.json.log_seq_start).toBe(
      CF_FREE_FETCH_FOLD_AT_TAIL_ENTRIES,
    );
  });
});

describe("Cache API calls the free-fetch request-count cells add", () => {
  test("each request kind makes exactly the calls the cells charge", async () => {
    const tenant = tenantId("cachecalls");
    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });
    const handler = baerlyWorker<BaerlyEnv>(() => ({
      config: { ...testConfig, collections: { c: { indexes: [{ name: "by_f0", on: "f0" }] } } },
      verifier,
      storage: new MemoryStorage(),
    }));
    const env: BaerlyEnv = { APP: "t" };
    const cache = (caches as unknown as { default: Cache }).default;
    const spies = [vi.spyOn(cache, "match"), vi.spyOn(cache, "put"), vi.spyOn(cache, "delete")];
    const send = async (method: string, path: string, body?: unknown): Promise<number> => {
      for (const spy of spies) {
        spy.mockClear();
      }
      const { ctx, drain } = makeCollectingCtx();
      const res = await handler.fetch!(
        new Request(`https://x${path}`, {
          method,
          ...(body !== undefined && {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        }) as Request<unknown, IncomingRequestCfProperties>,
        env,
        ctx,
      );
      expect(res.status).toBeLessThan(300);
      await res.arrayBuffer();
      await drain();
      return spies.reduce((n, spy) => n + spy.mock.calls.length, 0);
    };
    try {
      const where = encodeURIComponent(
        JSON.stringify({ clauses: [{ op: "eq", field: "f0", value: "y" }] }),
      );
      await expect(send("POST", "/v1/c/c", { doc: { _id: "a", f0: "x" } })).resolves.toBe(
        FREE_FETCH_CACHE_API_CALLS.insert,
      );
      await expect(send("GET", "/v1/c/c/a")).resolves.toBe(FREE_FETCH_CACHE_API_CALLS.get);
      await expect(send("PATCH", "/v1/c/c/a", { patch: { f0: "y" } })).resolves.toBe(
        FREE_FETCH_CACHE_API_CALLS.update,
      );
      await expect(send("GET", `/v1/c/c?where=${where}`)).resolves.toBe(
        FREE_FETCH_CACHE_API_CALLS["indexed-query"],
      );
      // `mixed` rotates inserts, updates and deletes; it is charged its
      // most expensive member.
      await expect(send("DELETE", "/v1/c/c/a")).resolves.toBe(FREE_FETCH_CACHE_API_CALLS.mixed);
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});

describe("write-tick fold under the CF free-tier request ledger", () => {
  test("a real fold lands at its pinned call count within the Free R2 limit and advances log_seq_start by the per-pass slice", async () => {
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
    const noopCtx = mockExecutionContext();
    const m = cfMaintenanceDispatch(noopCtx, () => undefined);
    // The Free ledger the Worker gives each invocation; the binding charges
    // every attempt to its `internal` pool.
    const ledger = cfRequestLedger(() => undefined);
    await runWithContext(createObservabilityContext({ ledger }), () =>
      runBoundedMaintenance(
        { storage: counting.storage, currentJsonKey: KEY(tenant), prevSeq: 110 },
        m.options,
      ),
    );

    // (a) Every storage call, GETs included, is charged once; the pass is
    // pinned and fits the Free R2 limit with every call retried.
    const calls = counting.gets + counting.classAOps;
    expect(ledger.charged).toEqual({ internal: calls, external: 0, cache: 0 });
    // No `observedTail` here, so compact()'s probe walks the whole stale
    // 110-entry tail from `tail_hint` 0: the count grows with the tail.
    expect({ gets: counting.gets, puts: counting.puts, lists: counting.lists }).toEqual({
      gets: 134,
      puts: 2,
      lists: 0,
    });
    expect(calls).toBe(136);
    expect(calls * STORAGE_RETRY_MAX_ATTEMPTS).toBeLessThanOrEqual(CF_FREE_INTERNAL_REQUEST_LIMIT);

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
    //       `WriteConflict`; the compactor's cas-lost branch then fires.
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
              // R2 returns null on a precondition miss → WriteConflict.
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
    // we drain. Under single-write commit the writer's commit touches no
    // `current.json` CAS at all (the log/<seq> create IS the commit), so
    // the ONLY manifest CAS in this flow is the FOLD's, which runs in the
    // waitUntil continuation. Arming post-response pins the metric to the
    // fold path.
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

describe("fold-wall deferral signal from inside the waitUntil continuation", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await reset();
  });

  test("a deferring tick dispatched via ctx.waitUntil emits the fold_deferred log record after the response", async () => {
    // The canonical line is flushed before `waitUntil` drains, so the
    // deferral counter never reaches it on Cloudflare. The structured log
    // record is the operator's signal (`wrangler tail`); pin that it fires
    // from the post-response continuation.
    const bucket = getBinding();
    const tenant = tenantId("wall");
    const storage = r2BindingStorage(bucket);
    await provision(storage, tenant);
    // A host move: this Worker serves the bucket on Free while a peer on a
    // larger host also writes and folds it. `C` from the env binding is the
    // rebuilt size of the 40 seeded rows, so both fold passes land and the
    // delete is admitted at its refusal point, which forces its tick. Between
    // the delete's commit and that tick, the peer grows the collection and
    // folds it past `C`, so the tick defers at the pre-fold gate. (On one
    // host, a tick cannot defer after a write the capacity check admitted.)
    const PASS = MAINTENANCE_PROFILE_CF_FREE.maxFoldEntriesPerPass;
    await seedTail(storage, KEY(tenant), 2 * PASS);
    const foldAll = (s: Storage) =>
      compact({ storage: s, currentJsonKey: KEY(tenant) }, { minEntriesToCompact: 1 });
    const probe = new MemoryStorage();
    await provision(probe, tenant);
    await seedTail(probe, KEY(tenant), 2 * PASS);
    await foldAll(probe);
    const maxFoldBytes = (await readCurrentJson(probe, KEY(tenant)))!.json.snapshot_bytes;
    const peer = async (): Promise<void> => {
      const writer = new Writer({ storage, currentJsonKey: KEY(tenant) });
      const larger = createObservabilityContext({ maintenance: { disabled: true } });
      await runWithContext(larger, async () => {
        for (let i = 1; i <= 5; i++) {
          await writer.commit({
            op: "U",
            collection: "c",
            docId: `d${i}`,
            body: { _id: `d${i}`, n: i, pad: "x".repeat(5000) },
          });
        }
      });
      await foldAll(storage);
    };
    // The bucket as the Worker sees it: once the delete's `log/<seq>` create
    // lands, the next `current.json` read (the tick's) waits for the peer.
    let committed = false;
    let raced = false;
    const racedBucket = new Proxy(bucket, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== "function") {
          return value;
        }
        return async (key: string, ...rest: unknown[]) => {
          if (prop === "get" && committed && !raced && key.endsWith("/current.json")) {
            raced = true;
            await peer();
          }
          const result = await (value as (...a: unknown[]) => unknown).call(target, key, ...rest);
          if (prop === "put" && key.includes("/log/")) {
            committed = true;
          }
          return result;
        };
      },
    });

    const records: LogRecord[] = [];
    const sink: Sink = (r) => records.push(r);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });
    const handler = baerlyWorker<BaerlyEnv>(() => ({
      config: testConfig,
      verifier,
      observability: { level: "info", sink },
    }));
    const env: BaerlyEnv = {
      BUCKET: racedBucket,
      APP: "t",
      BAERLY_MAINTENANCE_MAX_FOLD_BYTES: String(maxFoldBytes),
    };
    const { ctx, drain } = makeCollectingCtx();

    // A delete is not growth, so it commits and queues its write tick.
    const res = await handler.fetch!(
      new Request("https://x/v1/c/c/d0", { method: "DELETE" }) as Request<
        unknown,
        IncomingRequestCfProperties
      >,
      env,
      ctx,
    );
    expect(res.status).toBe(204);
    const deferLogs = (): LogRecord[] =>
      records.filter((r) => r.category.join(".") === "baerly.maintenance");
    // Queued, not yet run.
    expect(deferLogs()).toHaveLength(0);

    await drain();

    expect(raced).toBe(true);
    const folded = (await readCurrentJson(storage, KEY(tenant)))!.json;
    expect(folded.log_seq_start).toBe(2 * PASS + 6);
    expect(folded.snapshot_bytes).toBeGreaterThan(maxFoldBytes);
    expect(deferLogs()).toHaveLength(1);
    expect(deferLogs()[0]!.properties).toMatchObject({
      collection: "c",
      dimension: "bytes",
      gate: "pre-fold",
      ceiling_bytes: maxFoldBytes,
      ceiling_rows: MAINTENANCE_PROFILE_CF_FREE.maxFoldRows,
      log_seq_start: 2 * PASS + 6,
    });
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

    const noopCtx = mockExecutionContext();
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
    // Names the risk: a too-large fold may exceed the CPU limit and
    // not land.
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

    const noopCtx = mockExecutionContext();
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

  // The guardrail is free's CPU wall, and its first stated remedy is "run
  // on CF PAID". Since the cf-paid profile carries its own 8 MiB ceiling,
  // warning an operator who already selected it would contradict the
  // advice the same message gives.
  test("the same over-raised value does NOT warn under BAERLY_MAINTENANCE_PROFILE=cf-paid", async () => {
    const bucket = getBinding();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const verifier: Verifier = async () => ({ tenantPrefix: "paid-nowarn-t", identity: {} });
    const handler = baerlyWorker<BaerlyEnv>(() => ({ config: testConfig, verifier }));
    const env = {
      BUCKET: bucket,
      APP: "t",
      BAERLY_MAINTENANCE_MAX_FOLD_BYTES: String(CF_FREE_MAX_SAFE_FOLD_BYTES + 1),
      BAERLY_MAINTENANCE_PROFILE: "cf-paid",
    } as unknown as BaerlyEnv;

    const noopCtx = mockExecutionContext();
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

  test("a non-positive value leaves health green without consuming the init-check flag", async () => {
    const bucket = getBinding();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const verifier: Verifier = async () => ({ tenantPrefix: "throw-then-warn-t", identity: {} });
    const handler = baerlyWorker<BaerlyEnv>(() => ({ config: testConfig, verifier }));
    const noopCtx = mockExecutionContext();

    // The init check skips a value it cannot parse (the dispatch build
    // rejects it on API requests); it must not complete the check.
    const badEnv = {
      BUCKET: bucket,
      APP: "t",
      BAERLY_MAINTENANCE_MAX_FOLD_BYTES: "0",
    } as unknown as BaerlyEnv;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await handler.fetch!(
        new Request("https://x/v1/healthz") as Request<unknown, IncomingRequestCfProperties>,
        badEnv,
        noopCtx,
      );
      expect(res.status).toBe(200);
    }

    // Closure-scoped state persists across calls to this handler. Once
    // corrected, an over-ceiling value must still trigger the warning.
    const overCeilingEnv = {
      BUCKET: bucket,
      APP: "t",
      BAERLY_MAINTENANCE_MAX_FOLD_BYTES: String(CF_FREE_MAX_SAFE_FOLD_BYTES + 1),
    } as unknown as BaerlyEnv;
    await handler.fetch!(
      new Request("https://x/v1/healthz") as Request<unknown, IncomingRequestCfProperties>,
      overCeilingEnv,
      noopCtx,
    );

    const maintWarns = warnSpy.mock.calls.filter((args) =>
      String(args[0] ?? "").includes("BAERLY_MAINTENANCE_MAX_FOLD_BYTES"),
    );
    expect(maintWarns).toHaveLength(1);
  });
});

/**
 * Every invalid combination of the two init-read vars keeps the
 * unauthenticated surfaces (healthz, spec, dev landing) and a cron callback
 * that does not read them available, and fails API requests at the dispatch
 * build. The over-raised valid byte value matters because only it makes the
 * init ceiling check resolve the profile.
 */
describe("invalid MAX_FOLD_BYTES × PROFILE combinations on the CF request path", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const overRaised = String(CF_FREE_MAX_SAFE_FOLD_BYTES + 1);
  const cases: Array<[string | undefined, string | undefined]> = [
    ["8mb", undefined],
    ["8mb", "cf-free"],
    ["8mb", "cf_paid"],
    ["0", "cf-paid"],
    ["0", "cf_paid"],
    [" 1024", "cf-free"],
    [undefined, "cf_paid"],
    [overRaised, "cf_paid"],
    [overRaised, "cf-paid "],
  ];
  const scheduledEvent: ScheduledController = {
    scheduledTime: Date.UTC(2026, 0, 1, 0, 0, 0),
    cron: "* * * * *",
    noRetry(): void {},
  };

  test.each(cases)(
    "MAX_FOLD_BYTES=%j PROFILE=%j: healthz/spec/dev and a cron callback stay up, an API request throws InvalidConfig",
    async (bytes, profile) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const bucket = getBinding();
      const tenant = tenantId("bad-combo");
      await provision(r2BindingStorage(bucket), tenant);
      const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });
      let cronRan = false;
      const handler = baerlyWorker<BaerlyEnv>(() => ({
        config: testConfig,
        verifier,
        dev: { app: "t", uiUrl: "https://ui.example" },
        scheduled: () => {
          cronRan = true;
        },
      }));
      const noopCtx = mockExecutionContext();
      const env = {
        BUCKET: bucket,
        APP: "t",
        ...(bytes !== undefined && { BAERLY_MAINTENANCE_MAX_FOLD_BYTES: bytes }),
        ...(profile !== undefined && { BAERLY_MAINTENANCE_PROFILE: profile }),
      } as unknown as BaerlyEnv;
      const status = async (path: string): Promise<number> => {
        const res = await handler.fetch!(
          new Request(`https://x${path}`) as Request<unknown, IncomingRequestCfProperties>,
          env,
          noopCtx,
        );
        return res.status;
      };

      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(status("/v1/healthz")).resolves.toBe(200);
        await expect(status("/v1/spec")).resolves.toBe(200);
        await expect(status("/")).resolves.toBe(200);
        await expect(status("/v1/c/c")).rejects.toMatchObject({ code: "InvalidConfig" });
      }
      await handler.scheduled!(scheduledEvent, env, noopCtx);
      expect(cronRan).toBe(true);
    },
  );

  test("a cron callback that resolves an invalid profile gets InvalidConfig", async () => {
    const handler = baerlyWorker<BaerlyEnv>(() => ({
      config: testConfig,
      scheduled: (_event, env) => {
        resolveCfMaintenanceProfile((k) => {
          const v = (env as unknown as Record<string, unknown>)[k];
          return typeof v === "string" ? v : undefined;
        });
      },
    }));
    const env = {
      BUCKET: getBinding(),
      APP: "t",
      BAERLY_MAINTENANCE_PROFILE: "CF-PAID",
    } as unknown as BaerlyEnv;
    await expect(
      handler.scheduled!(scheduledEvent, env, mockExecutionContext()),
    ).rejects.toMatchObject({ code: "InvalidConfig" });
  });
});

/**
 * `BAERLY_MAINTENANCE_DISABLE` and `BAERLY_MAINTENANCE_PROFILE` are parsed
 * later than `BAERLY_MAINTENANCE_MAX_FOLD_BYTES`: the ceiling check runs
 * inside `ensureResolved` (ahead of healthz) and reads the profile only for
 * an over-raised byte ceiling, while both are read when the per-request
 * maintenance dispatch is built — after the healthz / dev short-circuits,
 * before the verifier. That split is what makes an invalid `DISABLE` or
 * `PROFILE` leave health probes green while failing API requests.
 *
 * On CF the throw propagates out of `fetch` through the ExportedHandler's
 * default exception path rather than the canonical JSON envelope. That is
 * the SAME contract the adapter already documents for a missing
 * `SHARED_SECRET` (see `worker.test.ts`), and it deliberately diverges
 * from Node, where the parse sits inside the handler's existing
 * `mapError` boundary. Pinned here so a change to either half is a
 * visible test edit.
 */
describe("invalid dispatch-time maintenance env on the CF request path", () => {
  test.each([
    ["BAERLY_MAINTENANCE_DISABLE", "yes", "false"],
    ["BAERLY_MAINTENANCE_PROFILE", "cf_paid", "cf-free"],
  ])(
    "%s=%j: health stays green, an API request throws InvalidConfig, and a corrected binding recovers",
    async (key, bad, good) => {
      const bucket = getBinding();
      const tenant = tenantId("bad-env");
      await provision(r2BindingStorage(bucket), tenant);

      const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });
      const handler = baerlyWorker<BaerlyEnv>(() => ({ config: testConfig, verifier }));
      const noopCtx = mockExecutionContext();
      const badEnv = {
        BUCKET: bucket,
        APP: "t",
        [key]: bad,
      } as unknown as BaerlyEnv;

      // Parsed after the healthz short-circuit: the load balancer's probe
      // and the anonymous machine contract stay available.
      const probeStatus = async (path: string): Promise<number> => {
        const res = await handler.fetch!(
          new Request(`https://x${path}`) as Request<unknown, IncomingRequestCfProperties>,
          badEnv,
          noopCtx,
        );
        return res.status;
      };
      await expect(probeStatus("/v1/healthz")).resolves.toBe(200);
      await expect(probeStatus("/v1/spec")).resolves.toBe(200);

      // An API request reaches the dispatch build and fails — every time,
      // since the binding is re-read per request.
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(
          handler.fetch!(
            new Request("https://x/v1/c/c") as Request<unknown, IncomingRequestCfProperties>,
            badEnv,
            noopCtx,
          ),
        ).rejects.toMatchObject({ code: "InvalidConfig" });
      }

      // Correcting the binding restores service without a new isolate.
      const goodEnv = {
        BUCKET: bucket,
        APP: "t",
        [key]: good,
      } as unknown as BaerlyEnv;
      const recovered = await handler.fetch!(
        new Request("https://x/v1/c/c") as Request<unknown, IncomingRequestCfProperties>,
        goodEnv,
        noopCtx,
      );
      expect(recovered.status).toBe(200);
    },
  );
});
