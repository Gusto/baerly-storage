/**
 * `create-baerly` entry. Invoked via `npm create baerly@latest --
 * my-app --target=cloudflare` (and the pnpm/yarn analogues).
 *
 * Citty arg shape matches `@baerly/cli`'s `defineCommand` pattern
 * (see `packages/cli/src/copy.ts:193-216`).
 */
import { defineCommand, runMain } from "citty";
import pc from "picocolors";
import { scaffold } from "./scaffold";

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
      required: true,
      valueHint: "name",
    },
    target: {
      type: "string",
      description: 'Deploy target — "cloudflare" or "node".',
      required: true,
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
      if (args.target !== "cloudflare" && args.target !== "node") {
        throw new Error(
          `--target must be "cloudflare" or "node", got ${JSON.stringify(args.target)}`,
        );
      }
      const result = await scaffold({
        projectName: args.projectName,
        target: args.target,
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
      } else {
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
