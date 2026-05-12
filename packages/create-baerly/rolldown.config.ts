import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineConfig } from "rolldown";

/**
 * Bundle the scaffolder entry; copy the literal `templates/` tree
 * verbatim into `dist/templates/` so the bundled binary can find
 * its templates at runtime.
 */
const copyTemplates = () => ({
  name: "copy-templates",
  closeBundle() {
    const src = "templates";
    const dst = "dist/templates";
    const walk = (rel: string): void => {
      const from = join(src, rel);
      const to = join(dst, rel);
      for (const ent of readdirSync(from)) {
        const fromEnt = join(from, ent);
        const toEnt = join(to, ent);
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
