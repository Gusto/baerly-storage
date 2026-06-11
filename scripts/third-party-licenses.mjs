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
 * the build should fail. Handles simple SPDX disjunctions
 * (`(MIT OR Apache-2.0)`) by accepting if ANY clause is allowed.
 */
export function isUnacceptableLicense(licenseIdentifier) {
  if (!licenseIdentifier) {return true;}
  const clauses = licenseIdentifier
    .replace(/[()]/g, " ")
    .split(/\s+(?:OR|AND)\s+/i)
    .map((c) => c.trim())
    .filter(Boolean);
  if (clauses.length === 0) {return true;}
  return !clauses.some((c) => ALLOWED_LICENSES.has(c));
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
