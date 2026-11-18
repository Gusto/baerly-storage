// Shared configuration + helpers for the third-party-licenses manifest.
//
// WHY: rolldown INLINES third-party libraries into the published `dist/`.
// MIT/ISC/BSD/Apache all require their copyright + permission notice to
// travel with any copy of the code; bundling is a copy, so the notices
// must ship. This module is the single source of truth for (a) the
// permissive-license allowlist that gates the build and (b) the partial
// JSON filenames the two rolldown invocations write, which a post-build
// step merges into `dist/THIRD-PARTY-LICENSES.txt`.
//
// The manifest is regenerated on every `pnpm build` by `rollup-license-plugin`
// (codepunkt) — it is never hand-maintained. See
// docs/contributing/publishing.md.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..");
export const DIST_DIR = resolve(REPO_ROOT, "dist");

/**
 * Final, human-readable notices file. Auto-ships via the root package's
 * `files: ["dist"]`, matching the `dist/API.md` + `dist/CHANGELOG.md`
 * pattern emitted by `rolldown.config.ts`'s `copyApiQuickref` step.
 */
export const NOTICES_FILENAME = "THIRD-PARTY-LICENSES.txt";

/**
 * Per-build partial JSON manifests. The root library build and the CLI
 * bin build each bundle a different subset of third-party code, so each
 * writes its own partial; the merge step unions + dedupes them. These are
 * intermediates — the merge step deletes them so they never ship.
 */
export const PARTIAL_LIB_FILENAME = ".third-party-licenses.lib.json";
export const PARTIAL_CLI_FILENAME = ".third-party-licenses.cli.json";

/**
 * Permissive licenses we accept in the published bundle. A bundled dep
 * carrying anything outside this set (notably any copyleft license —
 * GPL/AGPL/LGPL/MPL) fails the build via the plugin's
 * `unacceptableLicenseTest`. SPDX identifiers.
 */
export const ALLOWED_LICENSES = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
]);

/**
 * `true` when a license identifier is NOT on the permissive allowlist and
 * the build should fail. Handles SPDX expressions: an expression is
 * acceptable iff at least one top-level `OR` alternative has ALL of its
 * `AND`-joined terms in the allowlist. `OR` is disjunction (any alternative
 * suffices); `AND` is conjunction (every term must pass), so e.g.
 * `(MIT OR Apache-2.0)` is accepted but `(MIT AND GPL-3.0)` is rejected.
 * Parens and `WITH` exception clauses are stripped before splitting.
 */
export function isUnacceptableLicense(licenseIdentifier) {
  if (!licenseIdentifier) {
    return true;
  }
  const normalized = licenseIdentifier.replace(/[()]/g, " ").replace(/\s+WITH\s+\S+/gi, " ");
  const alternatives = normalized
    .split(/\s+OR\s+/i)
    .map((alt) =>
      alt
        .split(/\s+AND\s+/i)
        .map((term) => term.trim())
        .filter(Boolean),
    )
    .filter((terms) => terms.length > 0);
  if (alternatives.length === 0) {
    return true;
  }
  const acceptable = alternatives.some((terms) =>
    terms.every((term) => ALLOWED_LICENSES.has(term)),
  );
  return !acceptable;
}

/**
 * Render the human-readable notices file for `packageName` from
 * `rollup-license-plugin` package records: deduped by `name@version`,
 * sorted, each with its verbatim license text.
 */
export function renderNotices(packageName, records) {
  const byKey = new Map();
  for (const pkg of records) {
    byKey.set(`${pkg.name}@${pkg.version}`, pkg);
  }
  const packages = [...byKey.values()].toSorted((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
  );
  const SEP = `${"=".repeat(78)}\n`;
  const header = [
    "THIRD-PARTY SOFTWARE LICENSES",
    "",
    `The ${packageName} published package bundles (inlines) the`,
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
  return `${header}\n${SEP}${blocks.join(`\n${SEP}`)}\n`;
}

/**
 * Shared `rollup-license-plugin` options. `outputFilename` is the only
 * per-build difference, so callers pass it in.
 */
export function licensePluginOptions(outputFilename) {
  return {
    outputFilename,
    unacceptableLicenseTest: isUnacceptableLicense,
  };
}
