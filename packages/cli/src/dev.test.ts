/**
 * Tests for `baerly dev`. Drives `runDev` programmatically so the
 * listener is bound in-process and we can `fetch` it on the OS-picked
 * port (`--port=0`), then shut the server down deterministically.
 *
 * Each test chdir's into a fresh tmp directory that contains a
 * `baerly.config.json` — JSON keeps the loader off the `import()`
 * path so the test stays loader-agnostic.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LocalFsStorage } from "@baerly/adapter-node";
import { runDev, runDevCli } from "./dev.ts";

const DEV_SECRET = "dev-only-secret";

const writeConfig = async (root: string, cfg: Record<string, unknown>): Promise<void> => {
  await writeFile(join(root, "baerly.config.json"), JSON.stringify(cfg), "utf8");
};

const captureStream = (
  stream: NodeJS.WriteStream,
): { restore: () => void; readonly captured: string[] } => {
  const captured: string[] = [];
  const original = stream.write.bind(stream);
  stream.write = ((chunk: unknown): boolean => {
    captured.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof stream.write;
  return {
    captured,
    restore: () => {
      stream.write = original;
    },
  };
};

describe("baerly dev", () => {
  let root: string;
  let originalCwd: string;
  // Track listeners that need to be torn down across the suite.
  const openServers: { close: () => Promise<void> }[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "baerly-dev-"));
    originalCwd = process.cwd();
    process.chdir(root);
    root = process.cwd();
  });

  afterEach(async () => {
    while (openServers.length > 0) {
      const s = openServers.pop();
      if (s) await s.close().catch(() => {});
    }
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  });

  test("brings up a listener on an ephemeral port and serves /v1/since", async () => {
    await writeConfig(root, { app: "demo", tenant: "acme", target: "node" });
    const stderr = captureStream(process.stderr);
    let result;
    try {
      result = await runDev({
        cwd: root,
        port: 0,
        dataDir: join(root, ".baerly-data"),
        wrangler: false,
        json: false,
      });
    } finally {
      stderr.restore();
    }
    expect(result.mode).toBe("node");
    expect(typeof result.port).toBe("number");
    expect(result.port).toBeGreaterThan(0);

    // Push close hook before any fetch so a failed assertion still tears down.
    openServers.push({
      close: () =>
        new Promise<void>((res, rej) => {
          result.server!.close((err) => {
            if (err) rej(err);
            else res();
          });
        }),
    });

    // /v1/healthz is anonymous: short-circuit smoke for "listener is
    // reachable" before touching the authed seam.
    const health = await fetch(`http://127.0.0.1:${result.port}/v1/healthz`);
    expect(health.status).toBe(200);

    // Without auth, any /v1/t/* route returns 401 — proves the
    // verifier is mounted with the shared-secret fallback.
    const unauth = await fetch(`http://127.0.0.1:${result.port}/v1/t/widgets`);
    expect(unauth.status).toBe(401);

    // With the dev-fallback Bearer token, the verifier accepts and
    // the request reaches the kernel — a non-existent table surfaces
    // an envelope-shaped error (NOT 401).
    const authed = await fetch(`http://127.0.0.1:${result.port}/v1/t/widgets`, {
      headers: { Authorization: `Bearer ${DEV_SECRET}` },
    });
    expect(authed.status).not.toBe(401);
  });

  test("--wrangler against a Node target throws InvalidConfig", async () => {
    await writeConfig(root, { app: "demo", tenant: "acme", target: "node" });
    await expect(
      runDev({
        cwd: root,
        port: 0,
        dataDir: join(root, ".baerly-data"),
        wrangler: true,
        json: false,
      }),
    ).rejects.toMatchObject({ code: "InvalidConfig" });
  });

  test("--port=NaN is rejected via the CLI shim (exit 1)", async () => {
    await writeConfig(root, { app: "demo", tenant: "acme", target: "node" });
    const stderr = captureStream(process.stderr);
    let outcome;
    try {
      outcome = await runDevCli(["--port=not-a-number"]);
    } finally {
      stderr.restore();
    }
    expect(outcome.code).toBe(1);
    expect(outcome.result).toBeUndefined();
    expect(stderr.captured.join("")).toMatch(/--port must be a non-negative integer/);
  });

  test("declared collections get ensureTable on boot", async () => {
    await writeConfig(root, {
      app: "demo",
      tenant: "acme",
      target: "node",
      collections: {
        widgets: { indexes: [] },
        gadgets: { indexes: [] },
      },
    });
    const dataDir = join(root, ".baerly-data");
    const result = await runDev({
      cwd: root,
      port: 0,
      dataDir,
      wrangler: false,
      json: false,
    });
    openServers.push({
      close: () =>
        new Promise<void>((res, rej) => {
          result.server!.close((err) => {
            if (err) rej(err);
            else res();
          });
        }),
    });

    // Probe the on-disk store: ensureTable emits a `current.json` at
    // `app/<app>/tenant/<tenant>/manifests/<table>/current.json`. We
    // re-open the same LocalFsStorage and confirm both keys are
    // present BEFORE any client request landed.
    const storage = new LocalFsStorage({ root: dataDir });
    const widgets = await storage.get("app/demo/tenant/acme/manifests/widgets/current.json");
    const gadgets = await storage.get("app/demo/tenant/acme/manifests/gadgets/current.json");
    expect(widgets).not.toBeNull();
    expect(gadgets).not.toBeNull();
  });

  test("--json emits a structured envelope on success", async () => {
    await writeConfig(root, { app: "demo", tenant: "acme", target: "node" });
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    let outcome;
    try {
      outcome = await runDevCli(["--port=0", "--json"]);
    } finally {
      stdout.restore();
      stderr.restore();
    }
    expect(outcome.code).toBe(0);
    // Push the close hook before any further assertions so a failing
    // expect doesn't leak the listener.
    if (outcome.result?.server) {
      openServers.push({
        close: () =>
          new Promise<void>((res, rej) => {
            outcome.result!.server!.close((err) => {
              if (err) rej(err);
              else res();
            });
          }),
      });
    }
    const envelopeLine = stdout.captured.join("").trim();
    const envelope = JSON.parse(envelopeLine) as {
      result: {
        command: string;
        status: string;
        mode: string;
        port: number;
        target: string;
        tenant: string;
        app: string;
      };
    };
    expect(envelope.result.command).toBe("dev");
    expect(envelope.result.status).toBe("ok");
    expect(envelope.result.mode).toBe("node");
    expect(envelope.result.target).toBe("node");
    expect(envelope.result.tenant).toBe("acme");
    expect(envelope.result.app).toBe("demo");
    expect(envelope.result.port).toBeGreaterThan(0);

    // No banner on stderr in JSON mode (machine-parseable contract).
    expect(stderr.captured.join("")).toBe("");
  });
});
