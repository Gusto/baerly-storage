/**
 * The wrangler bolt-on flow for `create-baerly-storage`. Runs when `runner.ts`
 * detects an existing `wrangler.jsonc` in the resolved `outDir` — the
 * user has a Cloudflare Worker project already and wants to add
 * baerly. No template copy. Patches the mergeable files
 * (`wrangler.jsonc`, `.dev.vars`, `.gitignore`, `package.json`),
 * writes `baerly.config.ts` (skip-if-exists), and returns the
 * worker-entry snippet for the caller to print.
 *
 * Mirrors Convex's `npx convex dev` philosophy: structured config is
 * fair game; user code (`src/index.ts`) is sacred — printed, never
 * written.
 */

import { constants } from "node:fs";
import { readFile, writeFile, appendFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { BaerlyError } from "@baerly/protocol";
import type { BaerlyAppConfig } from "@baerly/server";
import { patchWranglerJsonc, readWranglerName, readWranglerMain } from "@baerly/cli/wrangler-patch";
import { renderWorkerEntrySnippet } from "./init-snippet.ts";
import { detectPm, type Pm } from "./pm-detect.ts";
import { defaultInstaller, type Installer } from "./install.ts";
import { writeAgentRulesBlock, type AgentRulesResult } from "./agent-rules.ts";

const DEV_SHARED_SECRET = "dev-shared-secret";

// Lines that, if present literally in .gitignore, are treated as "the user
// already has a story for env-var files." We don't add a separate .dev.vars
// entry in that case — we trust their convention. (NOT gitignore glob semantics.)
const GITIGNORE_DEV_VARS_ALIASES = new Set([
  ".dev.vars",
  ".dev.vars*",
  ".env*.local",
  "*.local",
  ".env",
]);

export interface BoltOnOptions {
  readonly outDir: string;
  readonly tenant: string;
  readonly app?: string;
  readonly force?: boolean;
  readonly runInstall?: boolean;
  readonly pm?: Pm;
  readonly installer?: Installer;
  /**
   * When `true`, drop a delimited "this repo uses @gusto/baerly-storage"
   * block telling the user's AI agent where the canonical API
   * surface lives. Default `false`. See `agent-rules.ts` for the
   * target-detection chain and the literal block content.
   */
  readonly agentRules?: boolean;
}

export interface BoltOnResult {
  readonly app: string;
  readonly tenant: string;
  readonly changes: readonly string[];
  readonly snippet: string;
  readonly snippetTarget: string;
  readonly nextSteps: readonly string[];
  /** Present iff `opts.agentRules === true`. */
  readonly agentRules?: AgentRulesResult;
}

const configTemplate = (app: string, tenant: string): string => {
  const cfg = {
    app,
    tenant,
    target: "cloudflare",
    auth: "none",
    collections: {},
  } as const satisfies BaerlyAppConfig;
  return `import { defineConfig } from "@gusto/baerly-storage/config";

export default defineConfig(${JSON.stringify(cfg, null, 2)});
`;
};

const gitignoreCovers = (text: string, line: string): boolean => {
  const lines = text.split("\n").map((l) => l.trim());
  return lines.some((l) => GITIGNORE_DEV_VARS_ALIASES.has(l) || l === line);
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const appendBaerlyStorageDep = async (pkgJsonPath: string, changes: string[]): Promise<void> => {
  const raw = await readFile(pkgJsonPath, "utf8");
  let pkg: { dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
  } catch (error) {
    throw new BaerlyError(
      "InvalidConfig",
      `create-baerly-storage bolt-on: ${pkgJsonPath} is not valid JSON — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  pkg.dependencies = pkg.dependencies ?? {};
  if (pkg.dependencies["@gusto/baerly-storage"] !== undefined) {
    return;
  }
  pkg.dependencies["@gusto/baerly-storage"] = "*";
  await writeFile(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  changes.push("package.json: added @gusto/baerly-storage dependency");
};

export const boltOnExistingWrangler = async (opts: BoltOnOptions): Promise<BoltOnResult> => {
  const wranglerPath = resolve(opts.outDir, "wrangler.jsonc");
  if (!(await fileExists(wranglerPath))) {
    throw new BaerlyError(
      "InvalidConfig",
      `create-baerly-storage bolt-on: ${wranglerPath} missing — bolt-on mode requires wrangler.jsonc`,
    );
  }
  const wranglerSource = await readFile(wranglerPath, "utf8");
  const detectedName = readWranglerName(wranglerSource);
  const detectedMain = readWranglerMain(wranglerSource) ?? "src/index.ts";

  const app = opts.app ?? detectedName;
  if (typeof app !== "string" || app.length === 0) {
    throw new BaerlyError(
      "InvalidConfig",
      "create-baerly-storage bolt-on: --app=<name> is required (no wrangler.jsonc:name to infer from)",
    );
  }

  const changes: string[] = [];

  const patch = patchWranglerJsonc(
    wranglerSource,
    { binding: "BUCKET", bucket_name: app },
    { APP: app, TENANT: opts.tenant },
  );
  if (patch.changes.length > 0) {
    await writeFile(wranglerPath, patch.text, "utf8");
    for (const c of patch.changes) {
      changes.push(`wrangler.jsonc: ${c}`);
    }
  }

  const devVarsPath = resolve(opts.outDir, ".dev.vars");
  if (!(await fileExists(devVarsPath))) {
    await writeFile(devVarsPath, `SHARED_SECRET=${DEV_SHARED_SECRET}\n`, "utf8");
    changes.push(".dev.vars: seeded SHARED_SECRET (dev-only placeholder; replace before deploy)");
  }

  const gitignorePath = resolve(opts.outDir, ".gitignore");
  let gitignoreText = "";
  if (await fileExists(gitignorePath)) {
    gitignoreText = await readFile(gitignorePath, "utf8");
  }
  if (!gitignoreCovers(gitignoreText, ".dev.vars")) {
    const suffix = gitignoreText.length === 0 || gitignoreText.endsWith("\n") ? "" : "\n";
    await appendFile(gitignorePath, `${suffix}.dev.vars\n`, "utf8");
    changes.push(".gitignore: added .dev.vars");
  }

  const configPath = resolve(opts.outDir, "baerly.config.ts");
  const configExists = await fileExists(configPath);
  if (!configExists || opts.force === true) {
    await writeFile(configPath, configTemplate(app, opts.tenant), "utf8");
    changes.push(`baerly.config.ts: ${configExists ? "rewrote" : "wrote"}`);
  }

  const pkgJsonPath = resolve(opts.outDir, "package.json");
  if (await fileExists(pkgJsonPath)) {
    await appendBaerlyStorageDep(pkgJsonPath, changes);
  }

  let agentRules: AgentRulesResult | undefined;
  if (opts.agentRules === true) {
    agentRules = await writeAgentRulesBlock(opts.outDir);
    const relPath = agentRules.path.startsWith(opts.outDir)
      ? agentRules.path.slice(opts.outDir.length + 1)
      : agentRules.path;
    changes.push(`${relPath}: ${agentRules.action} agent-rules block`);
  }

  if (opts.runInstall === true) {
    const pm = opts.pm ?? detectPm();
    const installer = opts.installer ?? defaultInstaller;
    await installer.run(pm, opts.outDir);
    changes.push(`${pm} install`);
  }

  const snippet = renderWorkerEntrySnippet({
    tenant: opts.tenant,
    wranglerMain: detectedMain,
  });

  return {
    app,
    tenant: opts.tenant,
    changes,
    snippet,
    snippetTarget: detectedMain,
    nextSteps: [
      `Paste the snippet above into ${detectedMain}, replacing the stock handler.`,
      `Before deploy: \`wrangler secret put SHARED_SECRET\` (the .dev.vars value is dev-only).`,
    ],
    ...(agentRules !== undefined && { agentRules }),
  };
};
