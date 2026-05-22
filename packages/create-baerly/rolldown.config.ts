import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { defineConfig } from "rolldown";

/**
 * Bundle the scaffolder entry; copy the runnable example trees from
 * `../../examples/{minimal-cloudflare,minimal-node,react-cloudflare,react-node}/`
 * into `dist/templates/{minimal-cloudflare,minimal-node,react-cloudflare,react-node}/`,
 * AND copy the opt-in add-on trees from `templates/addons/<name>/`
 * (sibling to `src/`) into `dist/templates/addons/<name>/` so the
 * bundled binary is self-contained for both the base scaffold path
 * and the `--with=<addon>` layer.
 *
 * Output subdirectory names mirror the source names because
 * `scaffold.ts`'s `STARTER_TO_EXAMPLE` map joins the resolved
 * `templatesRoot` with the bare example name (e.g. `minimal-cloudflare`),
 * and `resolveAddonsRoot()` joins on the bare add-on name. Renaming
 * either output set would break the scaffolder.
 *
 * Per-example skips are read from each example's
 * `.baerly/scaffold.json:excludeNames` (literal basenames + `*.<ext>`
 * suffix globs) so the build artifact respects the same manifest the
 * runtime walker honours. Add-on trees don't ship a manifest, so the
 * add-on walk uses a tiny built-in list (`node_modules`) sufficient
 * for the published binary — any future add-on can opt into a richer
 * filter by carrying its own manifest.
 */
type SkipFn = (name: string) => boolean;

const splitExcludeNames = (names: readonly string[]): SkipFn => {
  const literals = new Set<string>();
  const suffixes: string[] = [];
  for (const n of names) {
    if (n.startsWith("*.")) {
      suffixes.push(n.slice(1));
    } else {
      literals.add(n);
    }
  }
  return (name) => {
    if (literals.has(name)) {
      return true;
    }
    for (const s of suffixes) {
      if (name.endsWith(s)) {
        return true;
      }
    }
    return false;
  };
};

const loadExampleSkipFn = (exampleSrc: string): SkipFn => {
  const manifestPath = join(exampleSrc, ".baerly", "scaffold.json");
  if (!existsSync(manifestPath)) {
    return () => false;
  }
  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as { excludeNames?: string[] };
  return splitExcludeNames(raw.excludeNames ?? []);
};

const copyTree = (src: string, dst: string, shouldSkip: SkipFn): void => {
  const walk = (rel: string): void => {
    const from = join(src, rel);
    for (const ent of readdirSync(from)) {
      if (shouldSkip(ent)) {
        continue;
      }
      const fromEnt = join(from, ent);
      const toEnt = join(dst, rel, ent);
      if (statSync(fromEnt).isDirectory()) {
        mkdirSync(toEnt, { recursive: true });
        walk(join(rel, ent));
      } else {
        mkdirSync(dirname(toEnt), { recursive: true });
        copyFileSync(fromEnt, toEnt);
      }
    }
  };
  walk("");
};

const addonSkip: SkipFn = (name) => name === "node_modules";

const copyTemplates = () => ({
  name: "copy-templates",
  closeBundle() {
    // Wipe the previous bundle's template tree so removed examples
    // or add-ons don't survive into the next published artifact. The
    // bundle's own `dist/index.js` (and its sourcemap) live one level
    // up under `dist/`, so this is a precise scoped reset.
    rmSync(join("dist", "templates"), { recursive: true, force: true });
    const EXAMPLES: readonly string[] = [
      "minimal-cloudflare",
      "minimal-node",
      "react-cloudflare",
      "react-node",
    ];
    for (const name of EXAMPLES) {
      const exampleSrc = join("..", "..", "examples", name);
      copyTree(exampleSrc, join("dist", "templates", name), loadExampleSkipFn(exampleSrc));
    }
    // Mirror the source `templates/addons/` tree into the bundle.
    // Each immediate subdirectory under `templates/addons/` is an
    // independent add-on (today: `docker`). We discover the set at
    // build time rather than hardcoding names — adding a new add-on
    // is then a single directory drop.
    const addonsSrc = join("templates", "addons");
    if (existsSync(addonsSrc)) {
      for (const name of readdirSync(addonsSrc)) {
        if (addonSkip(name)) {
          continue;
        }
        const addonSrc = join(addonsSrc, name);
        if (!statSync(addonSrc).isDirectory()) {
          continue;
        }
        copyTree(addonSrc, join("dist", "templates", "addons", name), addonSkip);
      }
    }
  },
});

export default defineConfig({
  input: "src/index.ts",
  external: ["@clack/prompts", "citty", "picocolors", /^node:/],
  output: {
    file: "dist/index.js",
    format: "esm",
    sourcemap: true,
    banner: "#!/usr/bin/env node",
  },
  plugins: [copyTemplates()],
});
