/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes. */

/**
 * The Worker's per-invocation request ledger, under workerd: its limits
 * per maintenance profile, one ledger shared by a request's route and its
 * `ctx.waitUntil` work, a fresh one per cron invocation, and the Cache API
 * calls charged to it. Runs in the `cloudflare-pool` project.
 */

import {
  type BaerlyAppConfig,
  CF_CACHE_API_MAX_CALLS,
  CF_FREE_EXTERNAL_REQUEST_LIMIT,
  CF_FREE_FETCH_FOLD_AT_TAIL_ENTRIES,
  CF_FREE_INTERNAL_REQUEST_LIMIT,
  CF_PAID_REQUEST_LIMIT,
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  MemoryStorage,
  readCurrentJson,
  RequestLedger,
  type Verifier,
} from "@baerly/protocol";
import { runWithContext } from "@baerly/server/observability";
import {
  createObservabilityContext,
  getCurrentContext,
} from "@baerly/server/_internal/observability";
import { Writer } from "@baerly/server/_internal/testing";
import { describe, expect, test } from "vitest";
import { ledgeredStorage } from "../../../tests/fixtures/ledgered-storage.ts";
import { mockExecutionContext } from "../../../tests/fixtures/mock-execution-context.ts";
import { CallTally, totalCalls } from "../../../tests/fixtures/request-counting-storage.ts";
import { invalidateOnWrite, withReadCache } from "./cache.ts";
import { r2BindingStorage } from "./r2-binding-storage.ts";
import { baerlyWorker, type BaerlyEnv, cfReadEnvelope, cfRequestLedger } from "./worker.ts";

const testConfig: BaerlyAppConfig = {
  app: "t",
  tenant: "t",
  target: "cloudflare",
  auth: "none",
  collections: {},
};

const tenantId = (label: string): string =>
  `${label}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

const collectingCtx = (): { ctx: ExecutionContext; drain: () => Promise<void> } => {
  const collected: Array<Promise<unknown>> = [];
  return {
    ctx: mockExecutionContext((p) => {
      collected.push(Promise.resolve(p));
    }),
    drain: async (): Promise<void> => {
      await Promise.all(collected);
    },
  };
};

const request = (path: string, init?: RequestInit): Request<unknown, IncomingRequestCfProperties> =>
  new Request(`https://x${path}`, init) as Request<unknown, IncomingRequestCfProperties>;

describe("cfRequestLedger", () => {
  test("cf-free, the default, limits both pools", () => {
    expect(cfRequestLedger(() => undefined).limits).toEqual({
      internal: CF_FREE_INTERNAL_REQUEST_LIMIT,
      external: CF_FREE_EXTERNAL_REQUEST_LIMIT,
    });
    expect([CF_FREE_INTERNAL_REQUEST_LIMIT, CF_FREE_EXTERNAL_REQUEST_LIMIT]).toEqual([900, 45]);
  });

  test("cf-paid allows the paid limit on both pools", () => {
    const ledger = cfRequestLedger((k) =>
      k === "BAERLY_MAINTENANCE_PROFILE" ? "cf-paid" : undefined,
    );
    expect(ledger.limits).toEqual({
      internal: CF_PAID_REQUEST_LIMIT,
      external: CF_PAID_REQUEST_LIMIT,
    });
    expect(CF_PAID_REQUEST_LIMIT).toBe(9000);
  });

  test.each(["cf_paid", "CF-PAID", "cf-paid ", "garbage"])(
    "an invalid profile %j gets the free limits without throwing",
    (profile) => {
      const ledger = cfRequestLedger((k) =>
        k === "BAERLY_MAINTENANCE_PROFILE" ? profile : undefined,
      );
      expect(ledger.limits).toEqual({
        internal: CF_FREE_INTERNAL_REQUEST_LIMIT,
        external: CF_FREE_EXTERNAL_REQUEST_LIMIT,
      });
    },
  );
});

