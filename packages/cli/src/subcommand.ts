/**
 * Shared subcommand scaffolding for `baerly`.
 *
 * Every operator-facing subcommand (`inspect`, `export`, `doctor`, and
 * every `admin/*` command) was independently re-implementing the same
 * five pieces of boilerplate:
 *
 *   1. `setJsonMode(args.json === true)` before any emission.
 *   2. A `KNOWN_KEYS` whitelist asserting unknown `--flag` rejection.
 *   3. An `errorToExitCode(code)` mapping —
 *      `InvalidConfig → 1`, `Conflict|Internal|InvalidResponse → 3`,
 *      else `2`.
 *   4. `resolveAppTenant(args)` falling back through `baerly.config.*`
 *      to either real values or hard-coded `"app"` / `"tenant"`
 *      literals.
 *   5. Two parallel entry points: a citty `defineCommand` block that
 *      calls `process.exit(code)` on failure, and a `runXxx(argv)`
 *      function for in-process tests that returns the exit code.
 *
 * The five copies drifted: some commands suppressed protocol-level
 * errors (no `Conflict|Internal|InvalidResponse → 3` arm), and the
 * config-fallback silently produced `"app"` / `"tenant"` literals
 * (confidently-wrong output when no config is present).
 *
 * {@link defineBaerlySubcommand} centralizes the five pieces:
 *   - Computes the known-keys set from `Object.keys(args)` itself, so
 *     a new flag is picked up automatically.
 *   - Applies the full 3-bucket exit-code mapping uniformly.
 *   - {@link SubcommandContext.resolveAppTenant} throws
 *     `BaerlyError("InvalidConfig", …)` with a `--app` / `--tenant`
 *     hint when neither flags nor a loadable `baerly.config.*` supply
 *     the values.
 *   - Returns a bundle of {@link SubcommandBundle.cmd} (citty wiring)
 *     and {@link SubcommandBundle.run} (test entry) sharing one
 *     wrapped handler.
 */

import {
  defineCommand,
  parseArgs,
  type ArgsDef,
  type ParsedArgs,
  type CommandDef,
} from "citty";
import { BaerlyError } from "@baerly/protocol";
import { loadAppConfig } from "./config.ts";
import { emitError, setJsonMode } from "./output.ts";

/**
 * Capabilities the subcommand handler receives. Today: app/tenant
 * resolution. Kept narrow so the handler signature stays load-bearing
 * (the helper isn't a god object).
 */
export interface SubcommandContext {
  /**
   * Returns `{ app, tenant }` resolved from explicit flags or
   * `baerly.config.{ts,js,mjs,json}` in the cwd.
   *
   * @throws BaerlyError code="InvalidConfig" — neither flag was
   *   supplied AND no loadable config was found. The error message
   *   includes a hint mentioning `--app` / `--tenant`.
   */
  readonly resolveAppTenant: (args: {
    readonly app?: string;
    readonly tenant?: string;
  }) => Promise<{ app: string; tenant: string }>;
}

/**
 * Definition fed to {@link defineBaerlySubcommand}. `name` is the JSON
 * envelope tag (`"inspect"`, `"admin.compact"`, etc.); `args` is the
 * citty ArgsDef; `handler` returns the integer exit code.
 */
export interface SubcommandDef<TArgs extends ArgsDef> {
  /** JSON envelope `command` tag and the prefix of every emitted error. */
  readonly name: string;
  readonly meta: { readonly description: string };
  readonly args: TArgs;
  readonly handler: (args: ParsedArgs<TArgs>, ctx: SubcommandContext) => Promise<number>;
}

/**
 * Output of {@link defineBaerlySubcommand}. `cmd` plugs into
 * `subCommands` in `baerly.ts`; `run` is the in-process entry for
 * unit tests.
 */
export interface SubcommandBundle<TArgs extends ArgsDef> {
  readonly cmd: CommandDef<TArgs>;
  readonly run: (argv: readonly string[]) => Promise<number>;
}

/** Shared exit-code mapping for caught `BaerlyError`s. */
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
 * Build the app/tenant resolver. Captures `name` to surface the
 * calling subcommand in the InvalidConfig hint.
 */
