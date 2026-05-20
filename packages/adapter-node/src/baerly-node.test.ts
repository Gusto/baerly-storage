/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes; the maintenance test seeds doc bodies with it. */

import { type AddressInfo, createServer as createNetServer } from "node:net";
import {
  BaerlyError,
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  MemoryStorage,
  type Storage,
  type Verifier,
} from "@baerly/protocol";
import { ServerWriter } from "@baerly/server/_internal/testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import { baerlyNode, type BaerlyNodeHandle } from "./baerly-node.ts";

const sharedDevVerifier: Verifier = async () => ({
  tenantPrefix: "test-tenant",
  identity: { sub: "dev" },
});

/**
 * Reserve and immediately release an ephemeral port so the test can
 * bind `baerlyNode` to a known port and round-trip through it via
 * `fetch`. `baerlyNode.listen(0)` would let the OS pick a port, but
 * the helper deliberately doesn't expose the bound port (the public
 * surface is `listen(port)` only) — so we pick a free one upfront.
 */
const reservePort = async (): Promise<number> => {
  const probe = createNetServer();
  const port = await new Promise<number>((resolve) => {
    probe.listen(0, "127.0.0.1", () => {
      const a = probe.address() as AddressInfo;
      resolve(a.port);
    });
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
};

describe("baerlyNode", () => {
  let activeHandle: BaerlyNodeHandle | undefined;
  afterEach(async () => {
    if (activeHandle !== undefined) {
      await activeHandle.close();
      activeHandle = undefined;
    }
  });

  test("listen resolves once the server is bound and serves /v1/healthz", async () => {
    const port = await reservePort();
    const handle = baerlyNode({
      app: "t",
      storage: new MemoryStorage(),
      verifier: sharedDevVerifier,
    });
    activeHandle = handle;
    await handle.listen(port);

    const res = await fetch(`http://127.0.0.1:${port}/v1/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("close() shuts down the server and is idempotent", async () => {
    const port = await reservePort();
    const handle = baerlyNode({
      app: "t",
      storage: new MemoryStorage(),
      verifier: sharedDevVerifier,
    });
    await handle.listen(port);
    await handle.close();
    await expect(handle.close()).resolves.toBeUndefined();
    activeHandle = undefined;
  });

  test("maintenance fires one runMaintenanceTick per (tenant, collection)", async () => {
    // Pre-seed `current.json` for the four (tenant × collection)
    // pairs so `runMaintenanceTick` finds a real pointer, then commit
    // 200 docs into each so the compactor has something to fold.
    const storage = new MemoryStorage();
    const tenants = ["a", "b"] as const;
    const collections = ["c1", "c2"] as const;
    for (const tenant of tenants) {
      for (const collection of collections) {
        const key = `app/t/tenant/${tenant}/manifests/${collection}/current.json`;
        await createCurrentJson(storage, key, {
          schema_version: CURRENT_JSON_SCHEMA_VERSION,
          snapshot: null,
          next_seq: 0,
          log_seq_start: 0,
          writer_fence: { epoch: 0, owner: "baerly-node-test", claimed_at: "" },
        });
        const writer = new ServerWriter({ storage, currentJsonKey: key });
        for (let i = 0; i < 200; i++) {
          await writer.commit({
            op: "I",
            collection,
            docId: `d${i}`,
            body: { _id: `d${i}`, n: i },
          });
        }
      }
    }

    const port = await reservePort();
    const handle = baerlyNode({
      app: "t",
      storage,
      verifier: sharedDevVerifier,
      maintenance: {
        tenants: [...tenants],
        collections: [...collections],
        intervalMs: 50,
      },
    });
    activeHandle = handle;
    await handle.listen(port);

    // Wait for the interval to fire once and the Promise.all inside
    // `tick` to settle. 250 ms ≫ 50 ms interval; the cross-product of
    // four `runMaintenanceTick` calls against MemoryStorage is well
    // under that bound.
    await new Promise((r) => setTimeout(r, 250));

    // Assert every pair got a compact pass: each current.json now
    // points to a snapshot (post-compact) and each collection's GC
    // pending ledger exists. Mirrors the assertion shape from
    // `server.test.ts` `runMaintenanceTick` smoke test.
    for (const tenant of tenants) {
      for (const collection of collections) {
        const key = `app/t/tenant/${tenant}/manifests/${collection}/current.json`;
        const cur = await storage.get(key);
        expect(cur).not.toBeNull();
        const json = JSON.parse(new TextDecoder().decode(cur!.body)) as {
          snapshot: string | null;
          log_seq_start?: number;
        };
        expect(json.snapshot).not.toBeNull();
        expect(json.log_seq_start ?? 0).toBeGreaterThan(0);

        const pending = await storage.get(
          `app/t/tenant/${tenant}/manifests/${collection}/gc/pending.json`,
        );
        expect(pending).not.toBeNull();
      }
    }
  });

  test("maintenance failures on one pair don't block siblings", async () => {
    // Seed only the `good` tenant; the `bad` tenant has no
    // `current.json`. Wrap storage so the `bad` tenant's
    // `current.json` get throws — the helper must catch + log + keep
    // going so the `good` pair still runs to completion.
    const realStorage = new MemoryStorage();
    const seededKey = "app/t/tenant/good/manifests/c1/current.json";
    await createCurrentJson(realStorage, seededKey, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      next_seq: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "baerly-node-test", claimed_at: "" },
    });
    const writer = new ServerWriter({ storage: realStorage, currentJsonKey: seededKey });
    for (let i = 0; i < 200; i++) {
      await writer.commit({
        op: "I",
        collection: "c1",
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }

    const failingKey = "app/t/tenant/bad/manifests/c1/current.json";
    const flakyStorage: Storage = {
      get: (key, opts) => {
        if (key === failingKey) {
          return Promise.reject(new BaerlyError("NetworkError", "flaky storage simulated"));
        }
        return realStorage.get(key, opts);
      },
      put: (key, body, opts) => realStorage.put(key, body, opts),
      delete: (key, opts) => realStorage.delete(key, opts),
      list: (prefix, opts) => realStorage.list(prefix, opts),
    };

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const port = await reservePort();
    const handle = baerlyNode({
      app: "t",
      storage: flakyStorage,
      verifier: sharedDevVerifier,
      maintenance: {
        tenants: ["good", "bad"],
        collections: ["c1"],
        intervalMs: 50,
      },
    });
    activeHandle = handle;
    await handle.listen(port);

    await new Promise((r) => setTimeout(r, 250));

    // `bad` pair failed → logged to stderr.
    expect(stderrSpy).toHaveBeenCalled();
    const sawBadTenant = stderrSpy.mock.calls.some((args) =>
      args.some((a) => typeof a === "string" && a.includes("tenant=bad")),
    );
    expect(sawBadTenant).toBe(true);

    // `good` pair still ran to completion despite the sibling failure.
    const cur = await realStorage.get(seededKey);
    expect(cur).not.toBeNull();
    const json = JSON.parse(new TextDecoder().decode(cur!.body)) as {
      snapshot: string | null;
    };
    expect(json.snapshot).not.toBeNull();

    stderrSpy.mockRestore();
  });

  test("SIGTERM triggers graceful close + process.exit(0)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number): never => {
      // No-op; just record so the test process doesn't actually exit.
      return undefined as never;
    }) as typeof process.exit);

    const port = await reservePort();
    const handle = baerlyNode({
      app: "t",
      storage: new MemoryStorage(),
      verifier: sharedDevVerifier,
    });
    await handle.listen(port);

    process.emit("SIGTERM", "SIGTERM");
    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    exitSpy.mockRestore();
    // The signal-driven close already ran; `closed` makes the
    // afterEach close() a no-op, but null out to skip the redundant
    // attempt.
    activeHandle = undefined;
  });

  test("removes signal handlers on close()", async () => {
    const port = await reservePort();
    const handle = baerlyNode({
      app: "t",
      storage: new MemoryStorage(),
      verifier: sharedDevVerifier,
    });
    const sigtermBefore = process.listenerCount("SIGTERM");
    const sigintBefore = process.listenerCount("SIGINT");
    await handle.listen(port);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore + 1);
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore + 1);
    await handle.close();
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    activeHandle = undefined;
  });

  test("close() called mid-bind tears down without installing signal handlers", async () => {
    const port = await reservePort();
    const handle = baerlyNode({
      app: "t",
      storage: new MemoryStorage(),
      verifier: sharedDevVerifier,
      maintenance: {
        tenants: ["a"],
        collections: ["c1"],
        intervalMs: 50,
      },
    });
    const sigtermBefore = process.listenerCount("SIGTERM");
    const sigintBefore = process.listenerCount("SIGINT");

    const listenPromise = handle.listen(port);
    await handle.close();
    await listenPromise;

    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    activeHandle = undefined;
  });
});
