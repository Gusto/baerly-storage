/**
 * S1 probe: at which call count does each subrequest-like operation fail on
 * Workers Free? One request runs one probe (so each probe starts with a full
 * budget) as PROBE_CALLS sequential calls and records the first failure:
 *
 *   - `r2-head`:     `env.BUCKET.head` on a missing key (needs the optional
 *                    synthetic R2 binding; skipped when absent);
 *   - `fetch`:       control, `fetch()` of a neutral public URL;
 *   - `cache-match`: `caches.default.match` of an absent request.
 *
 * No request carries data: the R2 key and the URLs are constants. Nothing is
 * written anywhere.
 */
import { PROBE_CALLS, type ProbeKind } from "./cells.ts";

export interface ProbeEnv {
  readonly BUCKET?: R2Bucket;
}

export interface ProbeResult {
  readonly probe: ProbeKind;
  readonly attempted: number;
  readonly completed: number;
  /** 1-based index of the first failing call, or null when all succeeded. */
  readonly failedAt: number | null;
  readonly error: { readonly name: string; readonly message: string } | null;
  /** Set instead of running when the probe's prerequisite is missing. */
  readonly skipped?: string;
}

/** The neutral public URL the `fetch` control and the cache probe use. */
export const PROBE_URL = "https://example.com/";
export const PROBE_MISSING_KEY = "cpu-factor-probe/missing-key";

const call = async (probe: ProbeKind, env: ProbeEnv, i: number): Promise<void> => {
  switch (probe) {
    case "r2-head": {
      await env.BUCKET!.head(PROBE_MISSING_KEY);
      return;
    }
    case "fetch": {
      const res = await fetch(PROBE_URL, { method: "HEAD" });
      await res.body?.cancel();
      return;
    }
    case "cache-match": {
      // `caches.default` is Workers-only; DOM's `CacheStorage` lib type lacks it.
      const cache = (caches as unknown as { default: Cache }).default;
      await cache.match(new Request(`${PROBE_URL}cpu-factor-probe/${i}`));
      return;
    }
  }
};

export const runProbe = async (
  probe: ProbeKind,
  env: ProbeEnv | undefined,
  calls: number = PROBE_CALLS,
): Promise<ProbeResult> => {
  if (probe === "r2-head" && env?.BUCKET === undefined) {
    return {
      probe,
      attempted: 0,
      completed: 0,
      failedAt: null,
      error: null,
      skipped: "no BUCKET binding",
    };
  }
  for (let i = 1; i <= calls; i++) {
    try {
      await call(probe, env ?? {}, i);
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      return {
        probe,
        attempted: i,
        completed: i - 1,
        failedAt: i,
        error: { name: e.name, message: e.message.slice(0, 300) },
      };
    }
  }
  return { probe, attempted: calls, completed: calls, failedAt: null, error: null };
};
