import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineConfig } from "rolldown";

/**
 * Bundle the scaffolder entry; copy the runnable example trees from
 * `../../examples/{minimal-cloudflare,minimal-node,helpdesk-cloudflare}/`
 * into `dist/templates/{minimal-cloudflare,minimal-node,helpdesk-cloudflare}/`
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
 *   - `uint8array-base64.d.ts` — in-repo-only shim. Already excluded
 *     at scaffold time via the manifest; excluding here too keeps
 *     `dist/templates/` clean.
 *
 * Includes `.baerly/scaffold.json` (the manifest the scaffolder reads
 * at runtime) — without it, dist mode breaks.
 */
const copyTemplates = () => ({
  name: "copy-templates",
  closeBundle() {
    const EXAMPLES: readonly string[] = [
      "minimal-cloudflare",
      "minimal-node",
      "helpdesk-cloudflare",
    ];
    const SKIP_NAMES = new Set(["node_modules", "uint8array-base64.d.ts"]);
    for (const name of EXAMPLES) {
      const src = join("..", "..", "examples", name);
      const dst = join("dist", "templates", name);
      const walk = (rel: string): void => {
        const from = join(src, rel);
        for (const ent of readdirSync(from)) {
          if (SKIP_NAMES.has(ent)) continue;
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
  external: ["citty", "picocolors", /^node:/],
  output: {
    file: "dist/index.js",
    format: "esm",
    sourcemap: true,
    banner: "#!/usr/bin/env node",
  },
  plugins: [copyTemplates()],
});
