/**
 * Four distribution parameters per preset. Empirically extracted
 * from a real corpus by `scripts/fetch-bench-fixtures.sh` and
 * persisted to `bench/load-harness/presets/calibration.json`
 * (checked into the repo — see ticket 52). If the calibration file
 * is missing or doesn't have an entry for a preset, the harness
 * falls back to the literal defaults declared in each preset's
 * source file.
 */
export interface CalibrationParams {
  /** Tenant-size buckets: each (cumulative-fraction, max-records). */
  readonly tenantSize: ReadonlyArray<{ cumulativeFraction: number; maxRecords: number }>;
  /** Tenant-traffic buckets: each (top-fraction, traffic-share). */
  readonly tenantTraffic: ReadonlyArray<{ topFraction: number; trafficShare: number }>;
  /** Record-popularity buckets (within a tenant). */
  readonly recordPopularity: ReadonlyArray<{ topFraction: number; readShare: number }>;
  /** Record-size buckets: each (cumulative-fraction, max-bytes). */
  readonly recordSize: ReadonlyArray<{ cumulativeFraction: number; maxBytes: number }>;
}

export type Calibration = Readonly<Record<string, CalibrationParams>>;

export async function loadCalibration(): Promise<Calibration> {
  try {
    const url = new URL("../presets/calibration.json", import.meta.url);
    const txt = await import("node:fs/promises").then((m) => m.readFile(url, "utf8"));
    return JSON.parse(txt) as Calibration;
  } catch {
    return {}; // fallback: each preset has inline defaults
  }
}
