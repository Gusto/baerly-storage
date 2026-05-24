import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve, sep } from "node:path";
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
  /**
   * Lowercase alphanumeric + `-` / `_`, starting with `[a-z0-9]`.
   * `"."` is a sentinel that scaffolds into the current `outRoot`
   * (or `process.cwd()` when `outRoot` is unset); the `appName`
   * substitution sentinel is then derived from that directory's
   * basename and must itself satisfy the same regex.
   */
  readonly projectName: string;
  readonly target: "cloudflare" | "node";
  readonly starter?: "minimal" | "react";
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

/**
 * When `projectName === "."` (scaffold into the current directory),
 * a pre-existing entry whose basename is in this set is always
 * permitted — even if the scaffold also ships a file by the same
 * name (the scaffold overwrites). Other names are checked against
 * the precomputed "would-write" set (see `topLevelOutputs`); only
 * actual collisions fail the guard, so a pre-existing `.npmrc` /
 * `mise.toml` / `.tool-versions` (or any other top-level metadata
 * the user already wrote) coexists with the scaffold.
 */
const SCAFFOLD_HERE_ALLOWLIST: ReadonlySet<string> = new Set([
  ".git",
  ".gitignore",
  ".gitattributes",
  "README.md",
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
]);

/**
 * Compute the set of top-level basenames the scaffold will emit
 * into `outDir`. Used by the `inPlace` guard to decide which
 * pre-existing entries actually collide.
 *
 * Mirrors the logic in `walk()`: applies `excludePaths` /
 * `excludeNames`, renames `_gitignore` → `.gitignore`, and folds
 * in the top-level destination of each `manifest.copies` entry.
 * Add-ons layer on top of the base template via the same walker,
 * so their top-level basenames are included here too.
 */
const topLevelOutputs = (
  templateDir: string,
  manifest: ScaffoldManifest,
  addonDirs: readonly string[],
): Set<string> => {
  const excluded = new Set(manifest.excludePaths.map((p) => p.split("/").join(sep)));
  const { literals: excludeLiterals, suffixes: excludeSuffixes } = splitExcludeNames(
    manifest.excludeNames,
  );
  const matchesExcludeName = (name: string): boolean => {
    if (excludeLiterals.has(name)) {
      return true;
    }
    for (const suffix of excludeSuffixes) {
      if (name.endsWith(suffix)) {
        return true;
      }
    }
    return false;
  };
  const out = new Set<string>();
  const addTopLevel = (sourceDir: string): void => {
    for (const ent of readdirSync(sourceDir)) {
      if (excluded.has(ent) || matchesExcludeName(ent)) {
        continue;
      }
      out.add(ent === "_gitignore" ? ".gitignore" : ent);
    }
  };
  addTopLevel(templateDir);
  for (const addonDir of addonDirs) {
    addTopLevel(addonDir);
  }
  for (const copy of manifest.copies) {
    const dest = copy.to.split("/").join(sep);
    const firstSeg = dest.split(sep)[0];
    if (firstSeg !== undefined && firstSeg.length > 0) {
      out.add(firstSeg);
    }
  }
  return out;
};

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
  "cloudflare:react": "react-cloudflare",
  "node:minimal": "minimal-node",
  "node:react": "react-node",
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
  if (existsSync(distSidecar)) {
    return distSidecar;
  }
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
  if (existsSync(distSidecar)) {
    return distSidecar;
  }
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
  excludeNames: [],
  dropDevDeps: [],
  copies: [],
};

const loadManifest = (exampleRoot: string): ScaffoldManifest => {
  const p = join(exampleRoot, ".baerly", "scaffold.json");
  if (!existsSync(p)) {
    return DEFAULT_MANIFEST;
  }
  const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<ScaffoldManifest>;
  return {
    renames: raw.renames ?? [],
    excludePaths: raw.excludePaths ?? [".baerly/scaffold.json"],
    excludeNames: raw.excludeNames ?? [],
    dropDevDeps: raw.dropDevDeps ?? [],
    copies: raw.copies ?? [],
  };
};

