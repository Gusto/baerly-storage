/**
 * `create-baerly` command logic — citty `defineCommand` plus the
 * programmatic `runCreateBaerly` entry consumed by tests. The bin
 * shim at `./index.ts` imports `main` from here and invokes citty's
 * `runMain`. Tests import `runCreateBaerly` so they can drive the
 * CLI in-process without `runMain` calling `process.exit` inside
 * vitest.
 *
 * That `npm create` invocation is the **post-publish** form; until
 * the package ships to npm, stage locally from a clone via
 * `pnpm pack` + `pnpm dlx file:.../create-baerly-0.1.0.tgz` — see
 * the repo `README.md` Quick Start.
 *
 * Citty arg shape matches `@baerly/cli`'s `defineCommand` pattern
 * (see `packages/cli/src/init.ts`).
 *
 * Two flows live here:
 *   - **Interactive wizard** — enters `runWizard` from `./prompts.ts`
 *     when stdin is a TTY *and* `--json` is not set *and* either
 *     `projectName` or `target` was omitted.
 *   - **Flag-driven** — unchanged: CI, agents, piped stdin, and any
 *     TTY invocation with `--json` keep the existing behavior and
 *     the existing JSON envelope shape (part of the agent contract).
 */
import { defineCommand, parseArgs, type ArgsDef, type ParsedArgs } from "citty";
import { outro } from "@clack/prompts";
import pc from "picocolors";
import { runWizard } from "./prompts.ts";
import { type Addon, KNOWN_ADDONS, scaffold } from "./scaffold.ts";
import { defaultInstaller, type Installer } from "./install.ts";
import { detectPm } from "./pm-detect.ts";

export const CREATE_BAERLY_ARGS = {
  projectName: {
    type: "positional",
    description: "Output directory name; lowercase alphanumeric + - / _",
    // Optional at the citty layer so a bare `create-baerly` on a
    // TTY can fall into the wizard. The flag-driven branch below
    // re-validates when wizard mode is suppressed (non-TTY / --json).
    required: false,
    valueHint: "name",
  },
  target: {
    type: "enum",
    options: ["cloudflare", "node"],
    description: 'Deploy target — "cloudflare" or "node".',
    // Optional at the citty layer so a bare `create-baerly` on a
    // TTY can fall into the wizard. The flag-driven branch below
    // re-validates when wizard mode is suppressed (non-TTY / --json).
    required: false,
  },
  starter: {
    type: "enum",
    options: ["minimal", "helpdesk"],
    description: 'Starter template — "minimal" (default) or "helpdesk".',
  },
  tenant: {
    type: "string",
    description: 'Default tenant pin (default "default").',
    valueHint: "string",
  },
  domain: {
    type: "string",
    description: "Custom domain for the deployed service.",
    valueHint: "host",
  },
  install: {
    type: "boolean",
    description: "Run <pm> install after writing files (default false).",
  },
  with: {
    type: "string",
    description:
      'Comma-separated add-ons to layer on the base template. Today: "docker" (requires --target=node).',
    valueHint: "docker",
  },
  pm: {
    type: "string",
    description: 'Override package manager — "npm", "pnpm", or "yarn".',
    valueHint: "pm",
  },
  json: {
    type: "boolean",
    description: "Emit JSON envelope to stdout (success) or stderr (error).",
  },
} as const satisfies ArgsDef;