const makeResolveAppTenant = (name: string): SubcommandContext["resolveAppTenant"] => {
  return async (args) => {
    const flagApp = typeof args.app === "string" && args.app.length > 0 ? args.app : undefined;
    const flagTenant =
      typeof args.tenant === "string" && args.tenant.length > 0 ? args.tenant : undefined;
    if (flagApp !== undefined && flagTenant !== undefined) {
      return { app: flagApp, tenant: flagTenant };
    }
    try {
      const cfg = await loadAppConfig();
      return {
        app: flagApp ?? cfg.app,
        tenant: flagTenant ?? cfg.tenant,
      };
    } catch (error) {
      // Re-throw with our own wording so the operator sees the
      // calling-command name and the hint to pass --app / --tenant
      // explicitly. The underlying loadAppConfig error is preserved
      // as the cause.
      const inner = error instanceof BaerlyError ? error.message : (error as Error).message;
      throw new BaerlyError(
        "InvalidConfig",
        `baerly ${name}: --app / --tenant not supplied and no baerly.config.{ts,js,mjs,json} in cwd (${inner})`,
        error,
      );
    }
  };
};

/**
 * Wrap `def.handler` with the standard JSON-mode toggle, unknown-key
 * rejection, and error-to-exit-code mapping. Shared by both the citty
 * `run({ args })` path and the test `run(argv)` path.
 */
const wrapHandler = <TArgs extends ArgsDef>(
  def: SubcommandDef<TArgs>,
  ctx: SubcommandContext,
): ((args: ParsedArgs<TArgs>) => Promise<number>) => {
  // Compute the allow-list once from the ArgsDef. citty injects `_`
  // for positional captures, so it must stay allowed.
  const allowedKeys: ReadonlySet<string> = new Set([...Object.keys(def.args), "_"]);
  return async (args) => {
    // `json` is conventional but not required — only toggle when it's
    // both declared in the ArgsDef and truthy on the parsed args.
    if ("json" in def.args) {
      setJsonMode((args as ParsedArgs<TArgs> & { json?: boolean }).json === true);
    }
    try {
      for (const k of Object.keys(args)) {
        if (!allowedKeys.has(k)) {
          throw new BaerlyError("InvalidConfig", `baerly ${def.name}: unknown flag --${k}`);
        }
      }
      return await def.handler(args, ctx);
    } catch (error) {
      if (error instanceof BaerlyError) {
        emitError(def.name, error.code, error.message);
        return errorToExitCode(error.code);
      }
      emitError(def.name, "Unknown", (error as Error).message);
      return 2;
    }
  };
};

/**
 * Wrap a baerly subcommand. Returns `{ cmd, run }` —
 *   - `cmd` is a citty `defineCommand` block; mount it in
 *     `baerly.ts`'s `subCommands`. It calls `process.exit(code)` on a
 *     non-zero exit so the parent process surfaces the failure.
 *   - `run(argv)` is the in-process test entry. It parses `argv` with
 *     citty's `parseArgs`, dispatches through the same wrapped
 *     handler, and returns the integer exit code (does NOT call
 *     `process.exit`).
 *
 * The two paths share `wrapHandler` so JSON-mode toggling,
 * unknown-flag rejection, and error-to-exit-code mapping behave
 * identically.
 */
export const defineBaerlySubcommand = <TArgs extends ArgsDef>(
  def: SubcommandDef<TArgs>,
): SubcommandBundle<TArgs> => {
  const ctx: SubcommandContext = {
    resolveAppTenant: makeResolveAppTenant(def.name),
  };
  const wrapped = wrapHandler(def, ctx);

  const cmd = defineCommand({
    meta: { name: def.name, description: def.meta.description },
    args: def.args,
    run: async ({ args }) => {
      const code = await wrapped(args as ParsedArgs<TArgs>);
      if (code !== 0) {
        process.exit(code);
      }
    },
  });

  const run = async (argv: readonly string[]): Promise<number> => {
    let parsed: ParsedArgs<TArgs>;
    try {
      parsed = parseArgs<TArgs>(argv as string[], def.args);
    } catch (error) {
      // Parse-time error from citty (missing required flag,
      // malformed value). Toggle JSON mode by sniffing argv since
      // we never reached the handler.
      setJsonMode(argv.includes("--json"));
      emitError(def.name, "InvalidConfig", (error as Error).message);
      return 1;
    }
    return wrapped(parsed);
  };

  return { cmd, run };
};