describe("a Worker request runs under one ledger", () => {
  test("a read past Free's external limit is refused whole and issues nothing past it", async () => {
    const tenant = tenantId("ledger-refuse");
    const inner = new MemoryStorage();
    const key = `app/t/tenant/${tenant}/manifests/c/current.json`;
    await createCurrentJson(inner, key, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      tail_hint: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "ledger-test", claimed_at: "" },
      snapshot_bytes: 0,
      snapshot_rows: 0,
    });
    // An unfolded tail longer than the external limit: a read replays it.
    const writer = new Writer({ storage: inner, currentJsonKey: key });
    await runWithContext(
      createObservabilityContext({ maintenance: { disabled: true } }),
      async () => {
        for (let i = 0; i < CF_FREE_EXTERNAL_REQUEST_LIMIT + 5; i++) {
          await writer.commit({ op: "I", collection: "c", docId: `d${i}`, body: { _id: `d${i}` } });
        }
      },
    );
    // Storage over `fetch`: every call is charged to the external pool.
    const issued = new CallTally();
    let ledger: RequestLedger | undefined;
    const verifier: Verifier = async () => {
      ledger = getCurrentContext()?.ledger;
      return { tenantPrefix: tenant, identity: {} };
    };
    const handler = baerlyWorker<BaerlyEnv>(() => ({
      config: testConfig,
      verifier,
      storage: ledgeredStorage(inner, "external", issued),
    }));
    const { ctx, drain } = collectingCtx();
    const res = await handler.fetch!(request("/v1/c/c/d0"), { APP: "t" }, ctx);
    await drain();
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "CapacityExceeded" } });
    expect(ledger?.limits.external).toBe(CF_FREE_EXTERNAL_REQUEST_LIMIT);
    // The read cache's `match` took one; storage got the rest, and the call
    // the ledger refused was never issued.
    expect(ledger?.charged).toMatchObject({ external: CF_FREE_EXTERNAL_REQUEST_LIMIT, cache: 1 });
    expect(totalCalls(issued.read())).toBe(CF_FREE_EXTERNAL_REQUEST_LIMIT - 1);
  });

  test("the waitUntil fold and invalidation charge the request's ledger", async () => {
    const tenant = tenantId("ledger-tick");
    const inner = new MemoryStorage();
    const issued = new CallTally();
    const ledgers: RequestLedger[] = [];
    const verifier: Verifier = async () => {
      ledgers.push(getCurrentContext()!.ledger!);
      return { tenantPrefix: tenant, identity: {} };
    };
    // Not the R2 binding, so on cf-free the write tick folds at
    // CF_FREE_FETCH_FOLD_AT_TAIL_ENTRIES, inside `waitUntil`.
    const handler = baerlyWorker<BaerlyEnv>(() => ({
      config: testConfig,
      verifier,
      storage: ledgeredStorage(inner, "external", issued),
    }));
    const send = async (method: string, path: string, body: unknown): Promise<void> => {
      const { ctx, drain } = collectingCtx();
      const res = await handler.fetch!(
        request(path, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { APP: "t" },
        ctx,
      );
      expect(res.status).toBeLessThan(300);
      await drain();
      if (method === "PATCH") {
        // The post-response invalidation charged this request's ledger.
        expect(ledgers.at(-1)!.charged.cache).toBe(1);
      }
    };
    for (let i = 0; i < CF_FREE_FETCH_FOLD_AT_TAIL_ENTRIES; i++) {
      await send("POST", "/v1/c/c", { doc: { _id: `d${i}` } });
    }
    await send("PATCH", "/v1/c/c/d0", { patch: { n: 1 } });
    const key = `app/t/tenant/${tenant}/manifests/c/current.json`;
    // The fold ran in a `waitUntil` continuation.
    expect((await readCurrentJson(inner, key))!.json.log_seq_start).toBeGreaterThan(0);
    // Every storage call issued, the post-response folds included, was
    // charged to the ledger of the request that dispatched it.
    const storageCharged = ledgers.reduce(
      (sum, l) => sum + l.charged.external - l.charged.cache,
      0,
    );
    expect(storageCharged).toBe(totalCalls(issued.read()));
  });
});

describe("an idle /v1/since long-poll on Workers Free with storage over fetch", () => {
  test("ends in an empty 200 within the external limit, and the next poll keeps syncing", async () => {
    const tenant = tenantId("ledger-since");
    const inner = new MemoryStorage();
    const key = `app/t/tenant/${tenant}/manifests/c/current.json`;
    await createCurrentJson(inner, key, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      tail_hint: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "ledger-test", claimed_at: "" },
      snapshot_bytes: 0,
      snapshot_rows: 0,
    });
    const issued = new CallTally();
    const ledgers: RequestLedger[] = [];
    const verifier: Verifier = async () => {
      ledgers.push(getCurrentContext()!.ledger!);
      return { tenantPrefix: tenant, identity: {} };
    };
    // The defaults' ratio, 25 s at 1 s, scaled down: about 26 idle polls,
    // more than 45 external calls cover at two per poll.
    const handler = baerlyWorker<BaerlyEnv>(() => ({
      config: testConfig,
      verifier,
      storage: ledgeredStorage(inner, "external", issued),
      sinceTimeoutMs: 500,
      sincePollIntervalMs: 20,
    }));
    const since = async (cursor: string): Promise<Response> => {
      const { ctx, drain } = collectingCtx();
      const res = await handler.fetch!(
        request(`/v1/since?collection=c&cursor=${encodeURIComponent(cursor)}`),
        { APP: "t" },
        ctx,
      );
      await drain();
      return res;
    };

    const idle = await since("");
    expect(idle.status).toBe(200);
    await expect(idle.json()).resolves.toEqual({ events: [], next_cursor: "" });
    expect(ledgers.at(-1)!.charged.external).toBeLessThanOrEqual(CF_FREE_EXTERNAL_REQUEST_LIMIT);
    expect(ledgers.at(-1)!.charged.external).toBe(totalCalls(issued.read()));

    const { ctx, drain } = collectingCtx();
    const put = await handler.fetch!(
      request("/v1/c/c", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: { _id: "d0" } }),
      }),
      { APP: "t" },
      ctx,
    );
    expect(put.status).toBeLessThan(300);
    await drain();

    const next = await since("");
    expect(next.status).toBe(200);
    const body = (await next.json()) as { events: Array<{ doc_id: string }> };
    expect(body.events.map((e) => e.doc_id)).toEqual(["d0"]);
  });
});

