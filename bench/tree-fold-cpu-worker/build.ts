// Bundle the bench Worker from the CURRENT tree into dist/worker.js.
//   pnpm bench:tree-fold-cpu:build
// dist/ is gitignored; wrangler deploys it with `no_bundle`.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const outfile = join(here, "dist", "worker.js");
await build({
  entryPoints: [join(here, "src/worker.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2023",
  mainFields: ["module", "main"],
  conditions: ["workerd", "worker", "import"],
  external: ["node:*"],
  outfile,
  logLevel: "warning",
});
const raw = readFileSync(outfile);
console.log(`dist/worker.js: ${raw.byteLength} B raw, ${gzipSync(raw).byteLength} B gzip`);
