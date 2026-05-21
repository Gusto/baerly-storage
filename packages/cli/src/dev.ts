/**
 * `baerly dev` — unified local-development verb.
 *
 * Boots a Node `http.Server` over `LocalFsStorage` regardless of the
 * configured deploy target. The canonical day-1 path is:
 *
 *   $ npm create baerly@latest my-app
 *   $ cd my-app && pnpm install
 *   $ pnpm dev   # → baerly dev → http://localhost:3000
 *
 * The default path needs zero external binaries. For CF-target
 * parity testing, run the scaffold's own `pnpm dev` which boots
 * `vite dev` with `@cloudflare/vite-plugin` (the plugin replaces the
 * legacy `wrangler dev` workflow); `baerly dev` itself stays on the
 * Node + LocalFsStorage path so it works uniformly across all
 * deploy targets.
 *
 * Args:
 *   --port=<n>         Listen port. Default 3000.
 *   --data-dir=<path>  `LocalFsStorage` root. Default `./.baerly-data`.
 *   --json             Emit a JSON envelope to stdout on boot.
 *
 * Exit codes (per `packages/cli/README.md`):
 *   0 — listener bound (the process stays alive serving requests).
 *   1 — InvalidConfig (bad `--port`, missing/invalid `baerly.config.ts`).
 *   2 — storage / network / unknown.
 *   3 — protocol invariant.
 *
 * The verifier always uses `sharedSecret` in dev. The secret reads
 * from `BAERLY_DEV_SECRET` and falls back to a literal `"dev-only-
 * secret"` so a fresh `pnpm dev` works without any env wiring.
 */

import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { defineCommand, parseArgs, type ArgsDef, type ParsedArgs } from "citty";
import { createApp } from "@baerly/adapter-node";
import { LocalFsStorage, ensureTable, printDevBanner } from "@baerly/dev";
import { BaerlyError } from "@baerly/protocol";
import { sharedSecret } from "@baerly/server/auth";
import { loadAppConfigWithCollections } from "./config.ts";
import { emitError, emitSuccess, isJsonMode, setJsonMode } from "./output.ts";

const DEFAULT_PORT = 3000;
const DEFAULT_DATA_DIR = "./.baerly-data";
const DEV_SECRET_FALLBACK = "dev-only-secret";
/** Match Vite / Next / Astro: try N consecutive ports before erroring. */
const PORT_FALLBACK_ATTEMPTS = 10;
/** Poll cadence for detecting the parent-shell-died → reparent-to-init case. */
const PPID_POLL_MS = 2_000;

const DEV_ARGS = {
  port: {
    type: "string",
    required: false,
    description: "Listen port (default 3000).",
    valueHint: "n",
  },
  "data-dir": {
    type: "string",
    required: false,
    description: "LocalFsStorage root (default ./.baerly-data).",
    valueHint: "path",
  },
  json: { type: "boolean", description: "Emit JSON envelope to stdout." },
} as const satisfies ArgsDef;

// citty 0.2.2 auto-injects a camelCase alias for every kebab-case
// flag (`--data-dir` produces both `data-dir` and `dataDir` on the
// parsed args), so `dataDir` must be accepted alongside `data-dir`.
const KNOWN_KEYS: ReadonlySet<string> = new Set(["port", "data-dir", "dataDir", "json", "_"]);

const errorToExitCode = (code: string): number => {
  if (code === "InvalidConfig") {
    return 1;
  }
  if (code === "Conflict" || code === "Internal" || code === "InvalidResponse") {
    return 3;
  }
  return 2;
};

/**
 * Outcome of a successful `runDev` invocation. Carries the bound
 * port (`server.address()` is observed AFTER the `listening` event
 * fires, so `port: 0` callers get the OS-picked port back).
 */
export interface DevResult {
  readonly mode: "node";
  readonly port: number;
  readonly dataDir: string;
  readonly target: "cloudflare" | "node";
  readonly tenant: string;
  readonly app: string;
  /** Set so test harnesses can shut the server down deterministically. */
  readonly server: Server;
}

/**
 * Programmatic entry point. Returns a {@link DevResult} after the
 * listener is bound. Does NOT block on the server staying up — the
 * caller keeps the event loop busy via the returned `server`.
 *
 * @throws BaerlyError code="InvalidConfig" — `loadAppConfig` rejected.
 */
