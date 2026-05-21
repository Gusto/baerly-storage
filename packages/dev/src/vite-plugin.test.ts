import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
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

const makeReq = (
  url: string,
  method = "GET",
): {
  url: string;
  method: string;
  headers: Record<string, string>;
  on: (event: string, cb: (...args: unknown[]) => void) => unknown;
} => {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    url,
    method,
    headers: { host: "localhost" },
    on(event, cb) {
      (listeners[event] ??= []).push(cb);
      if (event === "end") {
        cb();
      }
      return this;
    },
  };
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

  const plugin = baerlyDev({
    app: "test",
    tenant: "test",
    secret: "test-secret",
    dataDir: tmp,
    tables: ["t"],
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
    const cases = ["/v1", "/v1/", "/v1/healthz", "/v1?foo=bar", "/v1/t/t"];
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

  test("leaves non-/v1 requests alone", () => {
    const mw = captureMw(baerlyDevAuth({ secret: "test-secret" }));
    const req = makeReq("/index.html");
    const res = makeRes();
    mw(req, res, () => {});
    expect(req.headers["authorization"]).toBeUndefined();
  });

  test("apply is 'serve' so prod builds skip injection entirely", () => {
    const plugin = baerlyDevAuth({ secret: "test-secret" });
    expect(plugin.apply).toBe("serve");
  });

  test("respects custom prefix", () => {
    const mw = captureMw(baerlyDevAuth({ secret: "x", prefix: "/api" }));
    const req = makeReq("/api/foo");
    const res = makeRes();
    mw(req, res, () => {});
    expect(req.headers["authorization"]).toBe("Bearer x");
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
      expect(loadDevVars(file)).toEqual({ FOO: "bar", BAZ: "quoted value", EMPTY: "" });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("returns empty object when the file does not exist", () => {
    expect(loadDevVars("/no/such/file.dev.vars")).toEqual({});
  });
});
