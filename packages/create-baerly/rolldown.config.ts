import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineConfig } from "rolldown";

/**
 * Bundle the scaffolder entry; copy the runnable example trees from
 * `../../examples/{minimal-cloudflare,minimal-node,helpdesk-cloudflare}/`
 * into `dist/templates/{minimal-cloudflare,minimal-node,helpdesk-cloudflare}/`,
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
 * Skips:
 *   - `node_modules/` — workspace-installed, huge, irrelevant to the
 *     published package.
 *   - `dist/`, `.wrangler/`, `.dev.vars`, `.DS_Store`, `*.tsbuildinfo`
 *     — dev-time / build artifacts. Gitignored in every example tree
 *     but live in any contributor working dir that ran `pnpm build`
 *     / `wrangler deploy` before `pnpm -F create-baerly build`.
 *     Mirrors the runtime walker skip list in `scaffold.ts`.
 * Includes `.baerly/scaffold.json` (the manifest the scaffolder reads
 * at runtime) — without it, dist mode breaks.
 */
const SKIP_NAMES = new Set(["node_modules", "dist", ".wrangler", ".dev.vars", ".DS_Store"]);
const shouldSkip = (name: string): boolean => SKIP_NAMES.has(name) || name.endsWith(".tsbuildinfo");

const copyTree = (src: string, dst: string): void => {
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
      "helpdesk-cloudflare",
    ];
    for (const name of EXAMPLES) {
      copyTree(join("..", "..", "examples", name), join("dist", "templates", name));
    }
    // Mirror the source `templates/addons/` tree into the bundle.
    // Each immediate subdirectory under `templates/addons/` is an
    // independent add-on (today: `docker`). We discover the set at
    // build time rather than hardcoding names — adding a new add-on
    // is then a single directory drop.
    const addonsSrc = join("templates", "addons");
    if (existsSync(addonsSrc)) {
      for (const name of readdirSync(addonsSrc)) {
        if (shouldSkip(name)) {
          continue;
        }
        const addonSrc = join(addonsSrc, name);
        if (!statSync(addonSrc).isDirectory()) {
          continue;
        }
        copyTree(addonSrc, join("dist", "templates", "addons", name));
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
