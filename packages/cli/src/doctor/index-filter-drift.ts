/**
 * `baerly doctor --check=index-filter-drift` — scan every filtered
 * index declared in `baerly.config.ts:collections[*].indexes[*]` for
 * pre-existing keys whose docs no longer match the current
 * `def.predicate`. Powered by `rebuildIndex(..., { dryRun: true })`.
 *
 * Drift is `(added > 0)` (docs that NOW match the filter but have no
 * key on storage) or `(removed > 0)` (orphan keys for docs that no
 * longer match). Either condition warrants a `warning` finding with
 * the remediation command pinned.
 *
 * Requires storage credentials in env: `BUCKET`, `AWS_ACCESS_KEY_ID`,
 * `AWS_SECRET_ACCESS_KEY` (optionally `S3_ENDPOINT` + `AWS_REGION`).
 * Missing env yields a single `index-filter-drift.env` error finding
 * and short-circuits the scan. Mirrors the env-var contract the Node
 * doctor's `--usage` path already uses.
 *
 * Read-only by default. Pass `opts.rebuild === true` to call
 * `rebuildIndex` with `dryRun: false` instead — the dispatcher wires
 * that to `--rebuild-drift`. A successful auto-rebuild emits an
 * `info` finding ("rebuilt — added N, removed M, kept K") rather than
 * a warning so the report no longer flags drift the operator just
 * fixed.
 *
 * When `--rebuild-drift` is set, the rebuild fires BEFORE the
 * backend's invariant checks (wrangler.jsonc shape, Dockerfile
 * presence, etc.). Operators who aren't sure whether their config is
 * healthy should run `--check=index-filter-drift` alone first to see
 * the read-only delta.
 *
 * @see ../../config.ts — `loadAppConfigWithCollections` provides the
 *      `LoadedCollection[]` this function consumes.
 * @see ../../../server/src/rebuild-index.ts — the `dryRun` option
 *      this check rides on.
 */

import { minioStorage, r2Storage, s3Storage } from "@baerly/adapter-node";
import type { Storage } from "@baerly/protocol";
import { rebuildIndex, type IndexDefinition } from "@baerly/server";
import type { AppConfig, LoadedCollection } from "../config.ts";
import type { DoctorFinding } from "./cloudflare.ts";

/**
 * Build the canonical `current.json` key for one collection.
 * Inlined rather than imported from `@baerly/server`'s
 * `physicalPrefixFor` (which is private to the package); the shape
 * `app/<app>/tenant/<tenant>/manifests/<collection>/current.json`
 * is pinned by `Db.create` and by `baerly admin rebuild-index` and
 * must not drift.
 */
const currentJsonKeyFor = (app: string, tenant: string, collection: string): string =>
  `app/${app}/tenant/${tenant}/manifests/${collection}/current.json`;

/**
 * Construct a `Storage` against env-supplied credentials using the
 * `s3Storage` / `r2Storage` / `minioStorage` factories from
 * `@baerly/adapter-node`. Returns `null` and pushes a single
 * `index-filter-drift.env` error finding when any required var is
 * missing — the dispatcher maps that to an exit-2 doctor report.
 *
 * Endpoint-pattern dispatch matches `baerly copy` (see
 * `../copy.ts:parseBucketUri`): an explicit `S3_ENDPOINT` flows
 * through `minioStorage` (full endpoint), R2-shaped hosts pick
 * `r2Storage`, else `s3Storage` derives the AWS endpoint from
 * `AWS_REGION`.
 *
 * Mirrors the Node `--usage` path's storage-builder contract (see
 * `./usage.ts` / `./node.ts:runUsageCheck`); we don't share the
 * helper because the doctor backends already wire env-var probing
 * directly, and the drift check is dispatcher-level rather than
 * backend-level.
 */
