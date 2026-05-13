/**
 * Extract distribution parameters from MovieLens 100K and GH Archive
 * WatchEvent slice. Writes
 * `bench/load-harness/presets/calibration.json` — the only artifact
 * checked into the repo.
 *
 * Reuses the `CalibrationParams` shape from ticket 51; if ticket 51
 * has not yet landed when this script runs, the shape is locked by
 * this file's literal output (ticket 51 then aligns).
 *
 * Algorithm:
 *
 *   1. ML 100K → per-user rating-count → tenant-size buckets.
 *      ML 100K → per-movie rating-count → record-popularity buckets.
 *   2. GH WatchEvent → per-actor event-count → tenant-traffic buckets.
 *      (Also a candidate tenant-size signal, but ML's smaller
 *      distribution is more representative of small-app tenant shapes.)
 *   3. GH WatchEvent → payload byte size per record → record-size buckets.
 *
 * Bucket fitting: percentile-based. For tenant-size / record-size,
 * the buckets are cumulative (70%, 90%, 99%, 100% of records fall
 * below the bucket's max). For tenant-traffic / record-popularity,
 * the buckets are top-fraction (top 1% / next 9% / rest 90%).
 */

import { writeFile, mkdir } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

import type { CalibrationParams } from "../bench/load-harness/generators/calibration.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ML_DATA = path.join(REPO_ROOT, "bench/fixtures/ml-100k/u.data");
const GH_DIR = path.join(REPO_ROOT, "bench/fixtures/gharchive");
const CAL_OUT = path.join(REPO_ROOT, "bench/load-harness/presets/calibration.json");

interface CalibrationFile {
  readonly _source: {
    readonly extractedAtIso: string;
    readonly movieLens: { readonly path: string; readonly ratingCount: number };
    readonly ghArchive: { readonly path: string; readonly eventCount: number };
  };
  readonly [preset: string]: CalibrationParams | unknown;
}

/**
 * Percentile-based cumulative buckets.
 * Returns { cumulativeFraction, maxValue } at each cumulative fraction.
 */
function fitCumulativeBuckets(
  values: number[],
  cumulativeFractions: readonly number[],
): Array<{ cumulativeFraction: number; maxValue: number }> {
  if (values.length === 0) return [];
  const sorted = [...values].toSorted((a, b) => a - b);
  return cumulativeFractions.map((f) => ({
    cumulativeFraction: f,
    // Clamp index to [0, len-1]; f=1.00 → last element.
    maxValue: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))]!,
  }));
}

/**
 * Top-fraction buckets: top X% of actors hold Y% of total mass.
 * topFractions must be cumulative [0.01, 0.10, 1.00] — each entry
 * is the cumulative top-fraction boundary.
 * Returns INCREMENTAL shares per bucket so they sum to ~1.0.
 */
function fitTopFractionBuckets(
  counts: number[],
  // Cumulative boundaries: [0.01, 0.10, 1.00] → top-1%, 1-10%, 10-100%.
  cumulativeBoundaries: readonly number[],
): Array<{ fraction: number; share: number }> {
  if (counts.length === 0) return [];
  const sorted = [...counts].toSorted((a, b) => b - a); // descending
  const total = sorted.reduce((acc, x) => acc + x, 0);
  if (total === 0) return cumulativeBoundaries.map((f) => ({ fraction: f, share: 0 }));

  const result: Array<{ fraction: number; share: number }> = [];
  let prevCumShare = 0;

  for (const boundary of cumulativeBoundaries) {
    const cutoff = Math.min(sorted.length, Math.max(1, Math.floor(sorted.length * boundary)));
    let cumSum = 0;
    for (let i = 0; i < cutoff; i++) {
      cumSum += sorted[i]!;
    }
    const cumShare = cumSum / total;
    const incrementalShare = Math.max(0, cumShare - prevCumShare);
    result.push({ fraction: boundary, share: incrementalShare });
    prevCumShare = cumShare;
  }
  return result;
}

async function readMovieLens(): Promise<{
  ratingsPerUser: number[];
  ratingsPerMovie: number[];
  totalRatings: number;
}> {
  if (!existsSync(ML_DATA)) {
    throw new Error(
      `[calibration] ML data missing at ${ML_DATA}. Run scripts/fetch-bench-fixtures.sh first.`,
    );
  }
  const perUser = new Map<string, number>();
  const perMovie = new Map<string, number>();
  let total = 0;
  // u.data format: <userId>\t<movieId>\t<rating>\t<ts>
  const rl = readline.createInterface({
    input: createReadStream(ML_DATA),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    const parts = line.split("\t");
    const u = parts[0];
    const m = parts[1];
    if (u === undefined || m === undefined) continue;
    perUser.set(u, (perUser.get(u) ?? 0) + 1);
    perMovie.set(m, (perMovie.get(m) ?? 0) + 1);
    total++;
  }
  return {
    ratingsPerUser: [...perUser.values()],
    ratingsPerMovie: [...perMovie.values()],
    totalRatings: total,
  };
}

async function readGhArchive(): Promise<{
  eventsPerActor: number[];
  payloadBytes: number[];
  totalEvents: number;
}> {
  if (!existsSync(GH_DIR)) {
    throw new Error(
      `[calibration] GH Archive dir missing at ${GH_DIR}. Run scripts/fetch-bench-fixtures.sh first.`,
    );
  }
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(GH_DIR);
  const jsonFile = entries.find((e) => e.endsWith(".json"));
  if (jsonFile === undefined) {
    throw new Error(
      `[calibration] No .json file under ${GH_DIR}. Run scripts/fetch-bench-fixtures.sh first.`,
    );
  }
  const fullPath = path.join(GH_DIR, jsonFile);
  const perActor = new Map<string, number>();
  const sizes: number[] = [];
  let total = 0;
  const rl = readline.createInterface({
    input: createReadStream(fullPath),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line) as { actor?: { login?: string }; type?: string };
      if (ev.type !== "WatchEvent") continue;
      const actor = ev.actor?.login ?? "unknown";
      perActor.set(actor, (perActor.get(actor) ?? 0) + 1);
      sizes.push(Buffer.byteLength(line, "utf8"));
      total++;
    } catch {
      continue;
    }
  }
  return {
    eventsPerActor: [...perActor.values()],
    payloadBytes: sizes,
    totalEvents: total,
  };
}

