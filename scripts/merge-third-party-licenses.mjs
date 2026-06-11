#!/usr/bin/env node
// Merge the per-build partial license manifests into the final,
// human-readable `dist/THIRD-PARTY-LICENSES.txt`.
//
// The root library build (`rolldown.config.ts`) and the CLI bin build
// (`packages/cli/rolldown.config.ts`) each emit a partial JSON manifest
// via `rollup-license-plugin` covering only the third-party packages
// THAT build bundled. This step unions + dedupes them by `name@version`,
// sorts, and renders the verbatim license text for each, then deletes the
// partials so they never ship.
//
// Runs as the final step of `pnpm build`. The per-license allowlist gate
// already ran inside each rolldown invocation (the plugin's
// `unacceptableLicenseTest`); this step re-checks as a belt-and-suspenders
// guard in case a partial was produced out of band.
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  DIST_DIR,
  NOTICES_FILENAME,
  PARTIAL_LIB_FILENAME,
  PARTIAL_CLI_FILENAME,
  isUnacceptableLicense,
} from "./third-party-licenses.mjs";

// COUPLING: every rolldown build that bundles third-party code MUST emit a
// partial here. A new bundling build's deps will be silently omitted from
// the (legally-required) notices manifest until its partial is added below.
const PARTIALS = [PARTIAL_LIB_FILENAME, PARTIAL_CLI_FILENAME].map((f) => resolve(DIST_DIR, f));

function readPartial(path) {
  if (!existsSync(path)) {
    throw new Error(
      `Expected partial license manifest at ${path}. ` +
        `Run \`pnpm build\` so both rolldown invocations emit their partials before merging.`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

const byKey = new Map();
for (const path of PARTIALS) {
  for (const pkg of readPartial(path)) {
    byKey.set(`${pkg.name}@${pkg.version}`, pkg);
  }
}

const packages = [...byKey.values()].toSorted((a, b) =>
  a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
);

const offenders = packages.filter((p) => isUnacceptableLicense(p.license));
if (offenders.length > 0) {
  const list = offenders.map((p) => `  - ${p.name}@${p.version}: ${p.license}`).join("\n");
  console.error(`Non-permissive license(s) found in the bundle:\n${list}`);
  process.exit(1);
}

const SEP = `${"=".repeat(78)}\n`;
const header = [
  "THIRD-PARTY SOFTWARE LICENSES",
  "",
  "The @gusto/baerly-storage published package bundles (inlines) the",
  "third-party libraries listed below into its `dist/` output. Their",
  "licenses require their copyright and permission notices to travel with",
  "any copy of their code. The verbatim notices follow.",
  "",
  "This file is generated at build time from each dependency's own LICENSE",
  "file and is not hand-maintained.",
  "",
].join("\n");

const blocks = packages.map((p) => {
  const meta = [`${p.name}@${p.version}`, `License: ${p.license}`];
  if (p.repository) {
    meta.push(`Repository: ${p.repository}`);
  }
  const text = (p.licenseText || "").trim() || "(no license text found in package)";
  return `${meta.join("\n")}\n\n${text}\n`;
});

const body = `${header}\n${SEP}${blocks.join(`\n${SEP}`)}`;
const outPath = resolve(DIST_DIR, NOTICES_FILENAME);
writeFileSync(outPath, `${body}\n`);

// Remove the intermediates so they don't ship in the tarball.
for (const path of PARTIALS) {
  rmSync(path, { force: true });
}

console.log(
  `Wrote ${NOTICES_FILENAME} (${packages.length} third-party package${packages.length === 1 ? "" : "s"}).`,
);
