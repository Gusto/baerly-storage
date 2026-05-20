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
import { defineCommand, parseArgs, type ArgsDef, type ParsedArgs } from "citty";
import { createListener } from "@baerly/adapter-node";
import { LocalFsStorage, ensureTable, printDevBanner } from "@baerly/dev";
import { BaerlyError } from "@baerly/protocol";
import { sharedSecret } from "@baerly/server/auth";
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
  json: { type: "boolean", description: "Emit JSON envelope to stdout." },
} as const satisfies ArgsDef;

const KNOWN_KEYS: ReadonlySet<string> = new Set(["port", "data-dir", "json", "_"]);

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
