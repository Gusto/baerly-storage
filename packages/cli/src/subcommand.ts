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

import { type Readable, type Writable } from "node:stream";
import { defineCommand, parseArgs, type ArgsDef, type ParsedArgs, type CommandDef } from "citty";
import { BaerlyError } from "@baerly/protocol";
import { assertPathSegment } from "@baerly/server/_internal/testing";
import { loadAppConfig } from "./config.ts";
import { emitError, setJsonMode } from "./output.ts";

/**
 * Optional stdin / stdout streams that a programmatic caller (today:
 * `runDump` / `runRestore` tests, and the export round-trip
 * integration test) can divert in place of `process.stdin` /
 * `process.stdout`. The citty entry point always uses the process
 * streams; only {@link SubcommandBundle.run} accepts these overrides.
 */
export interface SubcommandStreams {
  readonly stdin?: Readable;
  readonly stdout?: Writable;
}

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
  /**
   * Programmatic stdin / stdout overrides. `undefined` (or any
   * missing field) means "use the process stream". Only
   * `admin dump` / `admin restore` consume this; other commands
   * ignore the field.
   */
  readonly streams?: SubcommandStreams;
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
  readonly run: (
    argv: readonly string[],
    options?: { readonly streams?: SubcommandStreams },
  ) => Promise<number>;
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
 * Validate a `--collection` arg through the same shared rule the
 * server uses for every caller-controlled key segment, before it is
 * interpolated into a bucket key. Throws `BaerlyError("InvalidConfig",
 * …)` on a traversal / empty / control-char / reserved value. `verb`
 * is the operator-facing command name (e.g. `"baerly admin restore"`,
 * `"baerly inspect"`) so the message names the exact command.
 *
 * (app/tenant are validated at their own chokepoint inside
 * `resolveAppTenant`; this guards the per-command `collection` arg.)
 */
export const assertCollectionArg = (collection: string, verb: string): void => {
  assertPathSegment(collection, "collection", verb);
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
    let app: string;
    let tenant: string;
    if (flagApp !== undefined && flagTenant !== undefined) {
      app = flagApp;
      tenant = flagTenant;
    } else {
      let cfg: { app: string; tenant: string };
      try {
        cfg = await loadAppConfig();
      } catch (error) {
        // Re-throw with our own wording so the operator sees the
        // calling-command name and the hint to pass --app / --tenant
        // explicitly. The underlying loadAppConfig error is preserved
        // as the cause. (Only wraps a config-LOAD failure — the
        // segment validation below is intentionally outside this catch
        // so its own InvalidConfig message survives.)
        const inner = error instanceof BaerlyError ? error.message : (error as Error).message;
        throw new BaerlyError(
          "InvalidConfig",
          `baerly ${name}: --app / --tenant not supplied and no baerly.config.{ts,js,mjs,json} in cwd (${inner})`,
          error,
        );
      }
      app = flagApp ?? cfg.app;
      tenant = flagTenant ?? cfg.tenant;
    }
    // Single chokepoint covering every command that calls
    // resolveAppTenant: whatever the source (flags or config), the
    // resolved segments must pass the same shared rule before they
    // become bucket-key segments. A bad-but-supplied value throws
    // InvalidConfig, consistent with the "not supplied" case above.
    assertPathSegment(app, "app", `baerly ${name}`);
    assertPathSegment(tenant, "tenant", `baerly ${name}`);
    return { app, tenant };
  };
};

/**
 * Wrap `def.handler` with the standard JSON-mode toggle, unknown-key
 * rejection, and error-to-exit-code mapping. Shared by both the citty
 * `run({ args })` path and the test `run(argv)` path. The caller
 * supplies the {@link SubcommandContext}; this lets each `run(argv)`
 * invocation attach its own `streams` override without leaking across
 * invocations.
 */
const kebabToCamel = (s: string): string => s.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());

const wrapHandler = <TArgs extends ArgsDef>(
  def: SubcommandDef<TArgs>,
): ((args: ParsedArgs<TArgs>, ctx: SubcommandContext) => Promise<number>) => {
  // Compute the allow-list once from the ArgsDef. citty injects `_`
  // for positional captures, so it must stay allowed. citty 0.2.2
  // also auto-injects a camelCase alias for every kebab-case flag
  // (e.g. `--where-comment` produces both `whereComment` and
  // `where-comment` on the parsed args), so each kebab key is
  // expanded to its camelCase variant in the allow-list too.
  const allowedKeys: ReadonlySet<string> = new Set(
    Object.keys(def.args)
      .flatMap((k) => (k.includes("-") ? [k, kebabToCamel(k)] : [k]))
      .concat(["_"]),
  );
  return async (args, ctx) => {
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
  const resolveAppTenant = makeResolveAppTenant(def.name);
  const wrapped = wrapHandler(def);

  const cmd = defineCommand({
    meta: { name: def.name, description: def.meta.description },
    args: def.args,
    run: async ({ args }) => {
      const code = await wrapped(args as ParsedArgs<TArgs>, { resolveAppTenant });
      if (code !== 0) {
        process.exit(code);
      }
    },
  });

  const run = async (
    argv: readonly string[],
    options?: { readonly streams?: SubcommandStreams },
  ): Promise<number> => {
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
    return wrapped(parsed, { resolveAppTenant, streams: options?.streams });
  };

  return { cmd, run };
};
