import { Server } from "node:http";
import { type AddressInfo, connect, createServer as createNetServer } from "node:net";
import {
  type BaerlyAppConfig,
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  MemoryStorage,
  PAAS_MARKERS,
  SHARED_SECRET_MISSING_MESSAGE,
  type Verifier,
} from "@baerly/protocol";
import { runWithContext } from "@baerly/server/observability";
import { createObservabilityContext } from "@baerly/server/_internal/observability";
import { Writer } from "@baerly/server/_internal/testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import { baerlyNode, type BaerlyNodeHandle } from "./baerly-node.ts";
import { provisionCollection } from "../../../tests/fixtures/log-state.ts";

const sharedDevVerifier: Verifier = async () => ({
  tenantPrefix: "test-tenant",
  identity: { sub: "dev" },
});

/**
 * Minimal-shape `BaerlyAppConfig` for tests that exercise an explicit
 * `verifier:` override — the override branch wins in `resolveVerifier`,
 * so `auth` is effectively placeholder for these cases.
 */
const testConfig: BaerlyAppConfig = {
  app: "t",
  tenant: "test-tenant",
  target: "node",
  auth: "none",
  collections: {},
};

/**
 * Reserve and immediately release an ephemeral port so the test can
 * bind `baerlyNode` to a known port and round-trip through it via
 * `fetch`. `baerlyNode.listen(0)` would let the OS pick a port, but
 * the helper deliberately doesn't expose the bound port — so we pick a
 * free one upfront.
 */
/** Tests bind the same address they fetch, so dual-stack resolution can't split them. */
const LOOPBACK = "127.0.0.1";

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

