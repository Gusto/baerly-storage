/**
 * Tests for `baerly dev`. Drives `runDev` programmatically so the
 * listener is bound in-process and we can `fetch` it on the OS-picked
 * port (`--port=0`), then shut the server down deterministically.
 *
 * Each test chdir's into a fresh tmp directory that contains a
 * `baerly.config.json` — JSON keeps the loader off the `import()`
 * path so the test stays loader-agnostic.
 */

import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LocalFsStorage } from "@baerly/dev";
import { installShutdownHandlers, runDev, runDevCli } from "./dev.ts";

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
      if (s) {
        await s.close().catch(() => {});
      }
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
          result.server.close((err) => {
            if (err) {
              rej(err);
            } else {
              res();
            }
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
      json: false,
    });
    openServers.push({
      close: () =>
        new Promise<void>((res, rej) => {
          result.server.close((err) => {
            if (err) {
              rej(err);
            } else {
              res();
            }
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

  test("auto-increments to the next free port when the requested port is in use", async () => {
    await writeConfig(root, { app: "demo", tenant: "acme", target: "node" });
    // Bind a blocker on an OS-picked port (no interface arg → same family
    // resolution as runDev's `server.listen(N)`, so the conflict is guaranteed
    // on every platform).
    const blocker = createServer();
    await new Promise<void>((res, rej) => {
      blocker.once("error", rej);
      blocker.listen(0, () => {
        blocker.off("error", rej);
        res();
      });
    });
    const blockerAddr = blocker.address();
    const blockerPort =
      typeof blockerAddr === "object" && blockerAddr !== null ? blockerAddr.port : 0;
    try {
      const stderr = captureStream(process.stderr);
      let result;
      try {
        result = await runDev({
          cwd: root,
          port: blockerPort,
          dataDir: join(root, ".baerly-data"),
          json: false,
        });
      } finally {
        stderr.restore();
      }
      openServers.push({
        close: () =>
          new Promise<void>((res, rej) => {
            result.server.close((err) => {
              if (err) {
                rej(err);
              } else {
                res();
              }
            });
          }),
      });
      expect(result.port).not.toBe(blockerPort);
      expect(result.port).toBeGreaterThan(blockerPort);
      // First-touch UX: the fallback should be visible, not silent.
      expect(stderr.captured.join("")).toMatch(/in use/);
    } finally {
      await new Promise<void>((res) => blocker.close(() => res()));
    }
  });

  test("emits a clear actionable error when every fallback port is in use", async () => {
    await writeConfig(root, { app: "demo", tenant: "acme", target: "node" });
    // Hold a wide-enough contiguous range to exhaust the fallback window.
    // runDev tries port..port+9 (10 attempts) by design; we hold 10 starting
    // from an OS-picked base. No interface arg → match runDev's family
    // resolution so the conflict is guaranteed on macOS + Linux.
    const blockers: Server[] = [];
    const bind = (port: number): Promise<number> =>
      new Promise((res, rej) => {
        const s = createServer();
        s.once("error", rej);
        s.listen(port, () => {
          s.off("error", rej);
          const a = s.address();
          blockers.push(s);
          res(typeof a === "object" && a !== null ? a.port : port);
        });
      });
    const basePort = await bind(0);
    for (let i = 1; i < 10; i++) {
      // Mid-range collisions with unrelated host services are tolerated;
      // we only need enough of the window held that runDev exhausts attempts.
      try {
        await bind(basePort + i);
      } catch {
        // ignore — host-process race, not a test failure
      }
    }
    try {
      const stderr = captureStream(process.stderr);
      let outcome;
      try {
        outcome = await runDevCli([`--port=${basePort}`]);
      } finally {
        stderr.restore();
      }
      // Defensive cleanup if implementation accidentally bound something.
      if (outcome.result?.server) {
        openServers.push({
          close: () =>
            new Promise<void>((res, rej) => {
              outcome.result!.server.close((err) => {
                if (err) {
                  rej(err);
                } else {
                  res();
                }
              });
            }),
        });
        throw new Error("expected listener to fail, but it bound");
      }
      expect(outcome.code).not.toBe(0);
      const stderrText = stderr.captured.join("");
      expect(stderrText).toMatch(/in use/);
      expect(stderrText).toMatch(/--port/);
      expect(stderrText).toMatch(/lsof/);
      // Must NOT be the dreaded `Unknown:` wrapper.
      expect(stderrText).not.toMatch(/Unknown/);
    } finally {
      await Promise.all(
        blockers.map(
          (s) =>
            new Promise<void>((res) => {
              s.close(() => res());
            }),
        ),
      );
    }
  });

  describe("installShutdownHandlers", () => {
    test("closes the server on SIGHUP", async () => {
      const emitter = new EventEmitter();
      let closeCalls = 0;
      const exits: number[] = [];
      const fakeServer = {
        close: (cb?: (err?: Error) => void) => {
          closeCalls++;
          cb?.();
        },
      };
      const uninstall = installShutdownHandlers(fakeServer as unknown as Server, {
        proc: emitter as unknown as NodeJS.EventEmitter,
        getPpid: () => 1000,
        originalPpid: 1000,
        ppidPollMs: 1_000_000,
        exit: (c) => exits.push(c),
      });
      try {
        emitter.emit("SIGHUP");
        expect(closeCalls).toBe(1);
        expect(exits).toEqual([0]);
        // Idempotent: second SIGHUP must not double-close.
        emitter.emit("SIGHUP");
        expect(closeCalls).toBe(1);
      } finally {
        uninstall();
      }
    });

    test("exits when the parent process dies and we get reparented", async () => {
      const emitter = new EventEmitter();
      let closeCalls = 0;
      const exits: number[] = [];
      let ppid = 5000;
      const fakeServer = {
        close: (cb?: (err?: Error) => void) => {
          closeCalls++;
          cb?.();
        },
      };
      const uninstall = installShutdownHandlers(fakeServer as unknown as Server, {
        proc: emitter as unknown as NodeJS.EventEmitter,
        getPpid: () => ppid,
        originalPpid: 5000,
        ppidPollMs: 5,
        exit: (c) => exits.push(c),
      });
      try {
        ppid = 1; // simulate reparent-to-init (the exact 3-day-zombie symptom)
        await new Promise((r) => setTimeout(r, 40));
        expect(closeCalls).toBe(1);
        expect(exits).toEqual([0]);
      } finally {
        uninstall();
      }
    });

    test("uninstall removes signal listeners and stops the watcher", () => {
      const emitter = new EventEmitter();
      let closeCalls = 0;
      const exits: number[] = [];
      const fakeServer = {
        close: (cb?: (err?: Error) => void) => {
          closeCalls++;
          cb?.();
        },
      };
      const uninstall = installShutdownHandlers(fakeServer as unknown as Server, {
        proc: emitter as unknown as NodeJS.EventEmitter,
        getPpid: () => 100,
        originalPpid: 100,
        ppidPollMs: 1_000_000,
        exit: (c) => exits.push(c),
      });
      expect(emitter.listenerCount("SIGHUP")).toBe(1);
      expect(emitter.listenerCount("SIGINT")).toBe(1);
      expect(emitter.listenerCount("SIGTERM")).toBe(1);
      uninstall();
      expect(emitter.listenerCount("SIGHUP")).toBe(0);
      expect(emitter.listenerCount("SIGINT")).toBe(0);
      expect(emitter.listenerCount("SIGTERM")).toBe(0);
      // After uninstall, signals are no-ops.
      emitter.emit("SIGHUP");
      expect(closeCalls).toBe(0);
      expect(exits).toEqual([]);
    });
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
            outcome.result!.server.close((err) => {
              if (err) {
                rej(err);
              } else {
                res();
              }
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
