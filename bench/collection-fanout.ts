/* eslint-disable no-console -- bench script prints results */
/**
 * Collection fan-out cost on MemoryStorage. Seeds N collections under one
 * tenant prefix, then measures via a counting Storage proxy:
 * discoverCollections list cost, per-collection fixed object overhead, and
 * full `admin usage` scan op-count. MEASURES ONLY — no infra.
 *
 * ## Seed depth
 * Each collection is seeded with LOG_DEPTH log entries (currently 5). This
 * must be ≥ 2 so that `estimateWritesPerMin` exits its early-return branch
 * and actually calls `readCommitTsBatched`, which is where the per-collection
 * GETs happen. With fewer than 2 entries the function returns immediately with
 * NaN and zero GETs, making usageScanGets=0 and the measured cost unrealistically
 * low. True worst-case per-collection scan cost is SAMPLE_SIZE GETs/collection
 * (imported from packages/cli/src/admin/usage.ts); LOG_DEPTH=5 exercises the
 * GET path while keeping the bench fast.
 *
 * ## Real-storage enumeration
 * MemoryStorage returns all keys in a single list page (no 1000-key pagination
 * limit). The `realStorageDiscoverPages` field corrects for this: on real R2/S3,
 * discovery lists = ceil(totalControlObjects / 1000) where
 * totalControlObjects = objectsPerCollection × N. This field lets the docs avoid
 * grounding the per-tenant fan-out limit on a MemoryStorage-only number.
 *
 * ## Re-derived collections/tenant guideline
 * The `admin usage` full sweep is an operator-CLI sweep — even ONE active
 * collection's scan (1 LIST + up to SAMPLE_SIZE GETs) exceeds a single
 * CF-free 50-subrequest request. The "1 LIST" assumes the log fits one
 * 1000-key list page; a deep/uncompacted log paginates (ceil(logKeys/1000)
 * pages) on real R2/S3. Its cost is operator latency/$$, growing
 * LINEARLY with N. There is no sharp protocol cliff near ~100; the limit is
 * a SOFT, linear-cost guideline ("erosion, not a cliff"). The ~100 figure is
 * the documented soft fan-out budget: past it, operator sweeps get
 * proportionally slower/costlier, but nothing in the protocol enforces it.
 *
 * Enumeration (`discoverCollections`) is cheap on real R2/S3 for thousands
 * of collections: ceil(objects×N/1000) LIST pages. With objectsPerCollection=6
 * and N=1000 that is only 6 LIST pages.
 *
 * FOLLOW-UP: add an `admin usage` warning when N > 100 that the scan will
 * take proportionally longer.
 *
 * @see docs/about/graduation.md — ~100 collections/tenant fan-out guideline.
 * @see docs/about/workload-fit.md — workload envelope.
 */
import { writeFile } from "node:fs/promises";
import { createCurrentJson, MemoryStorage } from "@baerly/protocol";
import { wrapCountingStorage } from "../tests/fixtures/counting-storage.ts";
import { discoverCollections, runUsageScan, SAMPLE_SIZE } from "../packages/cli/src/admin/usage.ts";

const APP = "fanout";
const TENANT = "t0";
const Ns = [10, 100, 500, 1000];

/**
 * Number of log entries to seed per collection. Must be >= 2 so that
 * `estimateWritesPerMin` exits the `sample.length < 2` early-return and
 * calls `readCommitTsBatched` (the GET path). True worst-case is
 * SAMPLE_SIZE GETs/collection; LOG_DEPTH=5 exercises the GET path while
 * keeping the bench runtime under a few seconds at N=1000.
 */
const LOG_DEPTH = 5;

/**
 * Fixed ISO-8601 timestamp used for all seeded log entries.
 * Using a fixed literal keeps the bench deterministic across runs.
 * `estimateWritesPerMin` reads `commit_ts` from the log entry body;
 * the exact value doesn't affect op-count measurements.
 */
const FIXED_COMMIT_TS = "2026-01-01T00:00:00.000Z";

/**
 * A minimal but valid LogEntry body with a parseable commit_ts.
 * `readCommitTsMs` in usage.ts requires `typeof parsed.commit_ts === "string"`
 * and `Date.parse(parsed.commit_ts)` to be finite.
 */
const makeLogEntryBody = (seq: number): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify({
      lsn: `00000000_bench_${String(seq).padStart(4, "0")}`,
      commit_ts: FIXED_COMMIT_TS,
      op: "I",
      collection: "c",
      session: "bench",
      seq,
      doc_id: `doc-${seq}`,
    }),
  );

async function seed(storage: MemoryStorage, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const key = `app/${APP}/tenant/${TENANT}/manifests/c${i}/current.json`;
    await createCurrentJson(storage, key, {
      schema_version: 3,
      snapshot: null,
      tail_hint: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "bench", claimed_at: "" },
      snapshot_bytes: 0,
      snapshot_rows: 0,
    });
    // Seed LOG_DEPTH log entries so estimateWritesPerMin exits the
    // `sample.length < 2` early-return and actually calls readCommitTsBatched.
    for (let seq = 0; seq < LOG_DEPTH; seq++) {
      await storage.put(
        `app/${APP}/tenant/${TENANT}/manifests/c${i}/log/${seq}.json`,
        makeLogEntryBody(seq),
      );
    }
  }
}

async function measure(n: number) {
  const inner = new MemoryStorage();
  await seed(inner, n);
  const counting = wrapCountingStorage(inner);
  counting.reset();
  const names = await discoverCollections(counting.storage, APP, TENANT);
  const discoverLists = counting.lists;
  counting.reset();
  const findings: { severity: string }[] = [];
  await runUsageScan({ app: APP, tenant: TENANT }, counting.storage, findings as never);
  // 1 current.json + LOG_DEPTH log entries per collection
  const objectsPerCollection = 1 + LOG_DEPTH;
  const totalControlObjects = objectsPerCollection * n;
  // Real R2/S3 paginates at 1000 keys/page; MemoryStorage returns everything
  // in one page. This field shows what discovery would cost on real storage.
  const realStorageDiscoverPages = Math.ceil(totalControlObjects / 1000);
  return {
    collections: n,
    discovered: names.length,
    objectsPerCollection,
    discoverLists,
    realStorageDiscoverPages,
    usageScanLists: counting.lists,
    usageScanGets: counting.gets,
    usageScanOps: counting.lists + counting.gets,
  };
}

async function main() {
  const rows = [];
  console.log(`worst-case usage-scan cost = N × (1 LIST + ${SAMPLE_SIZE} GETs/collection)`);
  for (const n of Ns) {
    const r = await measure(n);
    rows.push(r);
    console.log(
      `N=${r.collections} | objsPerColl=${r.objectsPerCollection} | discoverLists=${r.discoverLists} | realDiscoverPages=${r.realStorageDiscoverPages} | usageScanLists=${r.usageScanLists} | usageScanGets=${r.usageScanGets} | usageScanOps=${r.usageScanOps}`,
    );
  }
  await writeFile(
    "docs/spec/attachments/collection-fanout-baseline.json",
    JSON.stringify({ bench: "collection-fanout", rows }, null, 2) + "\n",
  );
  console.log("wrote docs/spec/attachments/collection-fanout-baseline.json");
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
