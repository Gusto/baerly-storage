/**
 * `baerly init` — drop a `baerly.config.ts` into the current
 * directory of an existing repository. Unlike `npm create baerly`,
 * this does NOT scaffold Wrangler / Dockerfile / package.json — it
 * exists to onboard a project that already has those.
 *
 * Args:
 *   --app=<name>       Required. The bucket-prefix segment.
 *   --tenant=<name>    Default "default".
 *   --target=<cloudflare|node> Default "cloudflare".
 *   --force            Overwrite an existing baerly.config.ts.
 *   --json             Emit JSON envelope on stdout/stderr.
 *
 * Exit codes:
 *   0 — file written.
 *   1 — InvalidConfig (missing --app, bad target value, refused
 *       to overwrite without --force).
 *   2 — I/O error writing the file.
 */

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineCommand, parseArgs, type ArgsDef, type ParsedArgs } from "citty";
import { BaerlyError } from "@baerly/protocol";
import { emitError, emitSuccess, setJsonMode } from "./output.ts";

const INIT_ARGS = {
  app: {
    type: "string",
    required: true,
    description: "Bucket-prefix segment.",
    valueHint: "name",
  },
  tenant: {
    type: "string",
    default: "default",
    description: "Default tenant pin.",
    valueHint: "name",
  },
  target: {
    type: "string",
    default: "cloudflare",
    description: "Deploy target.",
    valueHint: "cloudflare|node",
  },
  force: { type: "boolean", description: "Overwrite existing baerly.config.ts." },
  json: { type: "boolean", description: "Emit JSON envelope output." },
} as const satisfies ArgsDef;

const KNOWN_KEYS: ReadonlySet<string> = new Set(["app", "tenant", "target", "force", "json", "_"]);

const errorToExitCode = (code: string): number => {
  if (code === "InvalidConfig") {
    return 1;
  }
  return 2;
};

const template = (app: string, tenant: string, target: "cloudflare" | "node"): string =>
  `import { defineConfig } from "create-baerly/config";

export default defineConfig({
  app: ${JSON.stringify(app)},
  tenant: ${JSON.stringify(tenant)},
  target: ${JSON.stringify(target)},
});
`;

const handleInit = async (args: ParsedArgs<typeof INIT_ARGS>): Promise<number> => {
  setJsonMode(args.json === true);
  try {
    for (const k of Object.keys(args)) {
      if (!KNOWN_KEYS.has(k)) {
        throw new BaerlyError("InvalidConfig", `baerly init: unknown flag --${k}`);
      }
    }
    if (typeof args.app !== "string" || args.app.length === 0) {
      throw new BaerlyError("InvalidConfig", "baerly init: --app=<name> is required");
    }
    if (args.target !== "cloudflare" && args.target !== "node") {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly init: --target must be "cloudflare" or "node" (got ${JSON.stringify(args.target)})`,
      );
    }
    const outPath = resolve(process.cwd(), "baerly.config.ts");
    if (existsSync(outPath) && args.force !== true) {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly init: ${outPath} already exists; pass --force to overwrite`,
      );
    }
    try {
      await writeFile(outPath, template(args.app, args.tenant, args.target), "utf8");
    } catch (error) {
      emitError("init", "Unknown", (error as Error).message);
      return 2;
    }
    emitSuccess({
      command: "init",
      status: "ok",
      path: outPath,
      app: args.app,
      tenant: args.tenant,
      target: args.target,
    });
    return 0;
  } catch (error) {
    if (error instanceof BaerlyError) {
      emitError("init", error.code, error.message);
      return errorToExitCode(error.code);
    }
    emitError("init", "Unknown", (error as Error).message);
    return 2;
  }
};

/** citty `defineCommand` block for `baerly init`. */
export const init = defineCommand({
  meta: { name: "init", description: "Drop a baerly.config.ts into this repo." },
  args: INIT_ARGS,
  run: async ({ args }) => {
    const code = await handleInit(args);
    if (code !== 0) {
      process.exit(code);
    }
  },
});

/**
 * Programmatic entry used by tests. Bypasses citty's `run` wrapper
 * (which would call `process.exit` and kill vitest) and returns the
 * integer exit code directly.
 */
export const runInit = async (argv: readonly string[]): Promise<number> => {
  let parsed: ParsedArgs<typeof INIT_ARGS>;
  try {
    parsed = parseArgs<typeof INIT_ARGS>(argv as string[], INIT_ARGS);
  } catch (error) {
    setJsonMode(argv.includes("--json"));
    emitError("init", "InvalidConfig", (error as Error).message);
    return 1;
  }
  return handleInit(parsed);
};