export const handleCreateBaerly = async (
  args: ParsedArgs<typeof CREATE_BAERLY_ARGS>,
  opts: { readonly installer?: Installer } = {},
): Promise<number> => {
  try {
    const isInteractive = process.stdin.isTTY === true && args.json !== true;
    const wantWizard =
      isInteractive && (args.projectName === undefined || args.target === undefined);
    // Parse `--with=docker,…` early so both the flag-driven and
    // wizard-driven paths can use the same parsed value. Unknown
    // add-on names reject here with a list of valid choices.
    let withAddonsFromFlag: readonly Addon[] | undefined;
    if (args.with !== undefined) {
      const parts = args.with
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const seen = new Set<Addon>();
      for (const p of parts) {
        if (!(KNOWN_ADDONS as readonly string[]).includes(p)) {
          throw new Error(
            `Unknown add-on ${JSON.stringify(p)}. Available add-ons: ${KNOWN_ADDONS.join(", ")}.`,
          );
        }
        seen.add(p as Addon);
      }
      withAddonsFromFlag = [...seen];
    }
    let projectName: string;
    let target: "cloudflare" | "node";
    let withAddons: readonly Addon[];
    let install: boolean;
    if (wantWizard) {
      const w = await runWizard({
        projectName: args.projectName,
        ...(args.target !== undefined && { target: args.target }),
        ...(withAddonsFromFlag !== undefined && { withAddons: withAddonsFromFlag }),
        ...(args.install !== undefined && { install: args.install }),
      });
      projectName = w.projectName;
      target = w.target;
      withAddons = w.withAddons;
      install = w.install;
    } else {
      if (args.projectName === undefined) {
        throw new Error("projectName is required (positional)");
      }
      if (args.target === undefined) {
        throw new Error(
          `--target is required when not running in wizard mode (got undefined)`,
        );
      }
      projectName = args.projectName;
      target = args.target;
      withAddons = withAddonsFromFlag ?? [];
      // Flag-driven path: no wizard, so default to false unless the user
      // explicitly passed --install. Today's CI/agent callers see no
      // behavior change because they never pass --install.
      install = args.install === true;
    }
    // Cross-field validation: today the only add-on is `docker`,
    // which only applies to `--target=node`. Catch the mismatch
    // here (it's identical whether the value came from the flag
    // or the wizard).
    if (withAddons.includes("docker") && target !== "node") {
      throw new Error(
        `--with=docker only applies to --target=node. The Docker add-on adds a ` +
          `Dockerfile to the Node template. Use --target=node --with=docker, or ` +
          `drop --with=docker to scaffold for --target=${target}.`,
      );
    }
    const result = await scaffold({
      projectName,
      target,
      ...(args.starter !== undefined && { starter: args.starter }),
      ...(args.tenant !== undefined && { tenant: args.tenant }),
      ...(args.domain !== undefined && { domain: args.domain }),
      ...(args.pm !== undefined && { pm: args.pm as "npm" | "pnpm" | "yarn" }),
      ...(withAddons.length > 0 && { withAddons }),
    });
    if (install) {
      const installer = opts.installer ?? defaultInstaller;
      const pm = (args.pm as "npm" | "pnpm" | "yarn" | undefined) ?? detectPm();
      const { code } = await installer.run(pm, result.outDir);
      if (code !== 0) {
        process.stderr.write(
          `${pc.yellow("create-baerly:")} install exited with code ${code}. ` +
            `Run \`${pm} install\` in ${result.outDir} manually.\n`,
        );
      }
    }
    if (args.json === true) {
      process.stdout.write(
        `${JSON.stringify({
          result: {
            command: "create-baerly",
            status: "ok",
            outDir: result.outDir,
            filesWritten: result.filesWritten.length,
            nextSteps: result.nextSteps,
          },
        })}\n`,
      );
    } else if (isInteractive) {
      outro(
        `${pc.green("✓")} ${result.outDir}\n` +
          `\n  Next steps:\n` +
          result.nextSteps.map((s) => `    ${s}`).join("\n"),
      );
    } else {
      // Non-TTY, non-JSON: keep the existing plaintext output
      // bit-for-bit so any scripts parsing it don't break.
      process.stdout.write(`${pc.green("✓")} scaffolded ${result.outDir}\n`);
      process.stdout.write(`\n  Next steps:\n`);
      for (const s of result.nextSteps) {
        process.stdout.write(`    ${s}\n`);
      }
      process.stdout.write("\n");
    }
    return 0;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (args.json === true) {
      process.stderr.write(
        `${JSON.stringify({ error: { code: "InvalidConfig", message: msg, command: "create-baerly" } })}\n`,
      );
    } else {
      process.stderr.write(`${pc.red("create-baerly:")} ${msg}\n`);
    }
    return 1;
  }
};

export const main = defineCommand({
  meta: {
    name: "create-baerly",
    version: "0.0.0",
    description: "Scaffold a new baerly app (Cloudflare Worker or self-hosted Node).",
  },
  args: CREATE_BAERLY_ARGS,
  run: async ({ args }) => {
    const code = await handleCreateBaerly(args);
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
export const runCreateBaerly = async (
  argv: readonly string[],
  opts: { readonly installer?: Installer } = {},
): Promise<number> => {
  let parsed: ParsedArgs<typeof CREATE_BAERLY_ARGS>;
  try {
    parsed = parseArgs<typeof CREATE_BAERLY_ARGS>(argv as string[], CREATE_BAERLY_ARGS);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (argv.includes("--json")) {
      process.stderr.write(
        `${JSON.stringify({ error: { code: "InvalidConfig", message: msg, command: "create-baerly" } })}\n`,
      );
    } else {
      process.stderr.write(`${pc.red("create-baerly:")} ${msg}\n`);
    }
    return 1;
  }
  return handleCreateBaerly(parsed, opts);
};
