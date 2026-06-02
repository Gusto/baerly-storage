import { BaerlyError } from "../errors.ts";
import { uuid } from "../types.ts";
import type { Storage } from "./types.ts";

const isConflict = (error: unknown): boolean =>
  error instanceof BaerlyError && error.code === "Conflict";

/** One CAS sub-check's outcome. */
export interface CasProbeCheck {
  /** Stable identifier (`ifMatch-stale` / `ifNoneMatch-exists`). */
  readonly name: string;
  /** `true` iff the backend rejected the conditional write as required. */
  readonly ok: boolean;
  /** Human-readable detail — what was expected vs. observed. */
  readonly detail: string;
}

/** Aggregate result of {@link probeCas}. `ok` iff every sub-check passed. */
export interface CasProbeResult {
  readonly ok: boolean;
  readonly checks: readonly CasProbeCheck[];
}

/**
 * Runtime probe that a live `Storage` backend honours the conditional
 * writes the protocol depends on. The storage conformance suite asserts
 * the same semantics in CI for every shipped adapter, but a deployment
 * may point baerly at an arbitrary S3-compatible store; a backend that
 * silently *ignores* `If-Match` (returns 200 instead of rejecting a
 * stale write) causes silent lost-update corruption — every commit
 * CAS-advances `current.json`, and the no-lease maintenance fold relies
 * on the same fence. This is the fail-loud, deploy-time analogue of the
 * conformance CAS block.
 *
 * Writes a single throwaway sentinel under `keyPrefix` and deletes it on
 * the way out (even on failure). Two checks, mirroring the conformance
 * suite:
 *   - `ifMatch-stale`: a PUT with a stale `ifMatch` must reject (Conflict).
 *   - `ifNoneMatch-exists`: a PUT with `ifNoneMatch:"*"` over an existing
 *     key must reject (Conflict).
 *
 * A rejected write surfaces as a `BaerlyError` with `code === "Conflict"`
 * (the contract `Storage.put` documents); anything else — a resolved
 * promise, or a non-Conflict error — means the backend does not honour
 * the condition and is reported as a failed check rather than thrown.
 */
export const probeCas = async (
  storage: Storage,
  opts?: { keyPrefix?: string; signal?: AbortSignal },
): Promise<CasProbeResult> => {
  const prefix = opts?.keyPrefix ?? "";
  const key = `${prefix}__baerly_cas_probe__/${uuid()}`;
  const enc = new TextEncoder();
  const signal = opts?.signal;

  const checks: CasProbeCheck[] = [];
  try {
    const first = await storage.put(key, enc.encode("v1"), { signal });

    // ── Check 1: a stale ifMatch must be rejected. ──────────────────
    try {
      // Stryker disable next-line StringLiteral: body content is irrelevant to CAS probe; only the conditional header is tested
      await storage.put(key, enc.encode("v2"), { ifMatch: '"baerly-cas-probe-stale"', signal });
      checks.push({
        name: "ifMatch-stale",
        ok: false,
        detail:
          "PUT with a stale If-Match was ACCEPTED — backend ignores If-Match (silent lost-update risk).",
      });
    } catch (error) {
      checks.push(
        isConflict(error)
          ? {
              name: "ifMatch-stale",
              ok: true,
              detail: "stale If-Match rejected (Conflict), as required.",
            }
          : {
              name: "ifMatch-stale",
              ok: false,
              detail: `stale If-Match raised a non-Conflict error: ${error instanceof Error ? error.message : String(error)}`,
            },
      );
    }

    // ── Check 2: ifNoneMatch:"*" over an existing key must reject. ──
    try {
      // Stryker disable next-line StringLiteral: body content is irrelevant to CAS probe; only the conditional header is tested
      await storage.put(key, enc.encode("v3"), { ifNoneMatch: "*", signal });
      checks.push({
        name: "ifNoneMatch-exists",
        ok: false,
        detail:
          'PUT with If-None-Match:"*" over an existing key was ACCEPTED — backend ignores If-None-Match (create-only writes unsafe).',
      });
    } catch (error) {
      checks.push(
        isConflict(error)
          ? {
              name: "ifNoneMatch-exists",
              ok: true,
              detail: 'If-None-Match:"*" over an existing key rejected (Conflict), as required.',
            }
          : {
              name: "ifNoneMatch-exists",
              ok: false,
              detail: `If-None-Match:"*" raised a non-Conflict error: ${error instanceof Error ? error.message : String(error)}`,
            },
      );
    }

    void first;
  } finally {
    // Best-effort cleanup — never let a delete failure mask the verdict.
    try {
      await storage.delete(key, signal === undefined ? undefined : { signal });
    } catch {
      /* ignore */
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
};
