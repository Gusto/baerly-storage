import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { detectPm, installCommand, runCommand, type Pm } from "./pm-detect.ts";
import {
  type ScaffoldManifest,
  type SubstituteContext,
  substitutePackageJson,
  substituteText,
} from "./substitute.ts";

/**
 * Optional add-ons that can be layered on top of the base template at
 * scaffold time. Each add-on is a directory under
 * `packages/create-baerly/templates/addons/<name>/`; its files are
 * copied (and substituted) on top of the scaffolded project. Today
 * `docker` is the only add-on; expanding this tuple is the only place
 * to declare a new one — the runtime validator and the wizard's
 * conditional prompts both derive from `KNOWN_ADDONS`.
 */
export const KNOWN_ADDONS = ["docker"] as const;
export type Addon = (typeof KNOWN_ADDONS)[number];

export interface ScaffoldOptions {
  readonly projectName: string;
  readonly target: "cloudflare" | "node";
  readonly starter?: "minimal" | "helpdesk";
  readonly pm?: Pm;
  readonly tenant?: string;
  readonly domain?: string;
  /** Add-ons to layer on top of the base template. */
  readonly withAddons?: readonly Addon[];
  /** Override the templates root. Tests inject a fixture path. */
  readonly templatesRoot?: string;
  /** Override the add-ons root. Tests inject a fixture path. */
  readonly addonsRoot?: string;
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
 * `${target}:${starter}` → example directory name (under `examples/`).
 * Default starter is `"minimal"`. The compound key lets us add richer
 * starters per target without renaming or duplicating maps.
 */
const STARTER_TO_EXAMPLE: Record<string, string> = {
  "cloudflare:minimal": "minimal-cloudflare",
  "cloudflare:helpdesk": "helpdesk-cloudflare",
  "node:minimal": "minimal-node",
};

/**
 * Resolve the templates root. In a built CLI, examples are copied
 * to `dist/templates/<name>/` so the binary is self-contained
 * (preserving today's `package.json:files` shape). In dev (running
 * straight from `src/` via Node's strip-types) the same directory
 * doesn't exist, so we fall back to `examples/` three levels up
 * (`src/ → create-baerly/ → packages/ → repo-root`).
 */
const resolveTemplatesRoot = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  const distSidecar = resolve(here, "templates");
  if (existsSync(distSidecar)) return distSidecar;
  return resolve(here, "..", "..", "..", "examples");
};

/**
 * Resolve the add-ons root. In a built CLI, add-on trees are copied
 * to `dist/templates/addons/<name>/` next to the example templates.
 * In dev (running from `src/` via Node's strip-types) they live at
 * `packages/create-baerly/templates/addons/<name>/`, one level up
 * from `src/`.
 */
const resolveAddonsRoot = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  const distSidecar = resolve(here, "templates", "addons");
  if (existsSync(distSidecar)) return distSidecar;
  return resolve(here, "..", "templates", "addons");
};

/**
 * Read the CLI's own package.json:version. Used to rewrite
 * `workspace:*` dep specs to `^X.Y.Z` at copy time, since
 * `create-baerly` ships in the same release train as `@baerly/*`.
 */
const readCliVersion = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  // `src/scaffold.ts` and `dist/index.js` both sit one level under the
  // package root, so `../package.json` works for both.
  const pkgPath = resolve(here, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error(`create-baerly: could not read version from ${pkgPath}`);
  }
  return pkg.version;
};

const DEFAULT_MANIFEST: ScaffoldManifest = {
  renames: [],
  excludePaths: [".baerly/scaffold.json"],
  dropDevDeps: [],
};

const loadManifest = (exampleRoot: string): ScaffoldManifest => {
  const p = join(exampleRoot, ".baerly", "scaffold.json");
  if (!existsSync(p)) return DEFAULT_MANIFEST;
  const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<ScaffoldManifest>;
  return {
    renames: raw.renames ?? [],
    excludePaths: raw.excludePaths ?? [".baerly/scaffold.json"],
    dropDevDeps: raw.dropDevDeps ?? [],
  };
};

