/**
 * `baerly doctor --bucket <uri>` — live backend CAS probe.
 *
 * Unlike the cloudflare deploy-invariant walk (which only inspects
 * config files), this mode connects to a real bucket and verifies it
 * honours the conditional writes the protocol depends on: every commit
 * CAS-advances `current.json` with `If-Match`, and the no-lease
 * maintenance fold relies on the same fence. A store that silently
 * ignores `If-Match` (returns 200 instead of rejecting a stale write)
 * causes silent lost-update corruption — this is the fail-loud,
 * deploy-time analogue of the conformance CAS block.
 *
 * Writes a single throwaway sentinel and deletes it; see
 * {@link probeCas}.
 */

import { probeCas, type Storage } from "@baerly/protocol";
import type { DoctorFinding, DoctorReport } from "./cloudflare.ts";

const CAS_FIX =
  "Point baerly at an S3-compatible store that honours conditional writes " +
  "(If-Match + If-None-Match). Real AWS S3, Cloudflare R2, and GCS do; a " +
  "custom gateway / proxy may be stripping conditional headers — check it " +
  "returns 412 on a stale If-Match.";

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