async function main(): Promise<void> {
  const ml = await readMovieLens();
  const gh = await readGhArchive();

  // --- tenantSize: cumulative buckets at [0.70, 0.90, 0.99, 1.00] ---
  // Derived from ML per-user rating count (small-app tenant shape).
  // Cap maxRecords at 100_000 to match preset shape.
  const tenantSize: CalibrationParams["tenantSize"] = fitCumulativeBuckets(
    ml.ratingsPerUser,
    [0.7, 0.9, 0.99, 1.0],
  ).map(({ cumulativeFraction, maxValue }) => ({
    cumulativeFraction,
    maxRecords: Math.max(1, Math.min(100_000, Math.round(maxValue))),
  }));

  // --- tenantTraffic: top-fraction buckets [0.01, 0.09, 0.90] ---
  // Derived from GH per-actor event count (top 1% / next 9% / rest 90%).
  // cumulativeBoundaries: [0.01, 0.10, 1.00] so we get the 1%, 1-10%, 10-100% slices.
  const rawTraffic = fitTopFractionBuckets(gh.eventsPerActor, [0.01, 0.1, 1.0]);
  const tenantTraffic: CalibrationParams["tenantTraffic"] = rawTraffic.map((b, i) => ({
    // Map cumulative boundaries back to incremental topFraction labels:
    // boundary 0.01 → label 0.01 (top 1%)
    // boundary 0.10 → label 0.09 (next 9%)
    // boundary 1.00 → label 0.90 (rest 90%)
    topFraction: i === 0 ? 0.01 : i === 1 ? 0.09 : 0.9,
    trafficShare: Math.round(b.share * 1000) / 1000,
  }));

  // --- recordPopularity: top-fraction buckets [0.10, 0.10, 0.80] ---
  // Derived from ML per-movie rating count.
  // cumulativeBoundaries: [0.10, 0.20, 1.00] → top 10%, 10-20%, 20-100%.
  const rawPopularity = fitTopFractionBuckets(ml.ratingsPerMovie, [0.1, 0.2, 1.0]);
  const recordPopularity: CalibrationParams["recordPopularity"] = rawPopularity.map((b, i) => ({
    topFraction: i === 0 ? 0.1 : i === 1 ? 0.1 : 0.8,
    readShare: Math.round(b.share * 1000) / 1000,
  }));

  // --- recordSize: cumulative buckets at [0.70, 0.95, 1.00] ---
  // Derived from GH per-event byte length.
  // Clamp to [500, 1_000_000] bytes.
  const recordSize: CalibrationParams["recordSize"] = fitCumulativeBuckets(
    gh.payloadBytes,
    [0.7, 0.95, 1.0],
  ).map(({ cumulativeFraction, maxValue }) => ({
    cumulativeFraction,
    maxBytes: Math.max(500, Math.min(1_000_000, Math.round(maxValue))),
  }));

  const calibration: CalibrationFile = {
    _source: {
      extractedAtIso: new Date().toISOString(),
      movieLens: { path: ML_DATA, ratingCount: ml.totalRatings },
      ghArchive: { path: GH_DIR, eventCount: gh.totalEvents },
    },
    "recent-first-crud": { tenantSize, tenantTraffic, recordPopularity, recordSize },
  };

  await mkdir(path.dirname(CAL_OUT), { recursive: true });
  await writeFile(CAL_OUT, JSON.stringify(calibration, null, 2) + "\n");

  console.log(`[calibration] Wrote ${CAL_OUT}`);
  console.log(
    `[calibration]   tenantSize maxRecords:       ${tenantSize.map((b) => b.maxRecords).join(", ")}`,
  );
  console.log(
    `[calibration]   tenantTraffic shares:         ${tenantTraffic.map((b) => b.trafficShare.toFixed(3)).join(", ")} (sum=${tenantTraffic.reduce((a, b) => a + b.trafficShare, 0).toFixed(3)})`,
  );
  console.log(
    `[calibration]   recordPopularity shares:      ${recordPopularity.map((b) => b.readShare.toFixed(3)).join(", ")} (sum=${recordPopularity.reduce((a, b) => a + b.readShare, 0).toFixed(3)})`,
  );
  console.log(
    `[calibration]   recordSize maxBytes:          ${recordSize.map((b) => b.maxBytes).join(", ")}`,
  );
  console.log(`[calibration]   ML ratings: ${ml.totalRatings}, GH events: ${gh.totalEvents}`);
}

await main();
