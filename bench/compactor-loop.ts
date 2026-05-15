/**
 * Compactor-vs-writer race driver. Calls
 * `runScheduledMaintenance` on a configurable cadence until the
 * abort signal fires. Returns counters about how many compactor +
 * GC passes ran and how many CAS-lost on `current.json`.
 *
 * The cadence (1 second by default) is fast relative to production
 * (which runs the maintenance at ~1/min on Cloudflare Cron and
 * however the Node operator schedules it). The 1/sec cadence is
 * the methodology's stress test: it maximises the probability of
 * a writer-vs-compactor race in the bench window.
 */

import {
  NODE_PROFILE,
  runScheduledMaintenance,
  type MaintenanceResult,
} from "@baerly/server/maintenance";
import type { Storage } from "@baerly/protocol";

export interface CompactorLoopCounters {
  passes: number;
  compactsLanded: number;
  compactsCasLost: number;
  gcSwept: number;
  errors: number;
}

export async function runCompactorLoop(
  storage: Storage,
  currentJsonKey: string,
  cadenceMs: number,
  signal: AbortSignal,
): Promise<CompactorLoopCounters> {
  const counters: CompactorLoopCounters = {
    passes: 0,
    compactsLanded: 0,
    compactsCasLost: 0,
    gcSwept: 0,
    errors: 0,
  };
  while (!signal.aborted) {
    let result: MaintenanceResult;
    try {
      result = await runScheduledMaintenance({ storage, currentJsonKey }, NODE_PROFILE);
      counters.passes++;
      if (result.compact?.written === true) counters.compactsLanded++;
      if (result.compact?.skippedReason === "cas-lost") counters.compactsCasLost++;
      counters.gcSwept += result.gc?.swept ?? 0;
    } catch (e) {
      counters.errors++;
      // Don't surface — methodology counts errors and continues. A
      // throw here would terminate the bench prematurely; the writer
      // loop runs to its own deadline regardless.
      void e;
    }
    if (signal.aborted) break;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, cadenceMs);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    }).catch(() => void 0);
  }
  return counters;
}
