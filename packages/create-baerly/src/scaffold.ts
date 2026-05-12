import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { detectPm, installCommand, runCommand, type Pm } from "./pm-detect";
import { substitute } from "./substitute";

export interface ScaffoldOptions {
  readonly projectName: string;
  readonly target: "cloudflare" | "node";
  readonly pm?: Pm;
  readonly tenant?: string;
  readonly domain?: string;
  /** Override the templates root. Tests inject a fixture path. */
  readonly templatesRoot?: string;
  /** Override the output root. Tests inject a tmpdir. */
  readonly outRoot?: string;
}

export interface ScaffoldResult {
  readonly outDir: string;
  readonly filesWritten: readonly string[];
  readonly nextSteps: readonly string[];
}

const TEXT_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".cjs",
  ".json",
  ".jsonc",
  ".md",
  ".toml",
  ".yaml",
  ".yml",
  ".html",
  ".css",
  ".gitignore",
  ".dockerignore",
  ".example",
  ".service",
]);

/**
 * Walk `templatesRoot/<target>/`, substitute placeholders, write
 * to `outRoot/<projectName>/`. Returns the absolute output
 * directory and the relative list of files written.
 *
 * Refuses to overwrite an existing non-empty directory — fails
 * fast with a thrown Error. Callers catch and translate to the
 * CLI's exit-code contract.
 */
export const scaffold = async (opts: ScaffoldOptions): Promise<ScaffoldResult> => {
  if (opts.projectName.length === 0) {
    throw new Error("create-baerly: projectName must be non-empty");
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(opts.projectName)) {
    throw new Error(
      `create-baerly: projectName must be lowercase, alphanumeric + "_"/"-", starting with [a-z0-9] (got ${JSON.stringify(opts.projectName)})`,
    );
  }
  const pm = opts.pm ?? detectPm();
  const tenant = opts.tenant ?? "default";
  const domain = opts.domain ?? "";
  const templatesRoot =
    opts.templatesRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "templates");
  const outRoot = opts.outRoot ?? process.cwd();
  const outDir = resolve(outRoot, opts.projectName);
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new Error(`create-baerly: ${outDir} exists and is non-empty`);
  }

  const vars: Record<string, string> = {
    appName: opts.projectName,
    tenant,
    domain,
    pm,
    installCmd: installCommand(pm),
    runDev: runCommand(pm, "dev"),
    runTypecheck: runCommand(pm, "typecheck"),
  };

  const templateDir = join(templatesRoot, opts.target);
  if (!existsSync(templateDir)) {
    throw new Error(`create-baerly: template not found for target=${opts.target}`);
  }

  const filesWritten: string[] = [];
  const walk = (rel: string): void => {
    const from = join(templateDir, rel);
    for (const ent of readdirSync(from)) {
      const fromEnt = join(from, ent);
      const relEnt = join(rel, ent);
      const toEnt = join(outDir, relEnt);
      if (statSync(fromEnt).isDirectory()) {
        mkdirSync(toEnt, { recursive: true });
        walk(relEnt);
      } else {
        const ext = ent.includes(".") ? ent.slice(ent.lastIndexOf(".")) : "";
        const isText = TEXT_EXTS.has(ext) || ent === "Dockerfile";
        mkdirSync(dirname(toEnt), { recursive: true });
        if (isText) {
          const content = readFileSync(fromEnt, "utf8");
          writeFileSync(toEnt, substitute(content, vars));
        } else {
          writeFileSync(toEnt, readFileSync(fromEnt));
        }
        filesWritten.push(relEnt);
      }
    }
  };
  walk("");

  const nextSteps = [`cd ${opts.projectName}`, installCommand(pm), runCommand(pm, "dev")];
  return { outDir, filesWritten, nextSteps };
};
