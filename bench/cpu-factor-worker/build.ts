// Build the bench Worker from the CURRENT tree.
//   pnpm bench:cpu-factor:build
// Steps: build synthetic fixtures under Node with the tree's own code, then
// bundle the Worker (src/worker.ts + fixtures) into dist/worker.js. Also
// writes out/cells.txt for the request driver. Nothing built here is
// committed (dist/ and out/ are gitignored).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { CELLS, FIXTURES, SUBJECT_FIXTURES } from "./src/cells.ts";
import { buildFixture, type Fixture } from "./src/common.ts";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
const dist = join(here, "dist");
mkdirSync(out, { recursive: true });
mkdirSync(dist, { recursive: true });

const fixtures: Record<string, Fixture> = {};
const summary: string[] = [];
for (const [name, spec] of Object.entries({ ...FIXTURES, ...SUBJECT_FIXTURES })) {
  const fx = await buildFixture(spec);
  fixtures[name] = fx;
  summary.push(`${name}: rows=${fx.rows} bytes=${fx.bytes}`);
}
writeFileSync(join(out, "fixtures.json"), JSON.stringify(fixtures));
writeFileSync(join(out, "fixtures-summary.txt"), `${summary.join("\n")}\n`);
// `name<TAB>samples`; an empty samples column means the driver's default N.
writeFileSync(
  join(out, "cells.txt"),
  `${CELLS.map((c) => `${c.name}\t${c.samples ?? ""}`).join("\n")}\n`,
);

await build({
  entryPoints: [join(here, "src/worker.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2023",
  mainFields: ["module", "main"],
  conditions: ["workerd", "worker", "import"],
  external: ["node:*"],
  outfile: join(dist, "worker.js"),
  logLevel: "warning",
  plugins: [
    {
      name: "cpu-factor-fixtures",
      setup(b) {
        b.onResolve({ filter: /^cpu-factor:fixtures$/ }, () => ({
          path: join(out, "fixtures.json"),
        }));
      },
    },
  ],
});
const raw = readFileSync(join(dist, "worker.js"));
console.log(summary.join("\n"));
console.log(`dist/worker.js: ${raw.byteLength} B raw, ${gzipSync(raw).byteLength} B gzip`);
