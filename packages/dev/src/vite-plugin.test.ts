import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { BaerlyAppConfig } from "@baerly/protocol";
import { baerlyDev, baerlyDevAuth, loadDevVars } from "./vite-plugin.ts";

interface CapturedMw {
  (req: unknown, res: unknown, next: () => void): void;
}

interface FakeServer {
  middlewares: { use: (mw: CapturedMw) => void };
  httpServer: null;
}

// Duck-typed `ServerResponse` stand-in. Extends `node:stream.Writable`
// so the response-write loop in `@hono/node-server`'s
// `getRequestListener` (which uses manual `write`/`drain` coordination)
// gets the full Writable contract — `.once`, `.removeListener`,
// `.destroy`, drain semantics — without us hand-rolling each method.
// `writeHead` / `setHeader` / `statusCode` / `headers` mirror the bits
// of `http.ServerResponse` that Vite's connect-style middleware actually
// touches.
class MockRes extends Writable {
  statusCode = 0;
  finished = false;
  headers: Record<string, string> = {};
  written: string[] = [];

  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status;
    if (headers) {
      Object.assign(this.headers, headers);
    }
    return this;
  }

  setHeader(k: string, v: string): this {
    this.headers[k] = v;
    return this;
  }

  override _write(
    chunk: string | Uint8Array,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    this.written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    cb();
  }

  override _final(cb: (err?: Error | null) => void): void {
    this.finished = true;
    cb();
  }
}

const makeRes = (): MockRes => new MockRes();

interface FakeReq {
  url: string;
  method: string;
  headers: Record<string, string>;
  /**
   * Node's `http.IncomingMessage` exposes BOTH a parsed `headers` map AND
   * a wire-form `rawHeaders` array `[name1, value1, name2, value2, ...]`.
   * `@cloudflare/vite-plugin` builds its Fetch `Request` from `rawHeaders`,
   * so the mock must carry both — mutating only `headers` will silently
   * mask the bug this file regression-tests.
   */
  rawHeaders: string[];
  on: (event: string, cb: (...args: unknown[]) => void) => unknown;
}

const makeReq = (url: string, method = "GET"): FakeReq => {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    url,
    method,
    headers: { host: "localhost" },
    rawHeaders: ["Host", "localhost"],
    on(event, cb) {
      (listeners[event] ??= []).push(cb);
      if (event === "end") {
        cb();
      }
      return this;
    },
  };
};

/**
 * Reconstruct a Fetch `Headers` from `req.rawHeaders` the way
 * `@cloudflare/vite-plugin`'s `createHeaders()` does. Used by tests
 * to assert that wire-form readers see what `baerlyDevAuth` injected.
 */
const headersFromRaw = (req: FakeReq): Headers => {
  const h = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]!.startsWith(":")) {
      continue;
    }
    h.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
  }
  return h;
};

const baseConfig = (auth: BaerlyAppConfig["auth"]): BaerlyAppConfig => ({
  app: "test",
  tenant: "test",
  target: "node",
  auth,
  collections: { t: {} },
});

/**
 * Run `plugin.configureServer` against a capturing fake-server and
 * return the registered middleware. Each call yields a fresh
 * middleware array so per-test mutations stay isolated.
 */
const captureMiddleware = (plugin: ReturnType<typeof baerlyDev>): CapturedMw => {
  const captured: CapturedMw[] = [];
  const fakeServer: FakeServer = {
    middlewares: {
      use: (mw) => {
        captured.push(mw);
      },
    },
    httpServer: null,
  };
  const configureServer = plugin.configureServer;
  if (typeof configureServer !== "function") {
    throw new Error("configureServer must be a function");
  }
  configureServer.call(null as never, fakeServer as never);
  return captured[0]!;
};

