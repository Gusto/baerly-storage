/**
 * `baerly deploy` — citty dispatcher.
 *
 * Reads `baerly.config.ts:target` and routes to the matching
 * deploy backend. Today: `cloudflare`. The `node` branch is
 * stubbed via dynamic import so ticket 40 can drop the module in
 * without touching the dispatcher.
 *
 * Exit-code contract (mirrors `baerly copy`):
 *   - 0 success.
 *   - 1 user error (InvalidConfig, missing config, unknown target).
 *   - 2 storage / external error (NetworkError, Wrangler returned
 *     non-zero, anything non-BaerlyError).
 *   - 3 protocol invariant (Conflict, Internal, InvalidResponse —
 *     should not happen here unless someone hand-edited mid-flight).
 */

import { defineCommand, type ArgsDef, type ParsedArgs } from "citty";
import { BaerlyError } from "@baerly/protocol";
import { loadAppConfig, type AppConfig } from "./config";
import { deployCloudflare } from "./deploy/cloudflare";
import { emitError, emitSuccess, setJsonMode } from "./output";

const DEPLOY_ARGS = {
  target: {
    type: "string",
    description: 'Override `baerly.config.ts:target`. "cloudflare" or "node".',
    valueHint: "cloudflare|node",
  },
  json: {
    type: "boolean",
    description: "Emit a structured JSON envelope to stdout (success) or stderr (error)",
  },
} as const satisfies ArgsDef;

const KNOWN_KEYS: ReadonlySet<string> = new Set(["target", "json", "_"]);

const errorToExitCode = (code: string): number => {
  if (code === "InvalidConfig") return 1;
  if (code === "Conflict" || code === "Internal" || code === "InvalidResponse") return 3;
  return 2;
};

const handleDeploy = async (args: ParsedArgs<typeof DEPLOY_ARGS>): Promise<number> => {
  setJsonMode(args.json === true);
  try {
    for (const k of Object.keys(args)) {
      if (!KNOWN_KEYS.has(k)) {
        throw new BaerlyError("InvalidConfig", `baerly deploy: unknown flag --${k}`);
      }
    }
    const config = await loadAppConfig();
    const target = args.target ?? config.target;
    if (target === "cloudflare") {
      const exit = await deployCloudflare(config);
      if (exit === 0) emitSuccess({ command: "deploy", status: "ok", target });
      return exit;
    }
    if (target === "node") {
      // Ticket 40 lands the body. The dispatcher's shape is locked
      // here so ticket 40 only needs to add the file. The dynamic
      // import path is constructed at runtime so the typechecker
      // doesn't require the module to exist today.
      const nodeModuleSpecifier = "./deploy/node";
      const mod = (await import(nodeModuleSpecifier)) as {
        deployNode: (config: AppConfig) => Promise<number>;
      };
      const exit = await mod.deployNode(config);
      if (exit === 0) emitSuccess({ command: "deploy", status: "ok", target });
      return exit;
    }
    throw new BaerlyError(
      "InvalidConfig",
      `baerly deploy: unknown target ${JSON.stringify(target)}`,
    );
  } catch (err) {
    if (err instanceof BaerlyError) {
      emitError("deploy", err.code, err.message);
      return errorToExitCode(err.code);
    }
    emitError("deploy", "Unknown", (err as Error).message);
    return 2;
  }
};

/** citty `defineCommand` block for `baerly deploy`. */
export const deploy = defineCommand({
  meta: {
    name: "deploy",
    description: "Deploy this baerly app. Dispatches by baerly.config.ts:target.",
  },
  args: DEPLOY_ARGS,
  run: async ({ args }) => {
    const code = await handleDeploy(args);
    if (code !== 0) process.exit(code);
  },
});

/**
 * Programmatic entry used by tests. Bypasses citty's `run` wrapper
 * (which would call `process.exit` and kill vitest) and returns the
 * integer exit code directly.
 */
export const runDeploy = async (argv: readonly string[]): Promise<number> => {
  const { parseArgs } = await import("citty");
  let parsed: ParsedArgs<typeof DEPLOY_ARGS>;
  try {
    parsed = parseArgs<typeof DEPLOY_ARGS>(argv as string[], DEPLOY_ARGS);
  } catch (err) {
    setJsonMode(argv.includes("--json"));
    emitError("deploy", "InvalidConfig", (err as Error).message);
    return 1;
  }
  return handleDeploy(parsed);
};
