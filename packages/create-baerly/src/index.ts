/**
 * `create-baerly` bin entry. Imports the citty command from `./runner.ts`
 * and dispatches via an inline `runBin` shim. Kept as a thin shim so
 * the runner module has no import-time side effects — tests can
 * import `runCreateBaerly` from `./runner.ts` directly without citty
 * running and calling `process.exit` inside vitest.
 *
 * The shim mirrors the shape of `@baerly/cli`'s `bin-runner.ts`
 * (same `--help` / `--version` interception, same `CLIError →
 * InvalidConfig` translation). Inlined here rather than imported
 * cross-package because `create-baerly` is a separate publishable
 * with its own dependency surface — the cross-package import
 * overhead beats the dedup at this scale.
 */
import { runCommand, showUsage, type CommandMeta, type Resolvable } from "citty";
import pc from "picocolors";
import { main } from "./runner.ts";

const resolve = async <T>(v: Resolvable<T>): Promise<T> => {
  if (typeof v === "function") {
    return (v as () => T | Promise<T>)();
  }
  return v;
};

const writeError = (json: boolean, code: string, message: string): void => {
  if (json) {
    process.stderr.write(
      `${JSON.stringify({ error: { code, message, command: "create-baerly" } })}\n`,
    );
  } else {
    process.stderr.write(`${pc.red("create-baerly:")} ${code}: ${message}\n`);
  }
};

const argv = process.argv.slice(2);
const wantJson = argv.includes("--json");

const run = async (): Promise<void> => {
  if (argv.includes("--help") || argv.includes("-h")) {
    // create-baerly has no subCommands, so the top-level command is
    // always the showUsage target.
    await showUsage(main);
    process.exit(0);
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    const meta = (await resolve(main.meta as Resolvable<CommandMeta>)) ?? {};
    const version = meta.version;
    if (typeof version !== "string" || version.length === 0) {
      writeError(wantJson, "InvalidConfig", "no version declared on this command");
      process.exit(1);
    }
    process.stdout.write(`${version}\n`);
    process.exit(0);
  }
  try {
    await runCommand(main, { rawArgs: [...argv] });
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeError(wantJson, "InvalidConfig", message);
    process.exit(1);
  }
};

void run();
