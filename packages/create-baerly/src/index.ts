/**
 * `create-baerly` entry. Invoked via `npm create baerly@latest --
 * my-app --target=cloudflare` (and the pnpm/yarn analogues).
 *
 * That `npm create` invocation is the **post-publish** form; until
 * the package ships to npm, stage locally from a clone via
 * `pnpm pack` + `pnpm dlx file:.../create-baerly-0.1.0.tgz` — see
 * the repo `README.md` Quick Start and ticket 04
 * (`docs/planning/tickets/04-pnpm-pack-install-path-and-readme.md`).
 *
 * Citty arg shape matches `@baerly/cli`'s `defineCommand` pattern
 * (see `packages/cli/src/copy.ts:193-216`).
 *
 * Two flows live here:
 *   - **Interactive wizard** — enters `runWizard` from `./prompts.ts`
 *     when stdin is a TTY *and* `--json` is not set *and* either
 *     `projectName` or `target` was omitted. See ticket 02.
 *   - **Flag-driven** — unchanged: CI, agents, piped stdin, and any
 *     TTY invocation with `--json` keep the existing behavior and
 *     the existing JSON envelope shape (part of the agent contract).
 */
import { defineCommand, runMain } from "citty";
import { outro } from "@clack/prompts";
import pc from "picocolors";
import { runWizard } from "./prompts.ts";
import { scaffold } from "./scaffold.ts";

const main = defineCommand({
  meta: {
    name: "create-baerly",
    version: "0.0.0",
    description: "Scaffold a new baerly app (Cloudflare Worker or self-hosted Node).",
  },
  args: {
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
      type: "string",
      description: 'Deploy target — "cloudflare" or "node".',
      // Optional at the citty layer so a bare `create-baerly` on a
      // TTY can fall into the wizard. The flag-driven branch below
      // re-validates when wizard mode is suppressed (non-TTY / --json).
      required: false,
      valueHint: "cloudflare|node",
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
    pm: {
      type: "string",
      description: 'Override package manager — "npm", "pnpm", or "yarn".',
      valueHint: "pm",
    },
    json: {
      type: "boolean",
      description: "Emit JSON envelope to stdout (success) or stderr (error).",
    },
  },
  run: async ({ args }) => {
    try {
      const isInteractive = process.stdin.isTTY === true && args.json !== true;
      const wantWizard =
        isInteractive && (args.projectName === undefined || args.target === undefined);
      let projectName: string;
      let target: "cloudflare" | "node";
      // The wizard returns `install` too; install handling itself is
      // unchanged from the prior code path (not yet implemented), so
      // the value is intentionally not threaded further.
      if (wantWizard) {
        const w = await runWizard({
          projectName: args.projectName,
          target: args.target === "cloudflare" || args.target === "node" ? args.target : undefined,
          install: args.install,
        });
        projectName = w.projectName;
        target = w.target;
      } else {
        // Flag-driven path. Errors thrown here match current behavior.
        if (args.projectName === undefined) {
          throw new Error("projectName is required (positional)");
        }
        if (args.target !== "cloudflare" && args.target !== "node") {
          throw new Error(
            `--target must be "cloudflare" or "node", got ${JSON.stringify(args.target)}`,
          );
        }
        projectName = args.projectName;
        target = args.target;
      }
      const result = await scaffold({
        projectName,
        target,
        ...(args.tenant !== undefined && { tenant: args.tenant }),
        ...(args.domain !== undefined && { domain: args.domain }),
        ...(args.pm !== undefined && { pm: args.pm as "npm" | "pnpm" | "yarn" }),
      });
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
        for (const s of result.nextSteps) process.stdout.write(`    ${s}\n`);
        process.stdout.write("\n");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (args.json === true) {
        process.stderr.write(
          `${JSON.stringify({ error: { code: "InvalidConfig", message: msg, command: "create-baerly" } })}\n`,
        );
      } else {
        process.stderr.write(`${pc.red("create-baerly:")} ${msg}\n`);
      }
      process.exit(1);
    }
  },
});

void runMain(main);
