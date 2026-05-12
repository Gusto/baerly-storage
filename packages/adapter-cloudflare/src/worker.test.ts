/* eslint-disable no-underscore-dangle -- `__BAERLY_R2_BINDING__` is the
   ticket-06 contract: miniflare's vitest pool sets the global, this file
   reads it. `_id` is the locked primary-key field on document shapes. */

/**
 * `baerlyWorker()` Cron Trigger handler test. Runs under the
 * `cloudflare-pool` vitest project (workerd + miniflare) so the
 * `ExecutionContext` / `ScheduledController` types resolve and the
 * R2 binding is real.
 *
 * Two cases:
 *   - even-minute branch invokes `runScheduledMaintenance` with
 *     `skipGc: true` ⇒ compact lands (snapshot pointer set).
 *   - empty `CURRENT_JSON_KEY` is a no-op (nothing touched on the
 *     bucket).
 */

import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  type Storage,
  type Verifier,
} from "@baerly/protocol";
import { ServerWriter } from "@baerly/server";
import { describe, expect, it } from "vitest";
import { r2BindingStorage } from "./r2-binding-storage";
import { baerlyWorker, type Env } from "./worker";

/**
 * Stand-in `Verifier` for the scheduled-only tests in this file. The
 * Cron Trigger handler doesn't invoke the verifier, but `baerlyWorker`
 * still requires one at construction time (Task A). Any non-null
 * resolver works.
 */
const scheduledOnlyVerifier: Verifier = async () => ({
  tenantPrefix: "x",
  identity: { kind: "scheduled-test" },
});

const getBinding = (): R2Bucket => {
  const bucket = (globalThis as { __BAERLY_R2_BINDING__?: R2Bucket }).__BAERLY_R2_BINDING__;
  if (bucket === undefined) {
    throw new Error("worker.test: globalThis.__BAERLY_R2_BINDING__ missing — wired by vitest pool");
  }
  return bucket;
};

/**
 * Awaiting-`waitUntil` mock. The production CF runtime fires the
 * `ctx.waitUntil(p)` promise in the background; for the test we
 * collect the promises so the assertions can await them.
 */
const makeCtx = (): { ctx: ExecutionContext; settled: () => Promise<unknown[]> } => {
  const pending: Array<Promise<unknown>> = [];
  const ctx: ExecutionContext = {
    waitUntil(p: Promise<unknown>): void {
      pending.push(p);
    },
    passThroughOnException(): void {},
    props: {},
  };
  return { ctx, settled: () => Promise.all(pending) };
};

const seed = async (
  storage: Storage,
  key: string,
  collection: string,
  entries: number,
): Promise<void> => {
  await createCurrentJson(storage, key, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    next_seq: 0,
    writer_fence: { epoch: 0, owner: "worker-test", claimed_at: "" },
  });
  const writer = new ServerWriter({ storage, currentJsonKey: key });
  for (let i = 0; i < entries; i++) {
    await writer.commit({
      op: "I",
      collection,
      docId: `d${i}`,
      body: { _id: `d${i}`, n: i },
    });
  }
};

describe("baerlyWorker scheduled", () => {
  it("compacts on an even-minute tick when CURRENT_JSON_KEY is set", async () => {
    const bucket = getBinding();
    const storage = r2BindingStorage(bucket);
    const key = "app/t/tenant/x/manifests/c/current.json";
    await seed(storage, key, "c", 60);

    const env: Env = {
      BUCKET: bucket,
      APP: "t",
      TENANT: "x",
      CURRENT_JSON_KEY: key,
      CF_TIER: "free",
    };
    const handler = baerlyWorker({ verifier: scheduledOnlyVerifier });
    expect(handler.scheduled).toBeDefined();
    const { ctx, settled } = makeCtx();

    // Even minute (0) → compact branch on free tier.
    const event: ScheduledController = {
      scheduledTime: Date.UTC(2026, 0, 1, 0, 0, 0),
      cron: "* * * * *",
      noRetry(): void {},
    };
    await handler.scheduled!(event, env, ctx);
    await settled();

    // current.json now carries a snapshot pointer.
    const cur = await storage.get(key);
    expect(cur).not.toBeNull();
    const json = JSON.parse(new TextDecoder().decode(cur!.body)) as {
      snapshot: string | null;
      log_seq_start?: number;
    };
    expect(json.snapshot).not.toBeNull();
    expect(json.log_seq_start ?? 0).toBeGreaterThan(0);
    // GC didn't run on the even-minute tick → no pending.json.
    const pending = await storage.get("app/t/tenant/x/manifests/c/gc/pending.json");
    expect(pending).toBeNull();
  });

  it("runs GC on an odd-minute tick when CURRENT_JSON_KEY is set", async () => {
    const bucket = getBinding();
    const storage = r2BindingStorage(bucket);
    const key = "app/t/tenant/x/manifests/c/current.json";
    await seed(storage, key, "c", 60);

    const env: Env = {
      BUCKET: bucket,
      APP: "t",
      TENANT: "x",
      CURRENT_JSON_KEY: key,
      CF_TIER: "free",
    };
    const handler = baerlyWorker({ verifier: scheduledOnlyVerifier });
    const { ctx, settled } = makeCtx();
    // Odd minute (1) → GC branch on free tier.
    const event: ScheduledController = {
      scheduledTime: Date.UTC(2026, 0, 1, 0, 1, 0),
      cron: "* * * * *",
      noRetry(): void {},
    };
    await handler.scheduled!(event, env, ctx);
    await settled();

    // GC ran → pending.json was bootstrapped.
    const pending = await storage.get("app/t/tenant/x/manifests/c/gc/pending.json");
    expect(pending).not.toBeNull();
    // Compact didn't run on the odd-minute tick → no snapshot.
    const cur = await storage.get(key);
    const json = JSON.parse(new TextDecoder().decode(cur!.body)) as {
      snapshot: string | null;
    };
    expect(json.snapshot).toBeNull();
  });

  it("no-ops when CURRENT_JSON_KEY is unset", async () => {
    const bucket = getBinding();
    const env: Env = {
      BUCKET: bucket,
      APP: "t",
      TENANT: "x",
      // CURRENT_JSON_KEY intentionally omitted.
    };
    const handler = baerlyWorker({ verifier: scheduledOnlyVerifier });
    const { ctx, settled } = makeCtx();
    const event: ScheduledController = {
      scheduledTime: Date.UTC(2026, 0, 1, 0, 0, 0),
      cron: "* * * * *",
      noRetry(): void {},
    };
    await handler.scheduled!(event, env, ctx);
    await settled();

    // Nothing was written under the table prefix.
    const listed = await bucket.list({ prefix: "app/t/tenant/x/" });
    expect(listed.objects).toHaveLength(0);
  });
});