/** Send `GET /v1/healthz` as HTTP/1.0 with no Host header; resolve the status line. */
const hostlessHealthzStatusLine = (port: number): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const socket = connect(port, LOOPBACK, () => {
      socket.end("GET /v1/healthz HTTP/1.0\r\n\r\n");
    });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      data += chunk;
    });
    socket.on("end", () => resolve(data.split("\r\n")[0] ?? ""));
    socket.on("error", reject);
  });

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
      config: testConfig,
      storage: new MemoryStorage(),
      verifier: sharedDevVerifier,
    });
    activeHandle = handle;
    await handle.listen(port, { hostname: LOOPBACK });

    const res = await fetch(`http://127.0.0.1:${port}/v1/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("listen binds the server exactly once", async () => {
    // A second `listen()` on a server whose first bind is still pending
    // only works because the later call wins a race; one bind is the
    // contract.
    const listenSpy = vi.spyOn(Server.prototype, "listen");
    try {
      const port = await reservePort();
      const handle = baerlyNode({
        config: testConfig,
        storage: new MemoryStorage(),
        verifier: sharedDevVerifier,
      });
      activeHandle = handle;
      await handle.listen(port);
      expect(listenSpy).toHaveBeenCalledTimes(1);
      // No hostname binds every interface.
      const bound = (listenSpy.mock.contexts[0] as Server).address() as AddressInfo;
      expect(["::", "0.0.0.0"]).toContain(bound.address);
    } finally {
      listenSpy.mockRestore();
    }
  });

  test("listen binds only the given hostname", async () => {
    const listenSpy = vi.spyOn(Server.prototype, "listen");
    try {
      const port = await reservePort();
      const handle = baerlyNode({
        config: testConfig,
        storage: new MemoryStorage(),
        verifier: sharedDevVerifier,
      });
      activeHandle = handle;
      await handle.listen(port, { hostname: LOOPBACK });
      const bound = (listenSpy.mock.contexts[0] as Server).address() as AddressInfo;
      expect(bound).toMatchObject({ address: LOOPBACK, port });
    } finally {
      listenSpy.mockRestore();
    }
  });

  test("an HTTP/1.0 request without a Host header is served", async () => {
    // The request URL is built from Host; without one the listener
    // falls back to the bound hostname rather than answering 400.
    const port = await reservePort();
    const handle = baerlyNode({
      config: testConfig,
      storage: new MemoryStorage(),
      verifier: sharedDevVerifier,
    });
    activeHandle = handle;
    await handle.listen(port);
    await expect(hostlessHealthzStatusLine(port)).resolves.toMatch(/^HTTP\/1\.[01] 200 /);
  });

  test("an HTTP/1.0 request without a Host header is served on a given hostname", async () => {
    const port = await reservePort();
    const handle = baerlyNode({
      config: testConfig,
      storage: new MemoryStorage(),
      verifier: sharedDevVerifier,
    });
    activeHandle = handle;
    await handle.listen(port, { hostname: LOOPBACK });
    await expect(hostlessHealthzStatusLine(port)).resolves.toMatch(/^HTTP\/1\.[01] 200 /);
  });

  test("close() shuts down the server and is idempotent", async () => {
    const port = await reservePort();
    const handle = baerlyNode({
      config: testConfig,
      storage: new MemoryStorage(),
      verifier: sharedDevVerifier,
    });
    await handle.listen(port, { hostname: LOOPBACK });
    await handle.close();
    await expect(handle.close()).resolves.toBeUndefined();
    activeHandle = undefined;
  });

  test("rejects a `maintenance` option (cut — maintenance is in-band, not scheduled)", () => {
    baerlyNode({
      config: testConfig,
      storage: new MemoryStorage(),
      verifier: sharedDevVerifier,
      // @ts-expect-error — `maintenance` was cut: no `setInterval`/cron
      // scheduling option exists; compaction + GC run in-band on the
      // write path (see `nodeMaintenanceDispatch`).
      maintenance: { tenants: ["a"], collections: ["c1"] },
    });
  });

  test("listen() installs no timer — only the two signal handlers (no maintenance interval)", async () => {
    // A leaked `setInterval` would keep the event loop alive; this also
    // asserts there is no background loop racing the in-band write path.
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const port = await reservePort();
    const handle = baerlyNode({
      config: testConfig,
      storage: new MemoryStorage(),
      verifier: sharedDevVerifier,
    });
    activeHandle = handle;
    await handle.listen(port, { hostname: LOOPBACK });
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  test("a write through handle.fetch maintains in-band (no listen, no timer)", async () => {
    // Seed a collection with maintenance DISABLED (so the seed writes
    // leave a fat unfolded tail with a null snapshot), then issue ONE
    // write through the Hono fetch handler (no `.listen()` → no server,
    // no timer). The adapter threads a Node-tier maintenance dispatch
    // onto that request's observability context; the writer reads it at
    // its post-commit point and runs a bounded inline fold. We assert the
    // snapshot pointer flips null → non-null on that single write —
    // proving writes tick in-band (reads stay pure; see reads-pure.test).
    const storage = new MemoryStorage();
    const tenant = "test-tenant";
    const key = `app/t/tenant/${tenant}/manifests/c1/current.json`;
    await createCurrentJson(storage, key, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      tail_hint: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "baerly-node-test", claimed_at: "" },
      snapshot_bytes: 0,
      snapshot_rows: 0,
      // Pre-stamp a representative mean so the ratio TRIGGER's derived live-tail
      // estimate reflects these ~640-byte padded entries (512-byte pad + envelope)
      // from the first write — the compactor stamps this on the first real fold.
      // This is an adapter-WIRING test, not a cold-start test, so pre-stamping
      // keeps the small cold-start fallback from under-estimating the padded tail.
      mean_entry_bytes: 640,
    });
    const writer = new Writer({ storage, currentJsonKey: key });
    // Pad each body so the tail clears the 64 KB first-fold floor; seed
    // an ODD count so the single fetch write (prevSeq odd) also crosses
    // the GC cadence boundary — both maintenance arms are live.
    const pad = "x".repeat(512);
    await runWithContext(
      createObservabilityContext({ maintenance: { disabled: true } }),
      async () => {
        for (let i = 0; i < 201; i++) {
          await writer.commit({
            op: "I",
            collection: "c1",
            docId: `d${i}`,
            body: { _id: `d${i}`, n: i, pad },
          });
        }
      },
    );

    // Maintenance was disabled during seeding → snapshot still null.
    const before = await storage.get(key);
    const beforeJson = JSON.parse(new TextDecoder().decode(before!.body)) as {
      snapshot: string | null;
    };
    expect(beforeJson.snapshot).toBeNull();

    const handle = baerlyNode({
      config: testConfig,
      storage,
      verifier: sharedDevVerifier,
    });
    activeHandle = handle;

    // One write through the public fetch surface — runs the full
    // adapter cascade (obs context → verifier → Db → router → writer).
    const res = await handle.fetch(
      new Request("http://x/v1/c/c1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: { _id: "trigger", v: 1 } }),
      }),
    );
    expect(res.status).toBe(201);

    // The post-commit dispatch read `getCurrentContext()?.maintenance`
    // (set by the adapter) and ran a bounded inline fold.
    const cur = await storage.get(key);
    expect(cur).not.toBeNull();
    const json = JSON.parse(new TextDecoder().decode(cur!.body)) as {
      snapshot: string | null;
      log_seq_start?: number;
    };
    expect(json.snapshot).not.toBeNull();
    expect(json.log_seq_start ?? 0).toBeGreaterThan(0);
  });

  test("SIGTERM triggers graceful close + process.exit(0)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number): never => {
      // No-op; just record so the test process doesn't actually exit.
      return undefined as never;
    }) as typeof process.exit);

    const port = await reservePort();
    const handle = baerlyNode({
      config: testConfig,
      storage: new MemoryStorage(),
      verifier: sharedDevVerifier,
    });
    await handle.listen(port, { hostname: LOOPBACK });

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
      config: testConfig,
      storage: new MemoryStorage(),
      verifier: sharedDevVerifier,
    });
    const sigtermBefore = process.listenerCount("SIGTERM");
    const sigintBefore = process.listenerCount("SIGINT");
    await handle.listen(port, { hostname: LOOPBACK });
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore + 1);
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore + 1);
    await handle.close();
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    activeHandle = undefined;
  });

  test("handle.fetch serves requests without starting the http server or installing signal handlers", async () => {
    const sigtermBefore = process.listenerCount("SIGTERM");
    const sigintBefore = process.listenerCount("SIGINT");

    const handle = baerlyNode({
      config: testConfig,
      storage: new MemoryStorage(),
      verifier: sharedDevVerifier,
    });
    activeHandle = handle;

    // Round-trip through the Hono fetch handler directly; no port bind.
    const res = await handle.fetch(new Request("http://x/v1/healthz"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // No `listen()` → no SIGTERM/SIGINT listeners installed.
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
  });

  test("close() called mid-bind tears down without installing signal handlers", async () => {
    const port = await reservePort();
    const handle = baerlyNode({
      config: testConfig,
      storage: new MemoryStorage(),
      verifier: sharedDevVerifier,
    });
    const sigtermBefore = process.listenerCount("SIGTERM");
    const sigintBefore = process.listenerCount("SIGINT");

    const listenPromise = handle.listen(port, { hostname: LOOPBACK });
    await handle.close();
    await listenPromise;

    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    activeHandle = undefined;
  });
});

/**
 * `config.auth` synthesis suite. Asserts `baerlyNode` wires the
 * declared posture into a real `Verifier` when no `verifier:`
 * override is supplied. Node throws synchronously at `baerlyNode({...})`
 * for the "unset SHARED_SECRET" branch (resolution happens at factory
 * time, not first fetch — Node can throw at startup unlike CF Workers).
 */
describe("baerlyNode config.auth synthesis", () => {
  let activeHandle: BaerlyNodeHandle | undefined;
  afterEach(async () => {
    if (activeHandle !== undefined) {
      await activeHandle.close();
      activeHandle = undefined;
    }
  });

  test('auth: "none" without `verifier:` resolves every request to config.tenant', async () => {
    const tenant = "auth-none-tenant";
    const storage = new MemoryStorage();
    await provisionCollection(
      storage,
      `app/t/tenant/${tenant}/manifests/c/current.json`,
      "auth-none-test",
    );
    const config: BaerlyAppConfig = {
      app: "t",
      tenant,
      target: "node",
      auth: "none",
      collections: {},
    };
    const port = await reservePort();
    const handle = baerlyNode({ config, storage });
    activeHandle = handle;
    await handle.listen(port, { hostname: LOOPBACK });

    // No Authorization header — `auth: "none"` pins anonymously.
    const res = await fetch(`http://127.0.0.1:${port}/v1/c/c`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ doc: { _id: "none-1", v: 1 } }),
    });
    expect(res.status).toBe(201);
  });

  test('auth: "shared-secret" with env.SHARED_SECRET present accepts the bearer and rejects without', async () => {
    const tenant = "auth-ss-tenant";
    const storage = new MemoryStorage();
    await provisionCollection(
      storage,
      `app/t/tenant/${tenant}/manifests/c/current.json`,
      "auth-ss-test",
    );
    const config: BaerlyAppConfig = {
      app: "t",
      tenant,
      target: "node",
      auth: "shared-secret",
      collections: {},
    };
    vi.stubEnv("SHARED_SECRET", "topsecret");
    const port = await reservePort();
    const handle = baerlyNode({ config, storage });
    activeHandle = handle;
    await handle.listen(port, { hostname: LOOPBACK });

    const okRes = await fetch(`http://127.0.0.1:${port}/v1/c/c`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer topsecret",
      },
      body: JSON.stringify({ doc: { _id: "ss-1", v: 1 } }),
    });
    expect(okRes.status).toBe(201);

    const badRes = await fetch(`http://127.0.0.1:${port}/v1/c/c`);
    expect(badRes.status).toBe(401);
  });

  describe('auth: "none" startup line', () => {
    const noneConfig: BaerlyAppConfig = {
      app: "t",
      tenant: "banner-tenant",
      target: "node",
      auth: "none",
      collections: {},
    };
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });
    const stubLocalEnv = (): void => {
      vi.stubEnv("NODE_ENV", "test");
      for (const marker of PAAS_MARKERS) {
        vi.stubEnv(marker, "");
      }
    };

    test("logs at info level on a local machine", () => {
      stubLocalEnv();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      baerlyNode({ config: noneConfig, storage: new MemoryStorage({ ephemeral: true }) });
      expect(log).toHaveBeenCalledWith(expect.stringContaining("auth=none"));
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("auth=none"));
    });

    test("warns that every request gets full tenant access when deployed", () => {
      stubLocalEnv();
      vi.stubEnv("NODE_ENV", "production");
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      baerlyNode({ config: noneConfig, storage: new MemoryStorage({ ephemeral: true }) });
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/auth=none.*every request.*full access.*"banner-tenant"/),
      );
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining("auth=none"));
    });

    test("is silent when a verifier override is passed, even when deployed", () => {
      vi.stubEnv("NODE_ENV", "production");
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      baerlyNode({
        config: noneConfig,
        storage: new MemoryStorage({ ephemeral: true }),
        verifier: sharedDevVerifier,
      });
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining("auth=none"));
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("auth=none"));
    });
  });

  test('auth: "shared-secret" with missing env throws synchronously at baerlyNode() with the locked message', () => {
    const config: BaerlyAppConfig = {
      app: "t",
      tenant: "auth-ss-miss-tenant",
      target: "node",
      auth: "shared-secret",
      collections: {},
    };
    vi.stubEnv("SHARED_SECRET", undefined);
    expect(() => baerlyNode({ config, storage: new MemoryStorage() })).toThrow(
      SHARED_SECRET_MISSING_MESSAGE,
    );
  });
});