/**
 * `excludeNames` supports both literal basenames (`node_modules`)
 * and `*.<ext>` suffix globs (`*.tsbuildinfo`). Split once per
 * scaffold; the walker calls `matchesExcludeName` per entry.
 */
const splitExcludeNames = (
  names: readonly string[],
): { literals: Set<string>; suffixes: string[] } => {
  const literals = new Set<string>();
  const suffixes: string[] = [];
  for (const n of names) {
    if (n.startsWith("*.")) {
      suffixes.push(n.slice(1));
    } else {
      literals.add(n);
    }
  }
  return { literals, suffixes };
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
  // `"."` (exactly one character) is the sole sentinel for "scaffold
  // into the current directory" — matches `npm create vite@latest`
  // and `create-next-app`. `"./"`, `"./foo"`, `".."`, etc. fall
  // through to the regex check below and are rejected like any other
  // invalid name.
  const inPlace = opts.projectName === ".";
  // MUST mirror the regex in `prompts.ts:promptProjectName`.
  if (!inPlace && !/^[a-z0-9][a-z0-9_-]*$/.test(opts.projectName)) {
    throw new Error(
      `create-baerly: projectName must be lowercase, alphanumeric + "_"/"-", starting with [a-z0-9] (got ${JSON.stringify(opts.projectName)})`,
    );
  }
  const pm = opts.pm ?? detectPm();
  const tenant = opts.tenant ?? "default";
  const domain = opts.domain ?? "";
  const templatesRoot = opts.templatesRoot ?? resolveTemplatesRoot();
  const outRoot = opts.outRoot ?? process.cwd();
  const outDir = inPlace ? resolve(outRoot) : resolve(outRoot, opts.projectName);
  // When scaffolding into the current directory, derive the
  // substitution sentinel (`appName`) from the directory's basename
  // and re-run it through the same regex — the value lands in
  // `package.json:name`, `wrangler.jsonc`, etc., which all require
  // an npm-package-shaped slug.
  const appName = inPlace ? basename(outDir) : opts.projectName;
  if (inPlace && !/^[a-z0-9][a-z0-9_-]*$/.test(appName)) {
    throw new Error(
      `create-baerly: appName must be lowercase, alphanumeric + "_"/"-", starting with [a-z0-9] (got ${JSON.stringify(appName)}) — derived from current directory ${JSON.stringify(outDir)}`,
    );
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

  // Resolve add-on directories up-front so the in-place collision
  // check below can see their top-level outputs too, and so an
  // unknown add-on fails fast before we start writing files.
  const addons = opts.withAddons ?? [];
  const addonsRoot = addons.length > 0 ? (opts.addonsRoot ?? resolveAddonsRoot()) : "";
  const addonDirs: string[] = [];
  for (const addon of addons) {
    const addonDir = join(addonsRoot, addon);
    if (!existsSync(addonDir)) {
      throw new Error(`create-baerly: add-on directory not found: ${addonDir} (addon=${addon})`);
    }
    addonDirs.push(addonDir);
  }

  if (existsSync(outDir)) {
    const entries = readdirSync(outDir);
    if (inPlace) {
      // Allow pre-existing files that don't collide with the scaffold:
      // a user's `.npmrc`, `mise.toml`, `.tool-versions`, etc. should
      // survive untouched. The allowlist (`.git`, `README.md`, …) is a
      // strict superset — those names are permitted even when the
      // scaffold also ships them (the scaffold overwrites).
      const wouldWrite = topLevelOutputs(templateDir, manifest, addonDirs);
      const colliding = entries.filter((e) => !SCAFFOLD_HERE_ALLOWLIST.has(e) && wouldWrite.has(e));
      if (colliding.length > 0) {
        throw new Error(
          `create-baerly: ${outDir} contains files that would be overwritten: ${colliding.join(", ")}. ` +
            `Move or remove these, then re-run.`,
        );
      }
    } else if (entries.length > 0) {
      throw new Error(`create-baerly: ${outDir} exists and is non-empty`);
    }
  }

  const vars: Record<string, string> = {
    appName,
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
  const { literals: excludeLiterals, suffixes: excludeSuffixes } = splitExcludeNames(
    manifest.excludeNames,
  );
  const matchesExcludeName = (name: string): boolean => {
    if (excludeLiterals.has(name)) {
      return true;
    }
    for (const suffix of excludeSuffixes) {
      if (name.endsWith(suffix)) {
        return true;
      }
    }
    return false;
  };

  const copyByFrom = new Map<string, string>(
    manifest.copies.map((c) => [c.from.split("/").join(sep), c.to.split("/").join(sep)]),
  );

  const filesWritten: string[] = [];
  const walk = (sourceDir: string, rel: string): void => {
    const from = join(sourceDir, rel);
    for (const ent of readdirSync(from)) {
      const fromEnt = join(from, ent);
      const relEnt = rel === "" ? ent : join(rel, ent);
      if (isExcluded(relEnt) || matchesExcludeName(ent)) {
        continue;
      }
      // `npm pack` strips `.gitignore` files from published tarballs
      // (it reads each one as an ignore-source control file and then
      // drops the file itself), so template trees ship `_gitignore`
      // and we rename on emit. Same trick as create-vite. Output
      // file name lives in `outName` / `relOut`; the source name
      // (`ent` / `relEnt`) is unchanged for read + manifest lookup.
      const outName = ent === "_gitignore" ? ".gitignore" : ent;
      const relOut = rel === "" ? outName : join(rel, outName);
      const toEnt = join(outDir, relOut);
      if (statSync(fromEnt).isDirectory()) {
        mkdirSync(toEnt, { recursive: true });
        walk(sourceDir, relEnt);
      } else {
        const ext = ent.includes(".") ? ent.slice(ent.lastIndexOf(".")) : "";
        const isText = TEXT_EXTS.has(ext) || ent === "Dockerfile" || ent === "_gitignore";
        mkdirSync(dirname(toEnt), { recursive: true });
        if (ent === "package.json") {
          writeFileSync(toEnt, substitutePackageJson(readFileSync(fromEnt, "utf8"), ctx));
        } else if (isText) {
          writeFileSync(toEnt, substituteText(readFileSync(fromEnt, "utf8"), ctx));
        } else {
          writeFileSync(toEnt, readFileSync(fromEnt));
        }
        filesWritten.push(relOut);
        const copyTo = copyByFrom.get(relEnt);
        if (copyTo !== undefined) {
          const copyDest = join(outDir, copyTo);
          mkdirSync(dirname(copyDest), { recursive: true });
          writeFileSync(copyDest, substituteText(readFileSync(fromEnt, "utf8"), ctx));
          filesWritten.push(copyTo);
        }
      }
    }
  };
  walk(templateDir, "");

  // Layer requested add-ons on top of the base scaffold. Each add-on
  // directory was already resolved + existence-checked above so the
  // in-place collision guard could see its top-level outputs; here we
  // just walk them through the same substituter pass as the base
  // template (reusing the host's manifest so the appName sentinel
  // rewrite picks up any literal in the add-on files too).
  for (const addonDir of addonDirs) {
    walk(addonDir, "");
  }

  // When scaffolding into the current directory the user is already
  // sitting in `outDir`, so the `cd <projectName>` step would be a
  // no-op confusion. Drop it.
  const nextSteps = inPlace
    ? [installCommand(pm), runCommand(pm, "dev")]
    : [`cd ${opts.projectName}`, installCommand(pm), runCommand(pm, "dev")];
  return { outDir, filesWritten, nextSteps };
};