const buildStorage = (findings: DoctorFinding[]): Storage | null => {
  const missing: string[] = [];
  for (const k of ["BUCKET", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
    const v = process.env[k];
    if (v === undefined || v === "") missing.push(k);
  }
  if (missing.length > 0) {
    findings.push({
      severity: "error",
      check: "index-filter-drift.env",
      message: `--check=index-filter-drift needs ${missing.join(", ")} on the environment; skipped drift scan.`,
      fix: "Source .env or set the vars inline: `BUCKET=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... baerly doctor --check=index-filter-drift` (optionally with S3_ENDPOINT + AWS_REGION).",
    });
    return null;
  }
  const region = process.env["AWS_REGION"] ?? "us-east-1";
  const bucket = process.env["BUCKET"]!;
  const accessKeyId = process.env["AWS_ACCESS_KEY_ID"]!;
  const secretAccessKey = process.env["AWS_SECRET_ACCESS_KEY"]!;
  const endpoint = process.env["S3_ENDPOINT"];
  if (endpoint !== undefined && endpoint !== "") {
    const r2Host = endpoint.match(/^https?:\/\/([^./]+)\.r2\.cloudflarestorage\.com\b/i);
    if (r2Host !== null) {
      return r2Storage({ accountId: r2Host[1]!, bucket, accessKeyId, secretAccessKey });
    }
    return minioStorage({ endpoint, bucket, accessKeyId, secretAccessKey });
  }
  return s3Storage({ region, bucket, accessKeyId, secretAccessKey });
};

/**
 * Run the drift check across every filtered index declared in the
 * config. Returns the accumulated `DoctorFinding[]` — the dispatcher
 * splices these into the backend's findings list before rollup.
 *
 * Emitted finding shapes:
 *
 *   - `index-filter-drift` (info) — when there are no collections to
 *     scan, or none declare a filtered index. The check is a no-op
 *     in either case; we surface the reason so the operator can see
 *     why it didn't fire.
 *   - `index-filter-drift.env` (error) — when required env vars are
 *     missing. Short-circuits the scan.
 *   - `index-filter-drift.<collection>.<index>` (ok / warning /
 *     info / error) — one finding per scanned filtered index. `ok`
 *     when the index is in sync; `warning` when drift is detected
 *     and `opts.rebuild` is false; `info` when drift was found AND
 *     auto-rebuilt; `error` when the rebuild call itself threw.
 */
export const checkIndexFilterDrift = async (
  config: AppConfig,
  collections: readonly LoadedCollection[] | undefined,
  opts: { readonly rebuild?: boolean } = {},
): Promise<DoctorFinding[]> => {
  const findings: DoctorFinding[] = [];

  if (collections === undefined || collections.length === 0) {
    findings.push({
      severity: "info",
      check: "index-filter-drift",
      message: "No collections declared in baerly.config — skipping index-filter-drift check.",
    });
    return findings;
  }

  const filtered: Array<{ collection: string; def: IndexDefinition }> = [];
  for (const c of collections) {
    for (const def of c.indexes) {
      if (def.predicate !== undefined) {
        filtered.push({ collection: c.name, def });
      }
    }
  }
  if (filtered.length === 0) {
    findings.push({
      severity: "info",
      check: "index-filter-drift",
      message: "No filtered indexes declared — nothing to check.",
    });
    return findings;
  }

  const storage = buildStorage(findings);
  if (storage === null) return findings;

  for (const { collection, def } of filtered) {
    const checkName = `index-filter-drift.${collection}.${def.name}`;
    const currentJsonKey = currentJsonKeyFor(config.app, config.tenant, collection);
    let result;
    try {
      result = await rebuildIndex(storage, currentJsonKey, def, {
        dryRun: opts.rebuild !== true,
      });
    } catch (e) {
      findings.push({
        severity: "error",
        check: checkName,
        message: `${collection}.${def.name}: drift check failed: ${(e as Error).message}`,
      });
      continue;
    }
    const drifted = result.added > 0 || result.removed > 0;
    if (!drifted) {
      findings.push({
        severity: "ok",
        check: checkName,
        message: `${collection}.${def.name}: in sync (${result.kept} keys).`,
      });
      continue;
    }
    if (opts.rebuild === true) {
      findings.push({
        severity: "info",
        check: checkName,
        message: `${collection}.${def.name}: rebuilt — added ${result.added}, removed ${result.removed}, kept ${result.kept}.`,
      });
      continue;
    }
    findings.push({
      severity: "warning",
      check: checkName,
      message: `${collection}.${def.name}: drift detected — ${result.added} missing, ${result.removed} orphaned (${result.kept} in sync).`,
      fix: `pnpm exec baerly admin rebuild-index --bucket=<bucket-uri> --table=${collection} --index=${def.name} --config=<path-to-compiled-baerly.config> (or re-run baerly doctor with --rebuild-drift to auto-fix).`,
    });
  }
  return findings;
};