let tmp: string;
let middlewares: CapturedMw[];

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "baerly-vite-plugin-"));
  middlewares = [];
  const fakeServer: FakeServer = {
    middlewares: {
      use: (mw) => {
        middlewares.push(mw);
      },
    },
    httpServer: null,
  };

  // Default fixture: `auth: "shared-secret"` exercises both the
  // listener-side verifier and the middleware bearer-injection
  // branch — the bulk of the dev-plugin contract surface. The
  // alternate `auth: "none"` and `verifier:` override branches get
  // dedicated tests below.
  const plugin = baerlyDev({
    config: baseConfig("shared-secret"),
    secret: "test-secret",
    dataDir: tmp,
    banner: false,
  });

  expect(plugin.name).toBe("baerly-dev");
  expect(plugin.apply).toBe("serve");

  const configureServer = plugin.configureServer;
  if (typeof configureServer !== "function") {
    throw new Error("configureServer must be a function");
  }
  configureServer.call(null as never, fakeServer as never);
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("baerlyDev() plugin", () => {
  test("registers exactly one middleware", () => {
    expect(middlewares.length).toBe(1);
  });

  test("falls through for non-/v1 paths", () => {
    const mw = middlewares[0]!;
    const cases = ["/index.html", "/", "/assets/foo.js", "/v1foo", "/v2"];
    for (const url of cases) {
      const req = makeReq(url);
      const res = makeRes();
      let nextCalled = 0;
      mw(req, res, () => {
        nextCalled += 1;
      });
      expect(nextCalled, `expected next() for ${url}`).toBe(1);
      expect(res.finished, `expected res not finished for ${url}`).toBe(false);
    }
  });

  test("routes /v1, /v1/..., /v1?... to the listener (no next())", async () => {
    const mw = middlewares[0]!;
    const cases = ["/v1", "/v1/", "/v1/healthz", "/v1?foo=bar", "/v1/c/t"];
    for (const url of cases) {
      const req = makeReq(url);
      const res = makeRes();
      let nextCalled = 0;
      mw(req, res, () => {
        nextCalled += 1;
      });
      // Wait a tick for the async listener to start writing.
      await new Promise((r) => setTimeout(r, 50));
      expect(nextCalled, `expected next() NOT called for ${url}`).toBe(0);
    }
  });

  test("listener serves /v1/healthz with 200", async () => {
    const mw = middlewares[0]!;
    const req = makeReq("/v1/healthz");
    const res = makeRes();
    mw(req, res, () => {
      throw new Error("next should not be called");
    });
    // Poll for the response to flush.
    for (let i = 0; i < 50; i += 1) {
      if (res.finished) {
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(res.statusCode).toBe(200);
    expect(res.written.join("")).toContain('"ok":true');
  });

  test("injects Authorization: Bearer <secret> before listener fires", async () => {
    const mw = middlewares[0]!;
    const req = makeReq("/v1/healthz");
    const res = makeRes();
    mw(req, res, () => {
      throw new Error("next should not be called");
    });
    // Wait a tick so we capture the post-mutation state synchronously
    // — the mutation happens before the async ready.then() resolves.
    expect(req.headers["authorization"]).toBe("Bearer test-secret");
  });
});

describe("baerlyDev — default dataDir", () => {
  test("defaults storage to <vite root>/.baerly-data when dataDir is omitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "baerly-vite-root-"));
    try {
      const captured: CapturedMw[] = [];
      const fakeServer = {
        middlewares: { use: (mw: CapturedMw) => captured.push(mw) },
        httpServer: null,
        config: { root },
      };
      // No `dataDir` — the plugin must derive it from server.config.root.
      const plugin = baerlyDev({
        config: baseConfig("shared-secret"),
        secret: "test-secret",
        banner: false,
      });
      const configureServer = plugin.configureServer;
      if (typeof configureServer !== "function") {
        throw new Error("configureServer must be a function");
      }
      configureServer.call(null as never, fakeServer as never);

      // Drive a request so the async `ready` (which builds the storage
      // rooted at <root>/.baerly-data and ensures the tables) completes.
      const mw = captured[0]!;
      const req = makeReq("/v1/healthz");
      const res = makeRes();
      mw(req, res, () => {
        throw new Error("next should not be called");
      });
      for (let i = 0; i < 50; i += 1) {
        if (existsSync(join(root, ".baerly-data"))) {
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(existsSync(join(root, ".baerly-data"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("baerlyDev — config loading", () => {
  // Fake server exposing the bits the config loader touches: `config.root`
  // (for the convention path + default dataDir) and a capturing `ssrLoadModule`.
  const makeServer = (
    root: string,
    loader: (id: string) => Promise<Record<string, unknown>>,
  ): { captured: CapturedMw[]; server: unknown } => {
    const captured: CapturedMw[] = [];
    return {
      captured,
      server: {
        middlewares: { use: (mw: CapturedMw) => captured.push(mw) },
        httpServer: null,
        config: { root },
        ssrLoadModule: loader,
      },
    };
  };

  const start = (plugin: ReturnType<typeof baerlyDev>, server: unknown): void => {
    const configureServer = plugin.configureServer;
    if (typeof configureServer !== "function") {
      throw new Error("configureServer must be a function");
    }
    configureServer.call(null as never, server as never);
  };

  // Kick a /v1 request and wait until `requested` is populated (the async
  // config load happens off the middleware's first matching request).
  const driveAndWait = async (captured: CapturedMw[], requested: string[]): Promise<void> => {
    captured[0]!(makeReq("/v1/healthz"), makeRes(), () => {});
    for (let i = 0; i < 50 && requested.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  test("loads config by convention from <root>/src/baerly.config.ts when config omitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "baerly-conv-"));
    try {
      const requested: string[] = [];
      const { captured, server } = makeServer(root, async (id) => {
        requested.push(id);
        return { default: baseConfig("none") };
      });
      start(baerlyDev({ banner: false }), server);
      await driveAndWait(captured, requested);
      expect(requested).toEqual([join(root, "src/baerly.config.ts")]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("loads config from configPath override when provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "baerly-cfgpath-"));
    try {
      const requested: string[] = [];
      const custom = join(root, "elsewhere", "baerly.config.ts");
      const { captured, server } = makeServer(root, async (id) => {
        requested.push(id);
        return { default: baseConfig("none") };
      });
      start(baerlyDev({ configPath: custom, banner: false }), server);
      await driveAndWait(captured, requested);
      expect(requested).toEqual([custom]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("explicit config object never calls ssrLoadModule", async () => {
    const root = await mkdtemp(join(tmpdir(), "baerly-explicit-"));
    try {
      const requested: string[] = [];
      const { captured, server } = makeServer(root, async (id) => {
        requested.push(id);
        return { default: baseConfig("none") };
      });
      start(baerlyDev({ config: baseConfig("none"), banner: false }), server);
      await driveAndWait(captured, requested);
      // The /v1 request routed (config came from the object), but the loader
      // was never consulted.
      expect(requested).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("config module with no default export surfaces a clear InvalidConfig message, not a bare TypeError", async () => {
    const root = await mkdtemp(join(tmpdir(), "baerly-nodefault-"));
    try {
      const { captured, server } = makeServer(root, async () => ({}));
      start(baerlyDev({ banner: false }), server);
      const res = makeRes();
      captured[0]!(makeReq("/v1/healthz"), res, () => {
        throw new Error("next should not be called");
      });
      for (let i = 0; i < 50 && res.statusCode === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.written.join("")) as { message: string };
      expect(body.message).toContain("must default-export a BaerlyAppConfig object");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("banner does not crash the process when lazy config load rejects", async () => {
    const root = await mkdtemp(join(tmpdir(), "baerly-bannerfail-"));
    try {
      const httpServer = new EventEmitter() as EventEmitter & { address: () => null };
      httpServer.address = () => null;
      const server = {
        middlewares: { use: () => {} },
        httpServer,
        config: { root },
        ssrLoadModule: async () => {
          throw new Error("boom");
        },
      };
      const rejections: unknown[] = [];
      const onRejection = (reason: unknown): void => {
        rejections.push(reason);
      };
      process.on("unhandledRejection", onRejection);
      try {
        start(baerlyDev({ banner: true }), server);
        httpServer.emit("listening");
        await new Promise((r) => setTimeout(r, 100));
        // Before the fix, the banner's `ready.then` had no rejection handler:
        // a distinct derived promise from the same rejected `ready` would go
        // unhandled here even though the setup failure is already logged.
        expect(rejections).toEqual([]);
      } finally {
        process.off("unhandledRejection", onRejection);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("baerlyDev — auth resolution", () => {
  const withDataDir = async (fn: (dataDir: string) => void | Promise<void>): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), "baerly-dev-auth-"));
    try {
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  test('auth: "none" → middleware does NOT inject Authorization on /v1/*', async () => {
    await withDataDir((dir) => {
      const plugin = baerlyDev({
        config: baseConfig("none"),
        dataDir: dir,
        banner: false,
      });
      const mw = captureMiddleware(plugin);
      const req = makeReq("/v1/foo");
      mw(req, makeRes(), () => {});
      expect(req.headers["authorization"]).toBeUndefined();
      expect(headersFromRaw(req).get("authorization")).toBeNull();
    });
  });

  test('auth: "shared-secret" + secret → middleware injects Bearer <secret>', async () => {
    await withDataDir((dir) => {
      const plugin = baerlyDev({
        config: baseConfig("shared-secret"),
        secret: "s3cr3t",
        dataDir: dir,
        banner: false,
      });
      const mw = captureMiddleware(plugin);
      const req = makeReq("/v1/foo");
      mw(req, makeRes(), () => {});
      expect(req.headers["authorization"]).toBe("Bearer s3cr3t");
      expect(headersFromRaw(req).get("authorization")).toBe("Bearer s3cr3t");
    });
  });

  test('auth: "shared-secret" + no secret → throws InvalidConfig at startup', async () => {
    await withDataDir((dir) => {
      expect(() =>
        baerlyDev({
          config: baseConfig("shared-secret"),
          dataDir: dir,
          banner: false,
        }),
      ).toThrow(/SHARED_SECRET/);
    });
  });

  test("verifier override wins over config.auth + does NOT inject Bearer", async () => {
    await withDataDir((dir) => {
      const plugin = baerlyDev({
        config: baseConfig("shared-secret"),
        secret: "ignored",
        verifier: async () => ({
          tenantPrefix: "x",
          identity: { kind: "test" },
        }),
        dataDir: dir,
        banner: false,
      });
      const mw = captureMiddleware(plugin);
      const req = makeReq("/v1/foo");
      mw(req, makeRes(), () => {});
      // Override owns the auth seam — no bearer injection.
      expect(req.headers["authorization"]).toBeUndefined();
    });
  });
});

describe("baerlyDevAuth", () => {
  const captureMw = (plugin: ReturnType<typeof baerlyDevAuth>): CapturedMw => {
    const mws: CapturedMw[] = [];
    const server = {
      middlewares: { use: (mw: CapturedMw) => mws.push(mw) },
      httpServer: null,
    };
    const configureServer = plugin.configureServer;
    if (typeof configureServer !== "function") {
      throw new Error("configureServer must be a function");
    }
    configureServer.call(null as never, server as never);
    return mws[0]!;
  };

  test("injects Authorization header on /v1/* requests", () => {
    const mw = captureMw(baerlyDevAuth({ secret: "test-secret" }));
    const req = makeReq("/v1/healthz");
    const res = makeRes();
    let nextCalled = 0;
    mw(req, res, () => {
      nextCalled += 1;
    });
    expect(req.headers["authorization"]).toBe("Bearer test-secret");
    expect(nextCalled).toBe(1);
  });

  // Regression: `@cloudflare/vite-plugin` builds the in-process Worker's
  // Fetch `Request` from `req.rawHeaders`, not `req.headers`. Mutating
  // only the parsed view silently drops the bearer token — the worker's
  // verifier then returns 401. This test pins the wire-form contract by
  // reconstructing the Headers object the same way the cloudflare plugin
  // does (see node_modules/@cloudflare/vite-plugin/dist/index.mjs:1550).
  test("mutates rawHeaders so wire-form Headers reads the bearer", () => {
    const mw = captureMw(baerlyDevAuth({ secret: "test-secret" }));
    const req = makeReq("/v1/healthz");
    mw(req, makeRes(), () => {});
    expect(headersFromRaw(req).get("authorization")).toBe("Bearer test-secret");
  });

  test("replaces an existing Authorization in rawHeaders (no duplication)", () => {
    const mw = captureMw(baerlyDevAuth({ secret: "test-secret" }));
    const req = makeReq("/v1/healthz");
    // Simulate a stale Authorization on the inbound request — the
    // injected secret must REPLACE it, otherwise `Headers.append` would
    // concat the values with ", " and the verifier would 401.
    req.headers["authorization"] = "Bearer stale";
    req.rawHeaders.push("authorization", "Bearer stale");
    mw(req, makeRes(), () => {});
    expect(req.headers["authorization"]).toBe("Bearer test-secret");
    expect(headersFromRaw(req).get("authorization")).toBe("Bearer test-secret");
    // Count occurrences of the (case-insensitive) authorization slot.
    let count = 0;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i]!.toLowerCase() === "authorization") {
        count += 1;
      }
    }
    expect(count).toBe(1);
  });

  test("leaves non-/v1 requests alone (rawHeaders untouched)", () => {
    const mw = captureMw(baerlyDevAuth({ secret: "test-secret" }));
    const req = makeReq("/index.html");
    const before = [...req.rawHeaders];
    mw(req, makeRes(), () => {});
    expect(req.headers["authorization"]).toBeUndefined();
    expect(req.rawHeaders).toEqual(before);
  });

  test("apply is 'serve' so prod builds skip injection entirely", () => {
    const plugin = baerlyDevAuth({ secret: "test-secret" });
    expect(plugin.apply).toBe("serve");
  });

  test("respects custom prefix", () => {
    const mw = captureMw(baerlyDevAuth({ secret: "x", prefix: "/api" }));
    const req = makeReq("/api/foo");
    mw(req, makeRes(), () => {});
    expect(req.headers["authorization"]).toBe("Bearer x");
    expect(headersFromRaw(req).get("authorization")).toBe("Bearer x");
  });

  // Regression: the default surface area must cover BOTH `/v1/*` (the
  // baerly cascade) AND `/api/*` (the canonical extension namespace).
  // The "/api/* 401-trap" — agent adds a custom route, scaffold's
  // vite.config.ts calls `baerlyDevAuth({ secret })` with no `prefix`
  // override, browser silently 401s, `pnpm verify` exits green — has
  // recurred three times in the wild despite explicit warnings in
  // AGENTS.md. Widening the default closes the trap; consumers who
  // want `/v1`-only behavior can pass `prefix: "/v1"` explicitly.
  test("default prefix covers /v1 AND /api so custom routes work out-of-box", () => {
    const mw = captureMw(baerlyDevAuth({ secret: "x" }));

    const v1Req = makeReq("/v1/c/notes");
    mw(v1Req, makeRes(), () => {});
    expect(v1Req.headers["authorization"]).toBe("Bearer x");

    const apiReq = makeReq("/api/notes/search");
    mw(apiReq, makeRes(), () => {});
    expect(apiReq.headers["authorization"]).toBe("Bearer x");

    // Paths outside the default prefixes remain untouched.
    const indexReq = makeReq("/index.html");
    mw(indexReq, makeRes(), () => {});
    expect(indexReq.headers["authorization"]).toBeUndefined();
  });

  test("array prefix covers multiple roots (default /v1 + custom /api)", () => {
    const mw = captureMw(baerlyDevAuth({ secret: "x", prefix: ["/v1", "/api"] }));

    const v1Req = makeReq("/v1/c/notes");
    mw(v1Req, makeRes(), () => {});
    expect(v1Req.headers["authorization"]).toBe("Bearer x");

    const apiReq = makeReq("/api/cards/abc/move");
    mw(apiReq, makeRes(), () => {});
    expect(apiReq.headers["authorization"]).toBe("Bearer x");

    // Paths outside both prefixes remain untouched.
    const indexReq = makeReq("/index.html");
    mw(indexReq, makeRes(), () => {});
    expect(indexReq.headers["authorization"]).toBeUndefined();
  });

  test("rejects empty secret eagerly", () => {
    expect(() => baerlyDevAuth({ secret: "" })).toThrow(/secret must be non-empty/);
  });
});

describe("loadDevVars", () => {
  test("parses k=v pairs with comments, blank lines, and quoting", () => {
    const dir = mkdtempSync(join(tmpdir(), "devvars-"));
    const file = join(dir, ".dev.vars");
    writeFileSync(
      file,
      `# top comment\n\nFOO=bar\nBAZ="quoted value"\nEMPTY=\n# trailing\n`,
      "utf8",
    );
    try {
      expect(loadDevVars(file, "FOO", "BAZ", "EMPTY")).toEqual({
        FOO: "bar",
        BAZ: "quoted value",
        EMPTY: "",
      });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("missing keys come back as undefined", () => {
    const dir = mkdtempSync(join(tmpdir(), "devvars-"));
    const file = join(dir, ".dev.vars");
    writeFileSync(file, `FOO=bar\n`, "utf8");
    try {
      expect(loadDevVars(file, "FOO", "MISSING")).toEqual({
        FOO: "bar",
        MISSING: undefined,
      });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("returns requested keys as undefined when the file does not exist", () => {
    expect(loadDevVars("/no/such/file.dev.vars", "SHARED_SECRET")).toEqual({
      SHARED_SECRET: undefined,
    });
  });

  test("return type narrows to the requested key union", () => {
    // Compile-time check: property access works under
    // noPropertyAccessFromIndexSignature because the return type
    // is keyed by the literal `K` we pass in.
    const vars = loadDevVars("/no/such/file", "SHARED_SECRET");
    const value: string | undefined = vars.SHARED_SECRET;
    expect(value).toBeUndefined();
  });
});