export const runDev = async (opts: {
  readonly cwd?: string;
  readonly port: number;
  readonly dataDir: string;
  readonly json: boolean;
}): Promise<DevResult> => {
  const cwd = opts.cwd ?? process.cwd();
  const { config, collections } = await loadAppConfigWithCollections(cwd);

  const dataDir = resolve(cwd, opts.dataDir);
  const storage = new LocalFsStorage({ root: dataDir });
  const tenant = config.tenant;
  const secret = process.env["BAERLY_DEV_SECRET"] ?? DEV_SECRET_FALLBACK;
  const verifier = sharedSecret({ secret, tenantPrefix: tenant });

  // If config declares collections, ensure each table exists in the
  // local store before the listener serves any request. Loader only
  // returns `collections` when the config exposed them as an object;
  // a config that omits the field is a no-op (no manifest seeded).
  if (collections !== undefined) {
    for (const collection of collections) {
      await ensureTable(storage, { app: config.app, tenant, table: collection.name });
    }
  }

  const app = createApp({ app: config.app, storage, verifier });
  const server = createServer(getRequestListener(app.fetch));
  const boundPort = await listenWithFallback(server, opts.port, !opts.json);
  // Wire OS-signal + parent-death shutdown so a `pnpm dev` whose
  // controlling shell dies abruptly doesn't leave an orphaned zombie
  // holding :3000 (the symptom that triggered this whole code path).
  // Auto-detach when the server closes so repeated `runDev` calls in
  // tests don't accumulate listeners on `process`.
  const uninstall = installShutdownHandlers(server);
  server.once("close", uninstall);

  if (!opts.json) {
    printDevBanner({
      name: config.app,
      apiUrl: { label: "api", url: `http://localhost:${boundPort}` },
      hints: [
        { key: "data-dir", value: dataDir },
        { key: "tenant", value: tenant },
        { key: "target", value: config.target },
        {
          key: "verifier",
          value:
            process.env["BAERLY_DEV_SECRET"] !== undefined
              ? "sharedSecret (BAERLY_DEV_SECRET)"
              : "sharedSecret (fallback dev-only-secret)",
        },
      ],
    });
  }

  return {
    mode: "node",
    port: boundPort,
    dataDir,
    target: config.target,
    tenant,
    app: config.app,
    server,
  };
};

/**
 * Outcome of running the citty body. `code` is the exit code (per the
 * `packages/cli/README.md` contract); `result` is the `runDev` return
 * (or `undefined` on failure) so test harnesses can shut the bound
 * listener down deterministically.
 */
export interface HandleDevOutcome {
  readonly code: number;
  readonly result?: DevResult;
}

