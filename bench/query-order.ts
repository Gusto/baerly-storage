/**
 * Bounded top-k gate for `order(...).limit(k)` reads.
 *
 * Times `orderRows` (`packages/server/src/query-eval.ts`), the read
 * path's order + limit step, against the full stable sort it replaces,
 * `sortByOrderSpec(rows, spec).slice(0, k)`, on the same rows. The two
 * are interleaved sample by sample and each cell reports the median
 * µs/op. Every cell first checks that both return the same rows in the
 * same order.
 *
 * Gate: on monotone input (rows already in key order, read asc or desc,
 * which covers `order({ createdAt: "desc" }).limit(20)` over uuidv7-ordered
 * rows) at n = 2048 and 65,536, `orderRows` must not be slower than the
 * full sort by more than `TOLERANCE`. V8's sort is run-adaptive and close
 * to O(n) there, so this is where a top-k can lose. The nearly-sorted
 * and random cells are reported but not gated.
 *
 * Run: `pnpm bench:query-order` (Node). Exits 1 on a gate failure.
 * No infra. MEASURES ONLY.
 */

import { QUERY_TOP_K_MAX } from "@baerly/protocol";
import { orderRows, sortByOrderSpec } from "../packages/server/src/query-eval.ts";

type Doc = { _id: string; createdAt: string; n: number };
type Rows = Array<{ docId: string; doc: Doc }>;
type Spec = { createdAt?: "asc" | "desc"; n?: "asc" | "desc" };

/** Allowed slowdown of `orderRows` on a gated cell (median vs median). */
const TOLERANCE = 0.1;
const TARGET_MS = 40;
const SAMPLES = 11;

const median = (xs: number[]): number => xs.toSorted((a, b) => a - b)[xs.length >> 1]!;

/** Median µs/op of each variant over interleaved, calibrated batches. */
const time = (variants: Record<string, () => unknown>): Record<string, number> => {
  const iters: Record<string, number> = {};
  for (const [name, fn] of Object.entries(variants)) {
    let it = 1;
    for (;;) {
      const t0 = performance.now();
      for (let i = 0; i < it; i++) {
        fn();
      }
      const dt = performance.now() - t0;
      if (dt >= TARGET_MS) {
        break;
      }
      it = dt < 1 ? it * 8 : Math.ceil((it * TARGET_MS * 1.2) / dt);
    }
    iters[name] = it;
  }
  const samples: Record<string, number[]> = {};
  for (let s = 0; s < SAMPLES; s++) {
    for (const [name, fn] of Object.entries(variants)) {
      const it = iters[name]!;
      const t0 = performance.now();
      for (let i = 0; i < it; i++) {
        fn();
      }
      (samples[name] ??= []).push(((performance.now() - t0) * 1000) / it);
    }
  }
  return Object.fromEntries(Object.entries(samples).map(([name, xs]) => [name, median(xs)]));
};

/** Deterministic PRNG (mulberry32). */
const rng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const at = (i: number): string => `2026-11-18T${String(i).padStart(9, "0")}`;

const fixtures = (n: number): { sorted: Rows; nearly: Rows; random: Rows } => {
  const r = rng(0xef6 + n);
  // uuidv7-style ids are time-ordered, so map order is `createdAt` order.
  const sorted: Rows = Array.from({ length: n }, (_, i) => ({
    docId: `d${i}`,
    doc: { _id: `d${i}`, createdAt: at(i), n: i % 1000 },
  }));
  const nearly = [...sorted];
  for (let s = 0; s < n / 100; s++) {
    const i = Math.floor(r() * (n - 1));
    [nearly[i], nearly[i + 1]] = [nearly[i + 1]!, nearly[i]!];
  }
  const random: Rows = sorted.map(({ docId }) => ({
    docId,
    doc: { _id: docId, createdAt: at(Math.floor(r() * n)), n: Math.floor(r() * 1000) },
  }));
  return { sorted, nearly, random };
};

const ids = (rows: Rows): string => rows.map((row) => row.docId).join(",");

let failed = false;
const cell = (label: string, rows: Rows, spec: Spec, k: number, gated: boolean): void => {
  const want = ids(sortByOrderSpec(rows, spec).slice(0, k));
  if (ids(orderRows(rows, spec, k)) !== want) {
    console.log(`FAIL equality ${label}`);
    failed = true;
    return;
  }
  const { fullSort, topK } = time({
    fullSort: () => sortByOrderSpec(rows, spec).slice(0, k),
    topK: () => orderRows(rows, spec, k),
  });
  const delta = (topK! - fullSort!) / fullSort!;
  let verdict = "info";
  if (gated) {
    verdict = delta <= TOLERANCE ? "pass" : "FAIL";
  }
  if (verdict === "FAIL") {
    failed = true;
  }
  console.log(
    `${verdict.padEnd(4)} ${label.padEnd(44)} full sort ${fullSort!.toFixed(1).padStart(8)} µs  top-k ${topK!.toFixed(1).padStart(8)} µs  ${(delta * 100).toFixed(1).padStart(6)}%`,
  );
};

for (const n of [2048, 65_536]) {
  const { sorted, nearly, random } = fixtures(n);
  for (const k of [20, QUERY_TOP_K_MAX]) {
    cell(`n=${n} k=${k} monotone, desc (latest N)`, sorted, { createdAt: "desc" }, k, true);
    cell(`n=${n} k=${k} monotone, asc`, sorted, { createdAt: "asc" }, k, true);
    cell(`n=${n} k=${k} nearly sorted, desc`, nearly, { createdAt: "desc" }, k, false);
    cell(`n=${n} k=${k} nearly sorted, asc`, nearly, { createdAt: "asc" }, k, false);
    cell(`n=${n} k=${k} random, desc`, random, { createdAt: "desc" }, k, false);
    cell(
      `n=${n} k=${k} random, n asc + createdAt desc`,
      random,
      { n: "asc", createdAt: "desc" },
      k,
      false,
    );
  }
}
if (failed) {
  console.log("query-order gate FAILED");
  process.exit(1);
}
