/**
 * `baerly doctor --bucket=gcs://<bucket>` — GCS-specific bucket-config
 * checks that go beyond the backend-agnostic CAS probe ({@link doctorCas}
 * in `./cas.ts`).
 *
 * Two findings, always both present:
 *   1. **Object Versioning** — an ACTIVE probe. Readable over the HMAC/XML
 *      API via `GET <bucket>?versioning`, so we fetch it and warn only
 *      when versioning is actually enabled (baerly's log is already an
 *      append-only history; bucket versioning duplicates it at storage
 *      cost). Never throws — a diagnostic must not crash on a transient
 *      network error; an inconclusive probe degrades to an `info` finding.
 *   2. **Soft-delete** — a STATIC advisory, never an active probe. GCS
 *      soft-delete is exposed only via the JSON API
 *      (`storage/v1/b/<bucket>?fields=softDeletePolicy`), and the JSON API
 *      rejects HMAC auth outright (401, demands OAuth2 Bearer). baerly's
 *      native GCS adapter is HMAC-only by design, so there is no code path
 *      to read it — this is an auth-model wall, not a TODO.
 */

import { gcsVersioningStatus } from "@baerly/adapter-node";
import { type DoctorFinding, type DoctorReport, rollupStatus } from "./cloudflare.ts";

/**
 * A well-formed-but-stale GCS object `generation` for `doctor.ts`'s
 * `--bucket=gcs://` branch to feed into `doctorCas`'s `staleEtag`
 * override. GCS generations are large monotonic int64 timestamps, so no
 * live object will ever carry generation `"1"` — a mismatch here is
 * guaranteed, and (unlike the CAS probe's default quoted-string
 * sentinel) it is syntactically valid for `x-goog-if-generation-match`,
 * so GCS answers with 412 (Conflict) rather than 400 (malformed
 * precondition). Mirrors the conformance suite's GCS `staleEtag`
 * override in `packages/protocol/src/storage/conformance.ts`.
 */
export const GCS_STALE_GENERATION_PROBE_VALUE = "1";

const versioningEnabledFix = (bucket: string): string =>
  "baerly's log is already an append-only history, so bucket versioning duplicates it at storage cost. " +
  "Disable it unless you need object-level version recovery: " +
  `\`gcloud storage buckets update gs://${bucket} --no-versioning\` (or add a lifecycle rule to expire noncurrent versions).`;

const SOFT_DELETE_FIX =
  "Check it and, unless you want trash-style recovery, turn it off: " +
  "`gcloud storage buckets describe gs://<bucket> --format='default(softDeletePolicy)'` then " +
  "`gcloud storage buckets update gs://<bucket> --clear-soft-delete`.";

/**
 * Inconclusive Object-Versioning probe result — a non-2xx response or a
 * thrown fetch error. `reason` is the branch-specific cause
 * (`HTTP <status>` or the caught error's message). Both branches degrade
 * to the same `info` finding, so the shape lives here once.
 */
const versioningInconclusive = (bucket: string, reason: string): DoctorFinding => ({
  severity: "info",
  check: "gcs-object-versioning",
  message: `Could not read Object Versioning config (${reason}). Verify manually: \`gcloud storage buckets describe gs://${bucket} --format='default(versioning)'\`.`,
});

const probeVersioning = async (opts: {
  endpoint: string;
  bucket: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  fetchImpl: typeof fetch;
}): Promise<DoctorFinding> => {
  const { endpoint, bucket, credentials, fetchImpl } = opts;
  // Wire mechanics (URL shape, `?versioning`, XML parse, GOOG4 signing)
  // live in the adapter; this module only maps the status to a finding.
  const status = await gcsVersioningStatus({ endpoint, bucket, credentials, fetch: fetchImpl });
  if (status.kind === "inconclusive") {
    return versioningInconclusive(bucket, status.reason);
  }
  if (status.kind === "enabled") {
    return {
      severity: "warning",
      check: "gcs-object-versioning",
      message:
        `Object Versioning is enabled on "${bucket}". baerly overwrites and deletes objects during ` +
        "normal writes, compaction, and GC; with versioning on, every superseded or deleted object is " +
        "retained as a billed noncurrent version.",
      fix: versioningEnabledFix(bucket),
    };
  }
  return {
    severity: "ok",
    check: "gcs-object-versioning",
    message: "Object Versioning is disabled — superseded and deleted objects are not retained.",
  };
};

const softDeleteFinding = (): DoctorFinding => ({
  severity: "info",
  check: "gcs-soft-delete",
  message:
    "GCS enables soft-delete on new buckets by default (deleted objects retained ~7 days and billed). " +
    "baerly's GC deletions then linger as billed soft-deleted objects. Soft-delete isn't readable over " +
    "the HMAC/XML API, so this is a reminder, not a live measurement.",
  fix: SOFT_DELETE_FIX,
});

/**
 * Walk the GCS-specific bucket-config checks: an active Object Versioning
 * probe plus a static soft-delete advisory. Never throws — every finding
 * degrades gracefully on a network failure instead of aborting the
 * surrounding `baerly doctor --bucket` walk.
 */
export const doctorGcsConfig = async (opts: {
  endpoint: string;
  bucket: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}): Promise<DoctorReport> => {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const findings: DoctorFinding[] = [
    await probeVersioning({
      endpoint: opts.endpoint,
      bucket: opts.bucket,
      credentials: opts.credentials,
      fetchImpl,
    }),
    softDeleteFinding(),
  ];
  return { findings, status: rollupStatus(findings) };
};
