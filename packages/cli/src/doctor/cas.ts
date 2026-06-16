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
  "Point baerly at an S3-compatible store that honours conditional writes " +
  "(If-Match + If-None-Match). AWS S3 and Cloudflare R2 honour them. Some " +
  "S3-compatible endpoints don't enforce them on writes — notably GCS's " +
  "interop endpoint, which documents these headers as read-only — and a " +
  "custom gateway / proxy may strip them; this probe exists to catch " +
  "exactly that. A conformant backend returns 412 on a stale If-Match.";

/**
 * Run the live CAS round-trip against `storage` and shape the result
 * as a {@link DoctorReport}. Status is `error` iff any sub-check failed
 * (a non-conformant backend is a hard blocker, not a warning).
 */
export const doctorCas = async (storage: Storage, keyPrefix: string): Promise<DoctorReport> => {
  const result = await probeCas(storage, { keyPrefix });
  const findings: DoctorFinding[] = result.checks.map((c) => ({
    severity: c.ok ? "ok" : "error",
    check: `cas-${c.name}`,
    message: c.detail,
    ...(c.ok ? {} : { fix: CAS_FIX }),
  }));
  return { findings, status: result.ok ? "ok" : "error" };
};
