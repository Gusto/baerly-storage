/**
 * `baerly doctor --bucket <uri>` — live backend CAS probe.
 *
 * Unlike the cloudflare deploy-invariant walk (which only inspects
 * config files), this mode connects to a real bucket and verifies it
 * honours the conditional writes the protocol depends on: the
 * log-append commit relies on `If-None-Match:"*"` create-if-absent
 * being exactly-one-winner under concurrency (the winning create IS the
 * commit), and the compactor CAS-advances `current.json` with `If-Match`
 * under the no-lease maintenance fold. A store that silently ignores
 * these conditionals causes silent corruption (split-brain commit, or
 * lost updates on a stale `If-Match`) — this is the fail-loud,
 * deploy-time analogue of the conformance CAS block.
 *
 * Writes throwaway sentinels and deletes them; see
 * {@link probeCas}.
 */

import { probeCas, type Storage } from "@baerly/protocol";
import type { DoctorFinding, DoctorReport } from "./cloudflare.ts";

const CAS_FIX =
  "Point baerly at a store that honours conditional writes (If-Match + " +
  "If-None-Match). AWS S3 and Cloudflare R2 honour them natively; for " +
  "Google Cloud Storage use the native gcs:// path (baerly's GcsHttpStorage " +
  "drives x-goog-if-generation-match) — GCS's S3-interop endpoint documents " +
  "these headers as read-only and is not supported. A custom gateway or " +
  "proxy may also strip them; this probe exists to catch exactly that. A " +
  "conformant backend returns 412 on a stale If-Match.";

/**
 * Run the live CAS round-trip against `storage` and shape the result
 * as a {@link DoctorReport}. Status is `error` iff any sub-check failed
 * (a non-conformant backend is a hard blocker, not a warning).
 *
 * `opts.staleEtag` overrides `probeCas`'s default S3/R2-shaped stale-etag
 * sentinel — required on the native GCS path, whose generation-based
 * preconditions reject a quoted-string value as malformed (400) rather
 * than as a conflict (412). See `doctor.ts`'s `--bucket=gcs://` branch.
 */
export const doctorCas = async (
  storage: Storage,
  keyPrefix: string,
  opts?: { staleEtag?: string },
): Promise<DoctorReport> => {
  const result = await probeCas(storage, {
    keyPrefix,
    ...(opts?.staleEtag !== undefined && { staleEtag: opts.staleEtag }),
  });
  const findings: DoctorFinding[] = result.checks.map((c) => ({
    severity: c.ok ? "ok" : "error",
    check: `cas-${c.name}`,
    message: c.detail,
    ...(c.ok ? {} : { fix: CAS_FIX }),
  }));
  return { findings, status: result.ok ? "ok" : "error" };
};