/**
 * Walk the source example tree, apply manifest-driven rewrites, and
 * write to `outRoot/<projectName>/`. Returns the absolute output
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
  // MUST mirror the regex in `prompts.ts:promptProjectName`.
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(opts.projectName)) {
    throw new Error(
      `create-baerly: projectName must be lowercase, alphanumeric + "_"/"-", starting with [a-z0-9] (got ${JSON.stringify(opts.projectName)})`,
    );
  }
  const pm = opts.pm ?? detectPm();
  const tenant = opts.tenant ?? "default";
  const domain = opts.domain ?? "";
  const templatesRoot = opts.templatesRoot ?? resolveTemplatesRoot();
  const outRoot = opts.outRoot ?? process.cwd();
  const outDir = resolve(outRoot, opts.projectName);
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new Error(`create-baerly: ${outDir} exists and is non-empty`);
  }

  const starter = opts.starter ?? "minimal";
  const lookupKey = `${opts.target}:${starter}`;
  const exampleName = STARTER_TO_EXAMPLE[lookupKey];
  const templateDir = exampleName === undefined ? "" : join(templatesRoot, exampleName);
  if (exampleName === undefined || !existsSync(templateDir)) {
    throw new Error(
      `create-baerly: template not found for target=${opts.target} starter=${starter}`,
    );
  }

  const manifest = loadManifest(templateDir);
  const vars: Record<string, string> = {
    appName: opts.projectName,
    tenant,
    domain,
    pm,
    installCmd: installCommand(pm),
    runDev: runCommand(pm, "dev"),
    runTypecheck: runCommand(pm, "typecheck"),
  };
  const ctx: SubstituteContext = { manifest, vars, cliVersion: readCliVersion() };

  const excluded = new Set(manifest.excludePaths.map((p) => p.split("/").join(sep)));
  const isExcluded = (rel: string): boolean => excluded.has(rel);

  const filesWritten: string[] = [];
  const walk = (sourceDir: string, rel: string): void => {
    const from = join(sourceDir, rel);
    for (const ent of readdirSync(from)) {
      const fromEnt = join(from, ent);
      const relEnt = rel === "" ? ent : join(rel, ent);
      if (isExcluded(relEnt)) continue;
      // Always skip dev-time / build artifacts. These are gitignored
      // in every example tree but live inside the working dir of any
      // contributor who ran `pnpm build` or `wrangler deploy` against
      // an example before invoking the scaffolder. Hardcoding the
      // list here keeps the per-example manifests focused on the
      // semantic excludes (e.g. `uint8array-base64.d.ts`).
      if (
        ent === "node_modules" ||
        ent === "dist" ||
        ent === ".wrangler" ||
        ent === ".dev.vars" ||
        ent === ".DS_Store" ||
        ent.endsWith(".tsbuildinfo")
      ) {
        continue;
      }
      const toEnt = join(outDir, relEnt);
      if (statSync(fromEnt).isDirectory()) {
        mkdirSync(toEnt, { recursive: true });
        walk(sourceDir, relEnt);
      } else {
        const ext = ent.includes(".") ? ent.slice(ent.lastIndexOf(".")) : "";
        const isText = TEXT_EXTS.has(ext) || ent === "Dockerfile";
        mkdirSync(dirname(toEnt), { recursive: true });
        if (ent === "package.json") {
          writeFileSync(toEnt, substitutePackageJson(readFileSync(fromEnt, "utf8"), ctx));
        } else if (isText) {
          writeFileSync(toEnt, substituteText(readFileSync(fromEnt, "utf8"), ctx));
        } else {
          writeFileSync(toEnt, readFileSync(fromEnt));
        }
        filesWritten.push(relEnt);
        // AGENTS.md ↔ CLAUDE.md parity:
        // Codex CLI reads AGENTS.md; Claude Code reads CLAUDE.md.
        // Write both copies from the same substituted template so a
        // freshly scaffolded app gives both tools identical context.
        if (rel === "" && ent === "AGENTS.md") {
          const claudeMdPath = join(outDir, "CLAUDE.md");
          const content = substituteText(readFileSync(fromEnt, "utf8"), ctx);
          writeFileSync(claudeMdPath, content);
          filesWritten.push("CLAUDE.md");
        }
      }
    }
  };
  walk(templateDir, "");

  // Layer requested add-ons on top of the base scaffold. Each add-on
  // is a directory under `addonsRoot/<name>/`; its files are walked
  // through the same substituter pass as the base template, reusing
  // the host's manifest (so the appName sentinel rewrite picks up
  // any literal in the add-on files too).
  const addons = opts.withAddons ?? [];
  if (addons.length > 0) {
    const addonsRoot = opts.addonsRoot ?? resolveAddonsRoot();
    for (const addon of addons) {
      const addonDir = join(addonsRoot, addon);
      if (!existsSync(addonDir)) {
        throw new Error(
          `create-baerly: add-on directory not found: ${addonDir} (addon=${addon})`,
        );
      }
      walk(addonDir, "");
    }
  }

  const nextSteps = [`cd ${opts.projectName}`, installCommand(pm), runCommand(pm, "dev")];
  return { outDir, filesWritten, nextSteps };
};