const handleDev = async (args: ParsedArgs<typeof DEV_ARGS>): Promise<HandleDevOutcome> => {
  setJsonMode(args.json === true);
  try {
    for (const k of Object.keys(args)) {
      if (!KNOWN_KEYS.has(k)) {
        throw new BaerlyError("InvalidConfig", `baerly dev: unknown flag --${k}`);
      }
    }
    const portStr = args.port;
    const port = portStr !== undefined ? Number.parseInt(portStr, 10) : DEFAULT_PORT;
    if (!Number.isFinite(port) || port < 0 || !Number.isInteger(port)) {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly dev: --port must be a non-negative integer (got ${JSON.stringify(portStr)})`,
      );
    }
    const dataDir = args["data-dir"] ?? DEFAULT_DATA_DIR;
    const result = await runDev({
      port,
      dataDir,
      json: args.json === true,
    });
    if (isJsonMode()) {
      emitSuccess({
        command: "dev",
        status: "ok",
        mode: result.mode,
        port: result.port,
        dataDir: result.dataDir,
        target: result.target,
        tenant: result.tenant,
        app: result.app,
      });
    }
    return { code: 0, result };
  } catch (error) {
    if (error instanceof BaerlyError) {
      emitError("dev", error.code, error.message);
      return { code: errorToExitCode(error.code) };
    }
    emitError("dev", "Unknown", (error as Error).message);
    return { code: 2 };
  }
};

/** citty `defineCommand` block for `baerly dev`. */
export const dev = defineCommand({
  meta: {
    name: "dev",
    description: "Boot a local Node listener over LocalFsStorage on http://localhost:3000.",
  },
  args: DEV_ARGS,
  run: async ({ args }) => {
    const { code } = await handleDev(args);
    if (code !== 0) {
      process.exit(code);
    }
    // The server's open socket keeps the event loop alive — do not
    // call process.exit(0).
  },
});

/**
 * Programmatic entry used by tests. Bypasses citty's `run` wrapper
 * (which would call `process.exit` and kill vitest) and returns both
 * the integer exit code and the `runDev` result so tests can shut the
 * bound listener down.
 */
export const runDevCli = async (argv: readonly string[]): Promise<HandleDevOutcome> => {
  let parsed: ParsedArgs<typeof DEV_ARGS>;
  try {
    parsed = parseArgs<typeof DEV_ARGS>(argv as string[], DEV_ARGS);
  } catch (error) {
    setJsonMode(argv.includes("--json"));
    emitError("dev", "InvalidConfig", (error as Error).message);
    return { code: 1 };
  }
  return handleDev(parsed);
};

const tryListen = (server: Server, port: number): Promise<void> =>
  new Promise((res, rej) => {
    const onError = (err: Error): void => {
      server.off("listening", onListening);
      rej(err);
    };
    const onListening = (): void => {
      server.off("error", onError);
      res();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port);
  });

/**
 * Bind `server` on the requested port, auto-incrementing on `EADDRINUSE`
 * up to {@link PORT_FALLBACK_ATTEMPTS} times — the same idiom Vite,
 * Next.js, and Astro use. Returns the actually-bound port. When the
 * caller asked for port 0 (OS-picked), there's nothing to fall back
 * over, so we just do the single bind.
 *
 * Emits a one-line stderr notice when fallback kicked in so the user
 * can see they're not on the port they asked for. Stays silent on the
 * happy path (first port worked).
 *
 * @throws `BaerlyError("InvalidConfig", ...)` when the whole window is
 * busy. Message names the tried ports and tells the user how to find
 * the offending process — the experience the old `Unknown:
 * EADDRINUSE` wrapper failed to give.
 */
const listenWithFallback = async (
  server: Server,
  requestedPort: number,
  emitNotice: boolean,
): Promise<number> => {
  // port=0 means "OS picks" — fallback is meaningless. One attempt, the
  // OS gives us whatever it gives us (or a real bind error).
  if (requestedPort === 0) {
    await tryListen(server, 0);
    const addr = server.address();
    return typeof addr === "object" && addr !== null ? addr.port : 0;
  }
  const tried: number[] = [];
  for (let i = 0; i < PORT_FALLBACK_ATTEMPTS; i++) {
    const candidate = requestedPort + i;
    tried.push(candidate);
    try {
      await tryListen(server, candidate);
      if (i > 0 && emitNotice) {
        process.stderr.write(
          `baerly dev: port ${requestedPort} in use, bound to ${candidate} instead\n`,
        );
      }
      const addr = server.address();
      return typeof addr === "object" && addr !== null ? addr.port : candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE") {
        throw error;
      }
      // try the next slot
    }
  }
  throw new BaerlyError(
    "InvalidConfig",
    `ports ${tried.join(", ")} are all in use. Find the holder with ` +
      `\`lsof -nP -iTCP:${requestedPort} -sTCP:LISTEN\`, kill it, ` +
      `or pass \`--port=<n>\` to pick a different port.`,
  );
};

/**
 * Options for {@link installShutdownHandlers}. Production callers leave
 * all fields default — they're seams so tests can inject a fake event
 * emitter, freeze `ppid`, and spy on exit calls without poking real
 * process state.
 */
export interface ShutdownHandlersOptions {
  readonly proc?: NodeJS.EventEmitter;
  readonly getPpid?: () => number;
  readonly originalPpid?: number;
  readonly ppidPollMs?: number;
  readonly exit?: (code: number) => void;
}

/**
 * Wire SIGHUP/SIGINT/SIGTERM and a PPID watcher to a clean
 * `server.close()` → `exit(0)`. The PPID watcher closes the gap that
 * SIGHUP can't: when a parent shell dies abruptly (kill -9, crash,
 * SSH-session torn down without a hangup), no SIGHUP is delivered and
 * the child gets reparented to PID 1, silently holding the port
 * forever. Polling `process.ppid` and exiting when it changes catches
 * that case.
 *
 * Returns an `uninstall()` function so tests (and `server.close()`
 * callers) can detach the handlers deterministically.
 */
export const installShutdownHandlers = (
  server: Pick<Server, "close">,
  opts: ShutdownHandlersOptions = {},
): (() => void) => {
  const proc = opts.proc ?? process;
  const getPpid = opts.getPpid ?? ((): number => process.ppid);
  const originalPpid = opts.originalPpid ?? process.ppid;
  const pollMs = opts.ppidPollMs ?? PPID_POLL_MS;
  const exit = opts.exit ?? ((c: number): void => process.exit(c));

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    server.close(() => exit(0));
  };

  const onHup = (): void => shutdown();
  const onInt = (): void => shutdown();
  const onTerm = (): void => shutdown();
  proc.on("SIGHUP", onHup);
  proc.on("SIGINT", onInt);
  proc.on("SIGTERM", onTerm);

  const watcher = setInterval(() => {
    if (getPpid() !== originalPpid) {
      shutdown();
    }
  }, pollMs);
  // The server's open socket already keeps the loop alive — the
  // watcher must not pin the process on its own.
  if (typeof (watcher as { unref?: () => void }).unref === "function") {
    (watcher as { unref: () => void }).unref();
  }

  return (): void => {
    proc.off("SIGHUP", onHup);
    proc.off("SIGINT", onInt);
    proc.off("SIGTERM", onTerm);
    clearInterval(watcher);
  };
};
