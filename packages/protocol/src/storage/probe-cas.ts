import { BaerlyError } from "../errors.ts";
import { uuid } from "../types.ts";
import type { Storage } from "./types.ts";

const isConflict = (error: unknown): boolean =>
  error instanceof BaerlyError && error.code === "Conflict";

/** One CAS sub-check's outcome. */
export interface CasProbeCheck {
  /** Stable identifier (`ifMatch-stale` / `ifNoneMatch-exists` / `ifNoneMatch-concurrent`). */
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
 * silently *ignores* these conditionals causes silent corruption — the
 * log-append commit relies on `If-None-Match:"*"` create-if-absent
 * being exactly-one-winner under concurrency (the winning create IS the
 * commit; two winners produce split-brain commit), and the compactor
 * CAS-advances `current.json` with `If-Match` under the no-lease
 * maintenance fold (a backend that returns 200 instead of rejecting a
 * stale `If-Match` causes lost-update corruption). This is the
 * fail-loud, deploy-time analogue of the conformance CAS block.
 *
 * Writes throwaway sentinels under `keyPrefix` and deletes them on
 * the way out (even on failure). Three checks, mirroring the conformance
 * suite:
 *   - `ifMatch-stale`: a PUT with a stale `ifMatch` must reject (Conflict).
 *   - `ifNoneMatch-exists`: a PUT with `ifNoneMatch:"*"` over an existing
 *     key must reject (Conflict).
 *   - `ifNoneMatch-concurrent`: at most one of N concurrent create-if-absent
 *     writes on a fresh key wins — the linearizability the writer's log-append
 *     commit already relies on (`writer.ts`).
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

    // ── Check 3: at most one of N concurrent ifNoneMatch:"*" creates wins. ──
    // The writer already depends on this today: log entries are PUT with
    // ifNoneMatch:"*", and a 412 means a peer won that seq (writer.ts). Two
    // winners ⇒ two writers believe they appended the same log seq. So
    // winners>1 is the only definitive non-linearizability signal; transient
    // non-Conflict losers (e.g. an S3 409 ConditionalRequestConflict, which the
    // adapter maps to a retryable NetworkError) are inconclusive — the writer
    // re-issues the same-seq PUT and resolves to 200/412 — not proof of a broken
    // backend.
    const raceKey = `${prefix}__baerly_cas_probe__/${uuid()}`;
    const RACERS = 16;
    try {
      const outcomes = await Promise.allSettled(
        Array.from({ length: RACERS }, (_unused, i) =>
          // Stryker disable next-line StringLiteral: body content irrelevant; only the conditional header + winner count is tested
          storage.put(raceKey, enc.encode(`r${i}`), { ifNoneMatch: "*", signal }),
        ),
      );
      const winners = outcomes.filter((o) => o.status === "fulfilled").length;
      const transient = outcomes.filter(
        (o) => o.status === "rejected" && !isConflict(o.reason),
      ).length;
      if (winners > 1) {
        checks.push({
          name: "ifNoneMatch-concurrent",
          ok: false,
          detail: `${winners} of ${RACERS} concurrent create-if-absent writes won (expected at most 1) — create-if-absent is NOT linearizable; the log-append commit would split-brain.`,
        });
      } else if (winners === 1) {
        checks.push({
          name: "ifNoneMatch-concurrent",
          ok: true,
          detail:
            transient === 0
              ? `exactly one of ${RACERS} concurrent create-if-absent writes won; the rest rejected (Conflict), as required.`
              : `exactly one of ${RACERS} concurrent create-if-absent writes won (invariant held); ${transient} loser(s) returned a transient non-Conflict error — inconclusive for those, not a linearizability failure.`,
        });
      } else {
        checks.push({
          name: "ifNoneMatch-concurrent",
          ok: false,
          detail: `no create-if-absent write succeeded across ${RACERS} attempts — inconclusive (transient failure or outage), not a linearizability verdict; retry.`,
        });
      }
    } finally {
      try {
        await storage.delete(raceKey, signal === undefined ? undefined : { signal });
      } catch {
        /* ignore */
      }
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
