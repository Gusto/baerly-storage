/**
 * `runBin` — bin-entry shim around citty 0.2.2's `runCommand`.
 *
 * Why this exists: citty's own `runMain` does not give us enough
 * control over the failure surface. In particular:
 *
 *   1. citty 0.2.2's `runCommand` does NOT intercept `--help` or
 *      `--version` on a parent command that has `subCommands`. A bare
 *      `baerly --help` invocation tries to *dispatch* (and fails on
 *      "no subcommand").
 *   2. `runMain` translates the internal `CLIError` (the one thrown
 *      for unknown flags, invalid enum values, missing required
 *      flags) into a bare `process.stderr.write` + `process.exit(1)`.
 *      We want every error path to flow through {@link emitError}
 *      so `--json` envelopes work even on parse-time failures, and
 *      the brand-prefix collapse for top-level errors stays
 *      consistent.
 *
 * Behavior:
 *   - Sets `setJsonMode(argv.includes("--json"))` as the first
 *     action so parse-time errors still emit a JSON envelope.
 *   - Walks `cmd.subCommands` to handle `--help` / `-h` and
 *     `--version` / `-v` at any nesting depth.
 *   - Translates citty `CLIError`s into `BaerlyError("InvalidConfig",
 *     …)` semantics.
 *   - Maps `BaerlyError.code` through the same 3-bucket exit-code
 *     table the per-subcommand wrappers use (`InvalidConfig → 1`,
 *     `Conflict|Internal|InvalidResponse → 3`, else 2).
 */

import {
  type CommandDef,
  type SubCommandsDef,
  type CommandMeta,
  type Resolvable,
  runCommand,
  showUsage,
} from "citty";
import { BaerlyError } from "@baerly/protocol";
import { emitError, setJsonMode } from "./output.ts";

const errorToExitCode = (code: string): number => {
  if (code === "InvalidConfig") {
    return 1;
  }
  if (code === "Conflict" || code === "Internal" || code === "InvalidResponse") {
    return 3;
  }
  return 2;
};

const resolve = async <T>(v: Resolvable<T>): Promise<T> => {
  if (typeof v === "function") {
    return (v as () => T | Promise<T>)();
  }
  return v;
};

/**
 * Walk `cmd.subCommands` along the leading positional args to find
 * the deepest matched subcommand. Returns `cmd` itself when no
 * positional matches, so `<bin> --help` (no subcommand) still
 * resolves to the top-level command.
 */
const resolveTarget = async (
  cmd: CommandDef,
  positional: readonly string[],
): Promise<CommandDef> => {
  let cur: CommandDef = cmd;
  for (const arg of positional) {
    const subs = cur.subCommands;
    if (subs === undefined) {
      break;
    }
    const subsResolved = (await resolve(subs)) as SubCommandsDef;
    const next = subsResolved[arg];
    if (next === undefined) {
      break;
    }
    cur = (await resolve(next)) as CommandDef;
  }
  return cur;
};

/** Return the leading positional args (everything before the first `--flag`). */
const leadingPositionals = (argv: readonly string[]): readonly string[] => {
  const out: string[] = [];
  for (const a of argv) {
    if (a.startsWith("-")) {
      break;
    }
    out.push(a);
  }
  return out;
};

/**
 * Bin-entry runner. Returns a promise that never resolves on
 * success (it calls `process.exit(0)`); on error it `process.exit`s
 * with the mapped code.
 *
 * `brand` controls the {@link emitError} prefix on top-level
 * failures — `"baerly"` for the main CLI, `"create-baerly"` for
 * the scaffolder.
 */
export const runBin = async (
  cmd: CommandDef,
  argv: readonly string[],
  brand: "baerly" | "create-baerly" = "baerly",
): Promise<void> => {
  setJsonMode(argv.includes("--json"));

  // Intercept --help / -h before runCommand. citty 0.2.2 does NOT
  // handle these on a parent command with subcommands.
  if (argv.includes("--help") || argv.includes("-h")) {
    const target = await resolveTarget(cmd, leadingPositionals(argv));
    await showUsage(target);
    process.exit(0);
  }

  // Intercept --version / -v.
  if (argv.includes("--version") || argv.includes("-v")) {
    const meta = (await resolve(cmd.meta as Resolvable<CommandMeta>)) ?? {};
    const version = meta.version;
    if (typeof version !== "string" || version.length === 0) {
      emitError(brand, "InvalidConfig", "no version declared on this command");
      process.exit(1);
    }
    process.stdout.write(`${version}\n`);
    process.exit(0);
  }

  try {
    await runCommand(cmd, { rawArgs: [...argv] });
    process.exit(0);
  } catch (error) {
    if (error instanceof BaerlyError) {
      emitError(brand, error.code, error.message);
      process.exit(errorToExitCode(error.code));
    }
    // citty CLIError (unknown flag, invalid enum value, missing
    // required flag) — translate to InvalidConfig.
    const message = error instanceof Error ? error.message : String(error);
    emitError(brand, "InvalidConfig", message);
    process.exit(1);
  }
};