describe("a cron invocation gets its own ledger", () => {
  test("the scheduled handler runs inside a context carrying a fresh profile ledger", async () => {
    const seen: Array<RequestLedger | undefined> = [];
    const handler = baerlyWorker<BaerlyEnv>(() => ({
      config: testConfig,
      verifier: async () => ({ tenantPrefix: "t", identity: {} }),
      storage: new MemoryStorage(),
      scheduled: async () => {
        seen.push(getCurrentContext()?.ledger);
      },
    }));
    const event = {} as ScheduledController;
    await handler.scheduled!(event, { APP: "t" }, mockExecutionContext());
    await handler.scheduled!(
      event,
      { APP: "t", BAERLY_MAINTENANCE_PROFILE: "cf-paid" },
      mockExecutionContext(),
    );
    expect(seen[0]?.limits.external).toBe(CF_FREE_EXTERNAL_REQUEST_LIMIT);
    expect(seen[1]?.limits.external).toBe(CF_PAID_REQUEST_LIMIT);
    expect(seen[0]).not.toBe(seen[1]);
  });
});

let n = 0;
const freshUrl = (path: string): string =>
  `https://baerly-ledger.test/v1/c/${path}-${++n}-${Date.now().toString(36)}`;

const inLedger = <T>(ledger: RequestLedger, fn: () => Promise<T>): Promise<T> =>
  Promise.resolve(runWithContext(createObservabilityContext({ ledger }), fn));

describe("the read cache charges the ledger and never refuses for it", () => {
  const ok = (): Response =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json", etag: '"e"' },
    });

  test("a miss charges match + put to the external pool", async () => {
    const ledger = new RequestLedger({ internal: 900, external: 45 });
    const result = await inLedger(ledger, () =>
      withReadCache(new Request(freshUrl("tickets/a")), "t", async () => ok()),
    );
    expect(result.cache_status).toBe("miss");
    expect(ledger.charged).toEqual({ internal: 2, external: 2, cache: 2 });
  });

  test("with no room for the put, the response is served and nothing is stored", async () => {
    const url = freshUrl("tickets/b");
    const ledger = new RequestLedger({ internal: 900, external: 2 });
    ledger.acquire("external");
    const first = await inLedger(ledger, () =>
      withReadCache(new Request(url), "t", async () => ok()),
    );
    expect(first.response.status).toBe(200);
    expect(ledger.charged).toEqual({ internal: 2, external: 2, cache: 1 });
    // Nothing was stored: the next read misses again.
    const again = await inLedger(new RequestLedger(), () =>
      withReadCache(new Request(url), "t", async () => ok()),
    );
    expect(again.cache_status).toBe("miss");
  });

  test("with no room for the match, the cache is bypassed and the handler serves", async () => {
    const ledger = new RequestLedger({ internal: 900, external: 0 });
    let ran = 0;
    const result = await inLedger(ledger, () =>
      withReadCache(new Request(freshUrl("tickets/c")), "t", async () => {
        ran += 1;
        return ok();
      }),
    );
    expect([result.cache_status, result.response.status, ran]).toEqual(["bypass", 200, 1]);
    expect(ledger.charged.cache).toBe(0);
  });

  test(`at most ${CF_CACHE_API_MAX_CALLS} optional cache calls per invocation`, async () => {
    const ledger = new RequestLedger({ internal: 900, external: 45 });
    const statuses: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await inLedger(ledger, () =>
        withReadCache(new Request(freshUrl("tickets/d")), "t", async () => ok()),
      );
      statuses.push(r.cache_status);
    }
    // match + put, then match (3), then the third read bypasses.
    expect(statuses).toEqual(["miss", "miss", "bypass"]);
    expect(ledger.charged.cache).toBe(CF_CACHE_API_MAX_CALLS);
  });

  test("a write's invalidation is issued even with the pool spent", async () => {
    const url = freshUrl("tickets/e");
    await inLedger(new RequestLedger(), () =>
      withReadCache(new Request(url), "t", async () => ok()),
    );
    const ledger = new RequestLedger({ internal: 900, external: 0 });
    await inLedger(ledger, () =>
      invalidateOnWrite(new Request(url, { method: "PATCH" }), "t", 200),
    );
    expect(ledger.charged).toEqual({ internal: 1, external: 1, cache: 1 });
    const after = await inLedger(new RequestLedger(), () =>
      withReadCache(new Request(url), "t", async () => ok()),
    );
    expect(after.cache_status).toBe("miss");
  });
});

describe("cfReadEnvelope", () => {
  test("names the pool the Worker's storage charges, and leaves the data bounds unset", () => {
    const binding = {} as unknown as Parameters<typeof r2BindingStorage>[0];
    expect(cfReadEnvelope(r2BindingStorage(binding))).toEqual({ requestPool: "internal" });
    expect(cfReadEnvelope(new MemoryStorage())).toEqual({ requestPool: "external" });
  });
});
