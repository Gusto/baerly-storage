import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineConfig } from "rolldown";

/**
 * Bundle the scaffolder entry; copy the runnable example trees from
 * `../../examples/{minimal-cloudflare,minimal-node-railway,minimal-node-docker,helpdesk-cloudflare}/`
 * into `dist/templates/{minimal-cloudflare,minimal-node-railway,minimal-node-docker,helpdesk-cloudflare}/`
 * so the bundled binary can find its templates at runtime.
 *
 * The output subdirectory names mirror the source example directory
 * names because `scaffold.ts`'s `STARTER_TO_EXAMPLE` map joins the
 * resolved `templatesRoot` with the bare example name (e.g.
 * `minimal-cloudflare`). Renaming the output to `cloudflare`/`node`
 * would break the scaffolder.
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
const copyTemplates = () => ({
  name: "copy-templates",
  closeBundle() {
    const EXAMPLES: readonly string[] = [
      "minimal-cloudflare",
      "minimal-node",
      "minimal-node-docker",
      "helpdesk-cloudflare",
    ];
    const SKIP_NAMES = new Set([
      "node_modules",
      "dist",
      ".wrangler",
      ".dev.vars",
      ".DS_Store",
    ]);
    const shouldSkip = (name: string): boolean =>
      SKIP_NAMES.has(name) || name.endsWith(".tsbuildinfo");
    for (const name of EXAMPLES) {
      const src = join("..", "..", "examples", name);
      const dst = join("dist", "templates", name);
      const walk = (rel: string): void => {
        const from = join(src, rel);
        for (const ent of readdirSync(from)) {
          if (shouldSkip(ent)) continue;
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
