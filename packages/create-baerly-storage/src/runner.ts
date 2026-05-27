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
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runWizard } from "./prompts.ts";
import { type Addon, KNOWN_ADDONS, scaffold } from "./scaffold.ts";
import { boltOnExistingWrangler } from "./bolt-on.ts";
import { defaultInstaller, type Installer } from "./install.ts";
import { detectPm, probePmVersion } from "./pm-detect.ts";
import { defaultGitRunner, type GitRunner, initRepoAndCommit } from "./git.ts";

export const CREATE_BAERLY_ARGS = {
  projectName: {
    type: "positional",
    description: "Output directory name (or '.' to scaffold into the current directory)",
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
    options: ["minimal", "react"],
    description: 'Starter template — "minimal" (default) or "react".',
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
  force: {
    type: "boolean",
    description:
      "In bolt-on mode, overwrite an existing baerly.config.ts (no-op in scaffold mode).",
  },
  git: {
    type: "boolean",
    description:
      "Initialise a git repo + create the initial commit after scaffold (default true in wizard, false in flag-driven mode). Negate with --no-git.",
  },
  with: {
    type: "string",
    description:
      'Comma-separated add-ons. Scaffold mode: "docker" (requires --target=node). ' +
      "Bolt-on mode (`create baerly .` in an existing wrangler project): " +
      '"agent-rules" drops an AGENTS.md block pointing at the baerly API surface.',
    valueHint: "docker|agent-rules",
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

const resolveOutDir = (projectName: string): string =>
  projectName === "." ? process.cwd() : resolve(process.cwd(), projectName);

interface DispatchBoltOnOpts {
  readonly outDir: string;
  readonly tenant: string;
  readonly force: boolean;
  readonly install: boolean;
  readonly pm: "npm" | "pnpm" | "yarn" | undefined;
  readonly json: boolean;
  readonly isInteractive: boolean;
  readonly installer: Installer | undefined;
  readonly agentRules: boolean;
}

const dispatchBoltOn = async (opts: DispatchBoltOnOpts): Promise<number> => {
  try {
    const result = await boltOnExistingWrangler({
      outDir: opts.outDir,
      tenant: opts.tenant,
      ...(opts.force && { force: true }),
      runInstall: opts.install,
      ...(opts.pm !== undefined && { pm: opts.pm }),
      ...(opts.installer !== undefined && { installer: opts.installer }),
      ...(opts.agentRules && { agentRules: true }),
    });
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({
          result: {
            command: "create-baerly",
            status: "ok",
            mode: "bolt-on",
            outDir: opts.outDir,
            app: result.app,
            tenant: result.tenant,
            changes: result.changes,
            snippet: result.snippet,
            snippetTarget: result.snippetTarget,
            nextSteps: result.nextSteps,
            ...(result.agentRules !== undefined && { agentRules: result.agentRules }),
          },
        })}\n`,
      );
    } else if (opts.isInteractive) {
      const changesBlock =
        result.changes.length === 0
          ? "  (no changes — already bolted on)"
          : result.changes.map((c) => `  ${c}`).join("\n");
      outro(
        `${pc.green("✓")} bolted baerly onto ${opts.outDir}\n\n` +
          `Changes:\n${changesBlock}\n\n` +
          `Paste this into ${result.snippetTarget}, replacing the stock handler:\n\n` +
          result.snippet +
          `\nNext steps:\n` +
          result.nextSteps.map((s) => `  ${s}`).join("\n"),
      );
    } else {
      process.stdout.write(`${pc.green("✓")} bolted baerly onto ${opts.outDir}\n`);
      if (result.changes.length > 0) {
        process.stdout.write(`\n  Changes:\n`);
        for (const c of result.changes) {
          process.stdout.write(`    ${c}\n`);
        }
      }
      process.stdout.write(
        `\n  Paste this into ${result.snippetTarget}, replacing the stock handler:\n\n`,
      );
      process.stdout.write(result.snippet);
      process.stdout.write(`\n  Next steps:\n`);
      for (const s of result.nextSteps) {
        process.stdout.write(`    ${s}\n`);
      }
      process.stdout.write("\n");
    }
    return 0;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (opts.json) {
      process.stderr.write(
        `${JSON.stringify({ error: { code: "InvalidConfig", message: msg, command: "create-baerly" } })}\n`,
      );
    } else {
      process.stderr.write(`${pc.red("create-baerly:")} ${msg}\n`);
    }
    return 1;
  }
};

export const handleCreateBaerly = async (
  args: ParsedArgs<typeof CREATE_BAERLY_ARGS>,
  opts: { readonly installer?: Installer; readonly gitRunner?: GitRunner } = {},
): Promise<number> => {
  const jsonMode = args.json === true;
  try {
    const isInteractive = process.stdin.isTTY === true && !jsonMode;
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
    let starter: "minimal" | "react";
    let withAddons: readonly Addon[];
    let install: boolean;
    let git: boolean;
    if (wantWizard) {
      const w = await runWizard({
        projectName: args.projectName,
        target: args.target,
        starter: args.starter,
        withAddons: withAddonsFromFlag,
        install: args.install,
        git: args.git,
        ...(args.tenant !== undefined && { tenant: args.tenant }),
      });
      if (w.mode === "bolt-on") {
        return await dispatchBoltOn({
          outDir: resolveOutDir(w.projectName),
          tenant: w.tenant,
          force: args.force === true,
          install: w.install,
          pm: args.pm as "npm" | "pnpm" | "yarn" | undefined,
          json: jsonMode,
          isInteractive,
          installer: opts.installer,
          agentRules: withAddonsFromFlag?.includes("agent-rules") === true,
        });
      }
      projectName = w.projectName;
      target = w.target;
      starter = w.starter;
      withAddons = w.withAddons;
      install = w.install;
      git = w.git;
    } else {
      if (args.projectName === undefined) {
        throw new Error("projectName is required (positional)");
      }
      projectName = args.projectName;
      const outDir = resolveOutDir(projectName);
      if (args.target === "node" && existsSync(resolve(outDir, "wrangler.jsonc"))) {
        throw new Error(
          "create-baerly: detected wrangler.jsonc but --target=node was passed. " +
            "Bolt-on only supports Cloudflare. Remove --target=node, or move out of this directory to scaffold a Node app.",
        );
      }
      if (existsSync(resolve(outDir, "wrangler.jsonc"))) {
        return await dispatchBoltOn({
          outDir,
          tenant: args.tenant ?? "default",
          force: args.force === true,
          install: args.install === true,
          pm: args.pm as "npm" | "pnpm" | "yarn" | undefined,
          json: jsonMode,
          isInteractive,
          installer: opts.installer,
          agentRules: withAddonsFromFlag?.includes("agent-rules") === true,
        });
      }
      if (args.target === undefined) {
        throw new Error(`--target is required when not running in wizard mode (got undefined)`);
      }
      target = args.target;
      // Flag-driven path: scaffold() defaults to "minimal" internally,
      // so the explicit fallback here keeps the local `starter` type
      // tight without changing observed behavior.
      starter = args.starter ?? "minimal";
      withAddons = withAddonsFromFlag ?? [];
      // Flag-driven path: no wizard, so default to false unless the user
      // explicitly passed --install. Today's CI/agent callers see no
      // behavior change because they never pass --install.
      install = args.install === true;
      // Same shape as `install`: in flag-driven mode the default is off
      // so CI / agents see no behavior change unless they opt in with
      // `--git`. The wizard branch defaults to `true` because a fresh
      // scaffold without a baseline commit is a strict downgrade for
      // anyone iterating against `git diff`.
      git = args.git === true;
    }
    // Cross-field validation: each add-on's mode/target constraint
    // is checked here. Control only reaches this block in scaffold
    // mode — bolt-on dispatch already returned above.
    if (withAddons.includes("docker") && target !== "node") {
      throw new Error(
        `--with=docker only applies to --target=node. The Docker add-on adds a ` +
          `Dockerfile to the Node template. Use --target=node --with=docker, or ` +
          `drop --with=docker to scaffold for --target=${target}.`,
      );
    }
    if (withAddons.includes("agent-rules")) {
      throw new Error(
        `--with=agent-rules only applies to bolt-on mode (pnpm create baerly . ` +
          `inside an existing wrangler project). Scaffolded apps already include ` +
          `an AGENTS.md preamble — drop --with=agent-rules.`,
      );
    }
    const result = await scaffold({
      projectName,
      target,
      starter,
      ...(args.tenant !== undefined && { tenant: args.tenant }),
      ...(args.domain !== undefined && { domain: args.domain }),
      ...(args.pm !== undefined && { pm: args.pm as "npm" | "pnpm" | "yarn" }),
      ...(withAddons.length > 0 && { withAddons }),
    });
    // Resolve the package manager once; both the git commit body and
    // the optional install step read it.
    const pm = (args.pm as "npm" | "pnpm" | "yarn" | undefined) ?? detectPm();
    // Git init runs BEFORE install so the initial commit captures the
    // scaffold contents only — `node_modules/` is gitignored by the
    // template, but committing pre-install also keeps `git diff` from
    // the start matching exactly what `scaffold()` wrote.
    if (git) {
      const gitRunner = opts.gitRunner ?? defaultGitRunner;
      const pmVersion = probePmVersion(pm);
      const outcome = initRepoAndCommit(
        {
          outDir: result.outDir,
          cliVersion: result.cliVersion,
          appName: result.appName,
          target,
          starter,
          pm,
          ...(pmVersion !== undefined && { pmVersion }),
        },
        gitRunner,
      );
      if (!outcome.initialized && outcome.reason !== "already-in-repo") {
        // `already-in-repo` is a *silent* skip — the user opted into
        // scaffold-in-place inside an existing repo, so init would be
        // an error. Every other skip is worth surfacing so the user
        // knows the scaffold succeeded but the git step did not.
        const detail =
          outcome.message === undefined || outcome.message.length === 0
            ? ""
            : `: ${outcome.message}`;
        let hint = `${outcome.reason}${detail}`;
        if (outcome.reason === "git-not-available") {
          hint = `git is not installed; install it then run \`git init && git add . && git commit -m '…'\` in ${result.outDir}.`;
        } else if (outcome.reason === "no-identity") {
          hint = `git user.name / user.email are not configured. Set them with \`git config --global user.name '…'\` + \`git config --global user.email '…'\`, then commit manually.`;
        }
        process.stderr.write(`${pc.yellow("create-baerly:")} git init skipped — ${hint}\n`);
      }
    }
    if (install) {
      const installer = opts.installer ?? defaultInstaller;
      const { code } = await installer.run(pm, result.outDir);
      if (code !== 0) {
        process.stderr.write(
          `${pc.yellow("create-baerly:")} install exited with code ${code}. ` +
            `Run \`${pm} install\` in ${result.outDir} manually.\n`,
        );
      }
    }
    if (jsonMode) {
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
    if (jsonMode) {
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
  opts: { readonly installer?: Installer; readonly gitRunner?: GitRunner } = {},
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
