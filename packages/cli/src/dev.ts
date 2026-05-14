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
 * parity testing, `baerly dev --wrangler` shells out to
 * `wrangler dev` from `apps/server/` (requires `config.target ===
 * "cloudflare"`).
 *
 * Args:
 *   --port=<n>         Listen port. Default 3000.
 *   --data-dir=<path>  `LocalFsStorage` root. Default `./.baerly-data`.
 *   --wrangler         CF target only: spawn `wrangler dev` from `apps/server/`.
 *   --json             Emit a JSON envelope to stdout on boot.
 *
 * Exit codes (per `packages/cli/README.md`):
 *   0 — listener bound (the process stays alive serving requests).
 *   1 — InvalidConfig (bad `--port`, `--wrangler` against a Node
 *       target, missing/invalid `baerly.config.ts`).
 *   2 — storage / network / unknown.
 *   3 — protocol invariant.
 *
 * The verifier always uses `sharedSecret` in dev. The secret reads
 * from `BAERLY_DEV_SECRET` and falls back to a literal `"dev-only-
 * secret"` so a fresh `pnpm dev` works without any env wiring.
 */

import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { defineCommand, parseArgs, type ArgsDef, type ParsedArgs } from "citty";
import pc from "picocolors";
import { LocalFsStorage, createListener } from "@baerly/adapter-node";
import { ensureTable } from "@baerly/dev";
import { BaerlyError } from "@baerly/protocol";
import { sharedSecret } from "@baerly/server";
import { loadAppConfigWithCollections } from "./config.ts";
import { emitError, emitSuccess, isJsonMode, setJsonMode } from "./output.ts";

const DEFAULT_PORT = 3000;
const DEFAULT_DATA_DIR = "./.baerly-data";
const DEV_SECRET_FALLBACK = "dev-only-secret";

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
  wrangler: {
    type: "boolean",
    description: "Cloudflare target only: spawn `wrangler dev` from apps/server/.",
  },
  json: { type: "boolean", description: "Emit JSON envelope to stdout." },
} as const satisfies ArgsDef;

const KNOWN_KEYS: ReadonlySet<string> = new Set(["port", "data-dir", "wrangler", "json", "_"]);

const errorToExitCode = (code: string): number => {
  if (code === "InvalidConfig") return 1;
  if (code === "Conflict" || code === "Internal" || code === "InvalidResponse") return 3;
  return 2;
};

/**
 * Outcome of a successful `runDev` invocation. For the default path
 * carries the bound port (`server.address()` is observed AFTER the
 * `listening` event fires, so `port: 0` callers get the OS-picked
 * port back). For `--wrangler`, `mode === "wrangler"` and `port` is
 * `null`.
 */
export interface DevResult {
  readonly mode: "node" | "wrangler";
  readonly port: number | null;
  readonly dataDir: string | null;
  readonly target: "cloudflare" | "node";
  readonly tenant: string | null;
  readonly app: string | null;
  /** Set in the default path so test harnesses can shut the server down deterministically. */
  readonly server?: Server;
  /** Set in `--wrangler` mode so the caller can await wrangler's exit. */
  readonly wranglerExit?: Promise<number>;
}

/**
 * Programmatic entry point. Returns a {@link DevResult} after the
 * listener is bound (or, for `--wrangler`, after the wrangler child
 * is spawned). Does NOT block on the server staying up — the caller
 * keeps the event loop busy via the returned `server` (default path)
 * or `wranglerExit` (wrangler path).
 *
 * @throws BaerlyError code="InvalidConfig" — `--wrangler` requested
 *   against a Node-target config, or `loadAppConfig` rejected.
 */
export const runDev = async (opts: {
  readonly cwd?: string;
  readonly port: number;
  readonly dataDir: string;
  readonly wrangler: boolean;
  readonly json: boolean;
}): Promise<DevResult> => {
  const cwd = opts.cwd ?? process.cwd();
  const { config, collections } = await loadAppConfigWithCollections(cwd);

  if (opts.wrangler) {
    if (config.target !== "cloudflare") {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly dev: --wrangler requires baerly.config.ts:target === "cloudflare" (got ${JSON.stringify(config.target)})`,
      );
    }
    return runWranglerDev({ cwd, target: config.target });
  }

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

  const listener = createListener({ app: config.app, storage, verifier });
  const server = createServer(listener);
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(opts.port, () => {
      server.off("error", rej);
      res();
    });
  });
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr !== null ? addr.port : opts.port;

  printBanner({
    port: boundPort,
    dataDir,
    tenant,
    app: config.app,
    target: config.target,
    json: opts.json,
    secretSource: process.env["BAERLY_DEV_SECRET"] !== undefined ? "env" : "fallback",
  });

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
 * Spawn `wrangler dev` from `apps/server/`. Inherits stdio so the
 * wrangler TTY (file-watcher logs, dashboard URLs) passes through.
 * Returns a resolved promise as soon as the child is spawned; the
 * caller awaits `wranglerExit` to wait on `close`.
 */
const runWranglerDev = async (args: {
  readonly cwd: string;
  readonly target: "cloudflare" | "node";
}): Promise<DevResult> => {
  const appsServer = resolve(args.cwd, "apps/server");
  const child = spawn("wrangler", ["dev"], { cwd: appsServer, stdio: "inherit" });
  const wranglerExit = new Promise<number>((res) => {
    child.on("close", (code) => {
      res(code ?? 0);
    });
  });
  return await Promise.resolve({
    mode: "wrangler" as const,
    port: null,
    dataDir: null,
    target: args.target,
    tenant: null,
    app: null,
    wranglerExit,
  });
};

/**
 * Print the startup banner. Text mode emits a colored block; JSON
 * mode stays silent here — the JSON envelope is emitted from the
 * command body once `runDev` returns. Goes to stderr so stdout in
 * `--json` mode stays a single envelope line.
 */
const printBanner = (b: {
  readonly port: number;
  readonly dataDir: string;
  readonly tenant: string;
  readonly app: string;
  readonly target: "cloudflare" | "node";
  readonly json: boolean;
  readonly secretSource: "env" | "fallback";
}): void => {
  if (b.json) return;
  const lines = [
    pc.bold(pc.cyan("baerly dev")),
    `  url:       http://localhost:${b.port}`,
    `  data-dir:  ${b.dataDir}`,
    `  app:       ${b.app}`,
    `  tenant:    ${b.tenant}`,
    `  target:    ${b.target}`,
    `  verifier:  sharedSecret (${b.secretSource === "env" ? "BAERLY_DEV_SECRET" : "fallback dev-only-secret"})`,
    "",
  ];
  process.stderr.write(`${lines.join("\n")}\n`);
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
      wrangler: args.wrangler === true,
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
  } catch (err) {
    if (err instanceof BaerlyError) {
      emitError("dev", err.code, err.message);
      return { code: errorToExitCode(err.code) };
    }
    emitError("dev", "Unknown", (err as Error).message);
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
    if (code !== 0) process.exit(code);
    // Default path: the server's open socket keeps the event loop
    // alive — do not call process.exit(0). Wrangler path: the spawned
    // child inherits stdio and keeps the process alive until it exits.
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
  } catch (err) {
    setJsonMode(argv.includes("--json"));
    emitError("dev", "InvalidConfig", (err as Error).message);
    return { code: 1 };
  }
  return handleDev(parsed);
};
