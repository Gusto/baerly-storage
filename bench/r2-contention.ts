/**
 * R2 contention bench harness — main entrypoint.
 *
 * Three scenarios:
 *   - **S1**: concurrent CAS storm — N writers race on one
 *     `current.json` for a configurable wall-clock window.
 *   - **S2-idle**: idle reader bound — M pollers issue
 *     `readCurrentJson` every 2 seconds with zero writers; the
 *     canonical idle-reader cost-model gate (< 1 Class A op / writer /
 *     hour) is validated against the wire.
 *   - **S3-toxic**: same as S1 but with Toxiproxy toxics
 *     (`wan-50ms` or `loss-5`) installed first.
 *
 * Invoke via `pnpm bench:r2 --scenario=… --concurrency=… …`. Writes
 * one JSON file per run to `bench/results/`; prints a one-line
 * summary to stdout for at-a-glance sweep output. Exit code is `0`
 * when the cost-model bound holds (or doesn't apply), `1` when it's
 * violated, and throws (non-zero from Node) on infrastructure error.
 */

import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  casUpdateCurrentJson,
  createCurrentJson,
  encodeJsonBytes,
  readCurrentJson,
  BaerlyError,
  type CurrentJson,
} from "@baerly/protocol";
import { buildBenchStorage, ensureBucket, type CountingStorage } from "./storage.ts";
import { runCompactorLoop, type CompactorLoopCounters } from "./compactor-loop.ts";
import { Metrics } from "./metrics.ts";
import { clearToxics, installToxics, isToxiproxyReady } from "./toxiproxy.ts";
import type { Network, RetryPolicy, RunResult, Scenario, SweepCell } from "./types.ts";

const CURRENT_KEY = "bench/tenant-A/collection-K/current.json";
const BUCKET = "baerly-bench";
const MINIO_HEALTH_URL = "http://127.0.0.1:9102/minio/health/ready";
const SIGKILL_LOG_PREFIX = "bench/tenant-A/collection-sigkill";
const SIGKILL_CURRENT_KEY = `${SIGKILL_LOG_PREFIX}/current.json`;
const S5_LOG_PREFIX = "bench/tenant-A/collection-compact";
const S5_CURRENT_KEY = `${S5_LOG_PREFIX}/current.json`;
const S5_TARGET_OPS_PER_SEC = 50;
const SEED: CurrentJson = {
  schema_version: 1,
  snapshot: null,
  next_seq: 0,
  log_seq_start: 0,
  writer_fence: { epoch: 0, owner: "bench", claimed_at: "" },
};

const BASE_MS = 50;
const CAP_MS = 5000;
const MAX_RETRIES = 10;

/**
 * Compute the per-collection `current.json` key for the `S2-multi`
 * scenario. The shape matches the protocol's `<tenant>/<collection>/current.json`
 * default (per `packages/protocol/src/coordination/current-json.ts:43–45`);
 * we nest under `bench/tenant-A/` so the keyspace is bench-owned
 * and won't collide with `S1` / `S2-idle` / `S3-toxic` (which use
 * `bench/tenant-A/collection-K/current.json`).
 */
function multiCollectionKey(idx: number): string {
  // Zero-pad to 6 digits — enough for M=1_000_000 without changing
  // lex-order. (M=1000 is the documented stress regime.)
  return `bench/tenant-A/multi/collection-${idx.toString().padStart(6, "0")}/current.json`;
}

function viaFor(network: Network): "direct" | "toxiproxy" {
  return network === "direct" ? "direct" : "toxiproxy";
}

function jitter(policy: RetryPolicy, attempt: number, prevSleepMs: number): number {
  switch (policy) {
    case "no-jitter": {
      return Math.min(CAP_MS, BASE_MS * 2 ** attempt);
    }
    case "full-jitter": {
      return Math.random() * Math.min(CAP_MS, BASE_MS * 2 ** attempt);
    }
    case "decorrelated": {
      return Math.min(CAP_MS, Math.random() * (3 * prevSleepMs - BASE_MS) + BASE_MS);
    }
  }
}

async function preflight(network: Network): Promise<void> {
  // Minio readiness. Anything other than 200 means `pnpm dev:storage`
  // hasn't been run (or hasn't finished); bail with a clear message.
  let res: Response;
  try {
    res = await fetch(MINIO_HEALTH_URL);
  } catch (error) {
    throw new Error(
      `bench: Minio not reachable at ${MINIO_HEALTH_URL} (${(error as Error).message}). ` +
        `Did you run 'pnpm dev:storage'?`,
      { cause: error },
    );
  }
  if (res.status !== 200) {
    throw new Error(
      `bench: Minio health check returned ${res.status}. Did you run 'pnpm dev:storage'?`,
    );
  }
  // Toxiproxy is only required for non-direct scenarios.
  if (network !== "direct") {
    if (!(await isToxiproxyReady())) {
      throw new Error(
        `bench: Toxiproxy proxy not ready at ${`http://127.0.0.1:8474/proxies/minio`}. ` +
          `Did you run 'pnpm dev:storage'? The 'toxiproxy-config-0' one-shot may still be starting.`,
      );
    }
  }
}

async function seedCurrentJson(storage: CountingStorage): Promise<void> {
  try {
    await createCurrentJson(storage, CURRENT_KEY, SEED);
  } catch (error: unknown) {
    if (error instanceof BaerlyError && error.code === "Conflict") {
      return;
    } // already there
    throw error;
  }
}

async function s1Writer(
  storage: CountingStorage,
  metrics: Metrics,
  retryPolicy: RetryPolicy,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const t0 = performance.now();
    let attempts = 0;
    let prevSleep = BASE_MS;
    while (attempts < MAX_RETRIES && !signal.aborted) {
      try {
        await casUpdateCurrentJson(storage, CURRENT_KEY, (cur) => ({
          ...cur,
          next_seq: cur.next_seq + 1,
        }));
        metrics.recordCommit(performance.now() - t0, attempts);
        break;
      } catch (error: unknown) {
        if (error instanceof BaerlyError && error.code === "Conflict") {
          metrics.recordConflict412();
          const sleepMs = jitter(retryPolicy, attempts, prevSleep);
          prevSleep = sleepMs;
          await new Promise((r) => setTimeout(r, sleepMs));
          attempts++;
          continue;
        }
        if (error instanceof BaerlyError && error.code === "NetworkError") {
          metrics.recordRateLimit429();
          const sleepMs = jitter(retryPolicy, attempts, prevSleep);
          prevSleep = sleepMs;
          await new Promise((r) => setTimeout(r, sleepMs));
          attempts++;
          continue;
        }
        throw error;
      }
    }
  }
}

async function runS1(cell: SweepCell): Promise<RunResult> {
  const via = viaFor(cell.network);
  const storage = buildBenchStorage({ via, bucket: BUCKET });
  await ensureBucket({ via, bucket: BUCKET });
  await seedCurrentJson(storage);
  // Reset counters; only the contention loop counts.
  storage.classAOps = 0;
  storage.classBOps = 0;
  const metrics = new Metrics();
  const controller = new AbortController();
  const started = new Date();
  const t0 = performance.now();
  const writers = Array.from({ length: cell.concurrency }, () =>
    s1Writer(storage, metrics, cell.retryPolicy, controller.signal),
  );
  const stop = setTimeout(() => controller.abort(), cell.durationMs);
  try {
    await Promise.all(writers);
  } finally {
    clearTimeout(stop);
  }
  const wallclockMs = performance.now() - t0;
  const snap = metrics.snapshot();
  const perWriterPerHour = (storage.classAOps / cell.concurrency) * (3_600_000 / wallclockMs);
  return {
    cell,
    started_iso: started.toISOString(),
    wallclock_ms: wallclockMs,
    effective_throughput_per_sec: snap.commit_count / (wallclockMs / 1000),
    cas_412_rate: snap.conflict_412_count / Math.max(1, snap.commit_count),
    rate_limit_429_rate:
      snap.rate_limit_429_count / Math.max(1, snap.commit_count + snap.rate_limit_429_count),
    class_a_op_count: storage.classAOps,
    class_b_op_count: storage.classBOps,
    class_a_per_writer_per_hour: perWriterPerHour,
    latency_p50_ms: snap.latency_p50_ms,
    latency_p99_ms: snap.latency_p99_ms,
    latency_p999_ms: snap.latency_p999_ms,
    retry_tail_max: snap.retry_tail_max,
    // S1 is the contention scenario; the cost-model bound is meant
    // for IDLE readers, not active writers. The flag is recorded
    // here for completeness but only enforced in S2-idle.
    cost_model_bound_holds: true,
  };
}

async function runS2Idle(cell: SweepCell): Promise<RunResult> {
  const via = viaFor(cell.network);
  const storage = buildBenchStorage({ via, bucket: BUCKET });
  await ensureBucket({ via, bucket: BUCKET });
  await seedCurrentJson(storage);
  // Reset the counter; we want only the polling phase counted.
  storage.classAOps = 0;
  storage.classBOps = 0;
  const controller = new AbortController();
  const started = new Date();
  const t0 = performance.now();
  const pollers = Array.from({ length: cell.pollerCount }, async () => {
    while (!controller.signal.aborted) {
      await readCurrentJson(storage, CURRENT_KEY);
      await new Promise((r) => setTimeout(r, 2000));
    }
  });
  const stop = setTimeout(() => controller.abort(), cell.durationMs);
  try {
    await Promise.all(pollers);
  } finally {
    clearTimeout(stop);
  }
  const wallclockMs = performance.now() - t0;
  const perPollerPerHour = (storage.classAOps / cell.pollerCount) * (3_600_000 / wallclockMs);
  return {
    cell,
    started_iso: started.toISOString(),
    wallclock_ms: wallclockMs,
    effective_throughput_per_sec: 0,
    cas_412_rate: 0,
    rate_limit_429_rate: 0,
    class_a_op_count: storage.classAOps,
    class_b_op_count: storage.classBOps,
    class_a_per_writer_per_hour: perPollerPerHour,
    latency_p50_ms: 0,
    latency_p99_ms: 0,
    latency_p999_ms: 0,
    retry_tail_max: 0,
    // The validated bound. `tests/integration/phase5-end-to-end.test.ts`
    // asserts the in-process counter is exactly 0; on the wire we
    // tolerate < 1 to absorb adapter implementation drift (e.g. a
    // future LIST-based optimisation that pre-fetches the snapshot
    // index, amortised over many reads). If this ever flips to
    // `false`, page the operator — a Class A leak crept into the
    // read path.
    cost_model_bound_holds: perPollerPerHour < 1,
    ...(perPollerPerHour >= 1 && {
      notes: `cost-model violation: ${perPollerPerHour.toFixed(3)} Class A / poller / hour`,
    }),
  };
}

async function runS2Multi(cell: SweepCell): Promise<RunResult> {
  const via = viaFor(cell.network);
  const storage = buildBenchStorage({ via, bucket: BUCKET });
  await ensureBucket({ via, bucket: BUCKET });

  // Seed M current.json keys. Idempotent (Conflict tolerated).
  for (let i = 0; i < cell.collections; i++) {
    const key = multiCollectionKey(i);
    try {
      await createCurrentJson(storage, key, SEED);
    } catch (error: unknown) {
      if (error instanceof BaerlyError && error.code === "Conflict") {
        continue;
      }
      throw error;
    }
  }
  // Reset counters; only the rotation loop counts.
  storage.classAOps = 0;
  storage.classBOps = 0;

  const metrics = new Metrics();
  const controller = new AbortController();
  const started = new Date();
  const t0 = performance.now();
  let collectionIdx = 0;
  const writerLoop = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      const key = multiCollectionKey(collectionIdx);
      collectionIdx = (collectionIdx + 1) % cell.collections;
      const tCommit = performance.now();
      let attempts = 0;
      let prevSleep = BASE_MS;
      while (attempts < MAX_RETRIES && !controller.signal.aborted) {
        try {
          await casUpdateCurrentJson(storage, key, (cur) => ({
            ...cur,
            next_seq: cur.next_seq + 1,
          }));
          metrics.recordCommit(performance.now() - tCommit, attempts);
          break;
        } catch (error: unknown) {
          if (error instanceof BaerlyError && error.code === "Conflict") {
            // Should be ~impossible (single writer per key) but
            // count the same way so the metric is comparable.
            metrics.recordConflict412();
            const sleepMs = jitter(cell.retryPolicy, attempts, prevSleep);
            prevSleep = sleepMs;
            await new Promise((r) => setTimeout(r, sleepMs));
            attempts++;
            continue;
          }
          if (error instanceof BaerlyError && error.code === "NetworkError") {
            metrics.recordRateLimit429();
            const sleepMs = jitter(cell.retryPolicy, attempts, prevSleep);
            prevSleep = sleepMs;
            await new Promise((r) => setTimeout(r, sleepMs));
            attempts++;
            continue;
          }
          throw error;
        }
      }
    }
  };

  const stop = setTimeout(() => controller.abort(), cell.durationMs);
  try {
    await writerLoop();
  } finally {
    clearTimeout(stop);
  }
  const wallclockMs = performance.now() - t0;
  const snap = metrics.snapshot();
  // For S2-multi there's only ONE writer, so per-writer-per-hour is
  // the same as total-per-hour. We retain the field name for run-JSON
  // shape consistency with `S1`.
  const perWriterPerHour = storage.classAOps * (3_600_000 / wallclockMs);

  // 429 onset is the load-bearing signal. If non-zero, the operator
  // sees it via `notes` (and ticket 64's interpreter applies a
  // threshold). 412s on this scenario are pathology.
  const notes: string | undefined =
    snap.rate_limit_429_count > 0
      ? `429 onset at M=${cell.collections}: ${snap.rate_limit_429_count} over ${snap.commit_count} commits`
      : undefined;

  return {
    cell,
    started_iso: started.toISOString(),
    wallclock_ms: wallclockMs,
    effective_throughput_per_sec: snap.commit_count / (wallclockMs / 1000),
    cas_412_rate: snap.conflict_412_count / Math.max(1, snap.commit_count),
    rate_limit_429_rate:
      snap.rate_limit_429_count / Math.max(1, snap.commit_count + snap.rate_limit_429_count),
    class_a_op_count: storage.classAOps,
    class_b_op_count: storage.classBOps,
    class_a_per_writer_per_hour: perWriterPerHour,
    latency_p50_ms: snap.latency_p50_ms,
    latency_p99_ms: snap.latency_p99_ms,
    latency_p999_ms: snap.latency_p999_ms,
    retry_tail_max: snap.retry_tail_max,
    // S2-multi is NOT an idle-reader scenario; the cost-model bound
    // doesn't apply. Same convention as `runS1`: set true so the
    // exit-code logic ignores it.
    cost_model_bound_holds: true,
    ...(notes !== undefined && { notes }),
  };
}

interface TrialResult {
  readonly trial_index: number;
  readonly killed_after_step: 1 | 2;
  readonly orphan_content_count: number;
  readonly orphan_log_count: number;
  readonly child_completed: boolean; // true iff child exited 0 before SIGKILL fired
}

async function s3SigkillTrial(cell: SweepCell, trialIndex: number): Promise<TrialResult> {
  const via = viaFor(cell.network);
  // Use a unique seq per trial so log/<seq>.json doesn't collide.
  const seq = 10_000 + trialIndex;
  const body = JSON.stringify({ trial: trialIndex, payload: `data-${trialIndex}` });
  const child = spawn(
    "node",
    ["--import", "./bench/register-hooks.mjs", "bench/sigkill-child.ts"],
    {
      env: {
        ...process.env,
        BENCH_VIA: via,
        BENCH_BUCKET: BUCKET,
        BENCH_TRIAL_SEQ: String(seq),
        BENCH_TRIAL_BODY: body,
        BENCH_KILL_AFTER_STEP: String(cell.killAfterStep),
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );

  let stepsSeen = 0;
  let killed = false;
  let childCompleted = false;

  const onReady = (line: string): void => {
    if (line === `READY-${cell.killAfterStep}` && !killed) {
      killed = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Child may have exited already; ignore.
      }
    }
    if (line === "READY-3") {
      childCompleted = true;
    }
  };

  let buf = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      stepsSeen++;
      onReady(line);
    }
  });

  await new Promise<void>((resolve) => child.on("exit", () => resolve()));

  // Enumerate orphans now that the bucket has quiesced.
  const storage = buildBenchStorage({ via, bucket: BUCKET });
  let orphanContent = 0;
  let orphanLog = 0;
  for await (const e of storage.list(`${SIGKILL_LOG_PREFIX}/content/`)) {
    void e; // We just count.
    orphanContent++;
  }
  for await (const e of storage.list(`${SIGKILL_LOG_PREFIX}/log/`)) {
    void e;
    orphanLog++;
  }
  void stepsSeen;

  // Reset prefix for next trial: delete every content + log key under
  // SIGKILL_LOG_PREFIX. (We do this here, not at trial start, so the
  // enumeration above sees the full orphan footprint.)
  for await (const e of storage.list(`${SIGKILL_LOG_PREFIX}/content/`)) {
    await storage.delete(e.key);
  }
  for await (const e of storage.list(`${SIGKILL_LOG_PREFIX}/log/`)) {
    await storage.delete(e.key);
  }
  // Re-create current.json so the next trial sees a clean seq.
  await storage.delete(SIGKILL_CURRENT_KEY).catch(() => {
    // delete is idempotent; ignore.
  });

  return {
    trial_index: trialIndex,
    killed_after_step: cell.killAfterStep,
    orphan_content_count: orphanContent,
    orphan_log_count: orphanLog,
    child_completed: childCompleted,
  };
}

async function runS3Sigkill(cell: SweepCell): Promise<RunResult> {
  const started = new Date();
  const t0 = performance.now();

  const trials: TrialResult[] = [];
  for (let i = 0; i < cell.trials; i++) {
    trials.push(await s3SigkillTrial(cell, i));
  }
  const wallclockMs = performance.now() - t0;

  // Aggregate: orphan_rate = trials with ≥1 orphan / total trials.
  // (Methodology D3 uses this single number; the per-category split
  // is in `notes` for the interpreter.)
  const orphaned = trials.filter((t) => t.orphan_content_count + t.orphan_log_count > 0).length;
  const orphanRate = orphaned / cell.trials;
  const orphanContentTotal = trials.reduce((sum, t) => sum + t.orphan_content_count, 0);
  const orphanLogTotal = trials.reduce((sum, t) => sum + t.orphan_log_count, 0);
  const childCompletedCount = trials.filter((t) => t.child_completed).length;

  const notes =
    `orphan_rate=${orphanRate.toFixed(3)} ` +
    `orphan_content_total=${orphanContentTotal} ` +
    `orphan_log_total=${orphanLogTotal} ` +
    `child_completed_uninteresting=${childCompletedCount}/${cell.trials} ` +
    `killed_after_step=${cell.killAfterStep}`;

  return {
    cell,
    started_iso: started.toISOString(),
    wallclock_ms: wallclockMs,
    effective_throughput_per_sec: 0,
    cas_412_rate: 0,
    rate_limit_429_rate: 0,
    class_a_op_count: 0,
    class_b_op_count: 0,
    class_a_per_writer_per_hour: 0,
    latency_p50_ms: 0,
    latency_p99_ms: 0,
    latency_p999_ms: 0,
    retry_tail_max: 0,
    // S3-sigkill does NOT validate the idle-reader cost-model bound;
    // mark as held so the exit-code logic doesn't fire 1.
    cost_model_bound_holds: true,
    notes,
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy via fresh ArrayBuffer: tsgo narrows `Uint8Array` to
  // `Uint8Array<ArrayBufferLike>`, which `crypto.subtle.digest` rejects
  // (wants `ArrayBufferView<ArrayBuffer>`). See microsoft/TypeScript#61375.
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  const hash = await crypto.subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

interface S5WriterCounters {
  writes_attempted: number;
  writes_committed: number;
  log_404_on_read: number; // safety violation
  snapshot_hash_mismatch: number; // safety violation
}

async function s5Writer(storage: CountingStorage, signal: AbortSignal): Promise<S5WriterCounters> {
  const counters: S5WriterCounters = {
    writes_attempted: 0,
    writes_committed: 0,
    log_404_on_read: 0,
    snapshot_hash_mismatch: 0,
  };

  // Bootstrap current.json. The compactor needs it to exist.
  await createCurrentJson(storage, S5_CURRENT_KEY, SEED).catch((error: unknown) => {
    if (error instanceof BaerlyError && error.code === "Conflict") {
      return;
    }
    throw error;
  });

  while (!signal.aborted) {
    const t0 = performance.now();
    counters.writes_attempted++;
    try {
      // Read current.json to get next_seq.
      const read = await readCurrentJson(storage, S5_CURRENT_KEY);
      if (read === null) {
        throw new BaerlyError("InvalidResponse", "current.json missing during S5 run");
      }
      const seqCursor = read.json.next_seq;

      // Step 1. PUT content.
      const body = new TextEncoder().encode(
        JSON.stringify({ seq: seqCursor, payload: `data-${seqCursor}` }),
      );
      const sha = await sha256Hex(body);
      const contentKey = `${S5_LOG_PREFIX}/content/${sha}.json`;
      await storage
        .put(contentKey, body, { ifNoneMatch: "*", contentType: "application/json" })
        .catch((error: unknown) => {
          if (error instanceof BaerlyError && error.code === "Conflict") {
            return;
          } // idempotent
          throw error;
        });

      // Step 2. PUT log entry.
      const logKey = `${S5_LOG_PREFIX}/log/${seqCursor}.json`;
      const logEntry = {
        seq: seqCursor,
        collection: "compact",
        doc_id: `doc-${seqCursor}`,
        op: "I" as const,
        session: "bench-s5",
        after: { seq: seqCursor, payload: `data-${seqCursor}` },
      };
      await storage.put(logKey, encodeJsonBytes(logEntry), {
        ifNoneMatch: "*",
        contentType: "application/json",
      });

      // Step 3. CAS-advance current.json.
      await casUpdateCurrentJson(storage, S5_CURRENT_KEY, (cur) => ({
        ...cur,
        next_seq: cur.next_seq + 1,
      }));
      counters.writes_committed++;

      // Step 4 (the safety check): read back a log entry inside
      // [log_seq_start, next_seq). If we get a 404, the compactor + GC
      // raced us. seqCursor was the entry we just CAS'd; pick a seq
      // halfway into the visible range so the check exercises live log
      // tail, not the just-written entry.
      const after = await readCurrentJson(storage, S5_CURRENT_KEY);
      if (after !== null && after.json.next_seq - (after.json.log_seq_start ?? 0) >= 2) {
        const start = after.json.log_seq_start ?? 0;
        const checkSeq = start + Math.floor((after.json.next_seq - start) / 2);
        const checkKey = `${S5_LOG_PREFIX}/log/${checkSeq}.json`;
        const got = await storage.get(checkKey);
        if (got === null) {
          counters.log_404_on_read++;
        }
      }
    } catch (error: unknown) {
      // Conflict on CAS is expected — back off and re-read. Don't
      // count as a violation. Other errors are surfaced.
      if (error instanceof BaerlyError && error.code === "Conflict") {
        continue;
      }
      if (
        error instanceof BaerlyError &&
        error.code === "Internal" &&
        error.message.includes("hash")
      ) {
        counters.snapshot_hash_mismatch++;
        continue;
      }
      throw error;
    }
    // Pacing: target ~50 ops/sec means ~20ms between ops.
    const elapsed = performance.now() - t0;
    const delay = Math.max(0, 1000 / S5_TARGET_OPS_PER_SEC - elapsed);
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return counters;
}

async function runS5Compaction(cell: SweepCell): Promise<RunResult> {
  const via = viaFor(cell.network);
  const storage = buildBenchStorage({ via, bucket: BUCKET });
  await ensureBucket({ via, bucket: BUCKET });
  // Clean prefix — guarantee a deterministic start.
  for await (const e of storage.list(`${S5_LOG_PREFIX}/`)) {
    await storage.delete(e.key);
  }
  // Reset counters; only the writer + compactor loop count.
  storage.classAOps = 0;
  storage.classBOps = 0;

  const controller = new AbortController();
  const started = new Date();
  const t0 = performance.now();
  const stop = setTimeout(() => controller.abort(), cell.durationMs);

  // Run writer + compactor loop in parallel, both honouring the same
  // abort signal. The writer + compactor share ONE Storage handle so
  // the CountingStorage's per-op counters add up for the cost report.
  const writerP = s5Writer(storage, controller.signal);
  const compactorP = runCompactorLoop(storage, S5_CURRENT_KEY, 1000, controller.signal);

  let writerCounters: S5WriterCounters;
  let compactorCounters: CompactorLoopCounters;
  try {
    [writerCounters, compactorCounters] = await Promise.all([writerP, compactorP]);
  } finally {
    clearTimeout(stop);
  }
  const wallclockMs = performance.now() - t0;

  const safetyViolations = writerCounters.log_404_on_read + writerCounters.snapshot_hash_mismatch;
  const baseNotes =
    `writes_attempted=${writerCounters.writes_attempted} ` +
    `writes_committed=${writerCounters.writes_committed} ` +
    `compact_passes=${compactorCounters.passes} ` +
    `compacts_landed=${compactorCounters.compactsLanded} ` +
    `compacts_cas_lost=${compactorCounters.compactsCasLost} ` +
    `gc_swept=${compactorCounters.gcSwept} ` +
    `log_404_on_read=${writerCounters.log_404_on_read} ` +
    `snapshot_hash_mismatch=${writerCounters.snapshot_hash_mismatch} ` +
    `safety_violations=${safetyViolations}`;
  const notes = safetyViolations > 0 ? `SAFETY VIOLATION: ${baseNotes}` : baseNotes;

  return {
    cell,
    started_iso: started.toISOString(),
    wallclock_ms: wallclockMs,
    effective_throughput_per_sec: writerCounters.writes_committed / (wallclockMs / 1000),
    cas_412_rate: 0, // covered in S1; not the load-bearing measurement here
    rate_limit_429_rate: 0,
    class_a_op_count: storage.classAOps,
    class_b_op_count: storage.classBOps,
    class_a_per_writer_per_hour: 0, // not applicable
    latency_p50_ms: 0,
    latency_p99_ms: 0,
    latency_p999_ms: 0,
    retry_tail_max: 0,
    // The exit-code contract: `cost_model_bound_holds === false` ⇒
    // harness exits 1. We co-opt that field for "no safety violations
    // observed." See `notes` for the actual measurement.
    cost_model_bound_holds: safetyViolations === 0,
    notes,
  };
}

async function runS3Toxic(cell: SweepCell): Promise<RunResult> {
  await installToxics(cell.network);
  try {
    return await runS1(cell);
  } finally {
    await clearToxics();
  }
}

function parseArgs(argv: readonly string[]): SweepCell {
  const map = new Map<string, string>(
    argv.flatMap((a): Array<[string, string]> => {
      const m = /^--([^=]+)=(.*)$/.exec(a);
      return m ? [[m[1]!, m[2]!]] : [];
    }),
  );
  const arg = (name: string, dflt: string): string => map.get(name) ?? dflt;
  const scenario = arg("scenario", "S2-idle") as Scenario;
  const retryPolicy = arg("retry", "decorrelated") as RetryPolicy;
  const network = arg("network", "direct") as Network;
  const trials = Number(arg("trials", "100"));
  const killAfterStep = Number(arg("kill-after-step", "2"));
  if (killAfterStep !== 1 && killAfterStep !== 2) {
    throw new Error(`--kill-after-step must be 1 or 2; got ${killAfterStep}`);
  }
  return {
    scenario,
    concurrency: Number(arg("concurrency", "16")),
    pollerCount: Number(arg("pollers", "10")),
    collections: Number(arg("collections", "10")),
    retryPolicy,
    network,
    durationMs: Number(arg("duration-s", "60")) * 1000,
    outDir: arg("out-dir", "bench/results"),
    cellId: arg("cell-id", `${scenario}-${new Date().toISOString().replace(/[:.]/g, "-")}`),
    trials,
    killAfterStep: killAfterStep as 1 | 2,
  };
}

// Scenario → runner dispatch. Extracted from `main` so the table
// doesn't sit inline as a 5-deep nested ternary.
async function runScenario(cell: SweepCell): Promise<RunResult> {
  if (cell.scenario === "S1") {
    return runS1(cell);
  }
  if (cell.scenario === "S2-idle") {
    return runS2Idle(cell);
  }
  if (cell.scenario === "S2-multi") {
    return runS2Multi(cell);
  }
  if (cell.scenario === "S3-sigkill") {
    return runS3Sigkill(cell);
  }
  if (cell.scenario === "S5-compaction") {
    return runS5Compaction(cell);
  }
  return runS3Toxic(cell);
}

async function main(): Promise<number> {
  const cell = parseArgs(process.argv.slice(2));
  await preflight(cell.network);
  const result = await runScenario(cell);

  // The matrix orchestrator (`bench/r2-contention-matrix.ts`) pins
  // `--out-dir` to the sweep's timestamped subdirectory and
  // `--cell-id` to a deterministic per-cell slug so it can read the
  // per-cell JSON back without scanning the whole results/ tree. When
  // invoked stand-alone, `parseArgs` falls back to `bench/results/`
  // and a `<scenario>-<timestamp>` slug — preserving the single-cell
  // behaviour the harness has shipped since ticket 50.
  const outDir = cell.outDir ?? "bench/results";
  const cellId =
    cell.cellId ?? `${cell.scenario}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const out = path.join(outDir, `${cellId}.json`);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(result, null, 2));

  // One-line summary to stdout. Operator parses this for at-a-glance
  // sweep results.
  console.log(
    `${cell.scenario} c=${cell.concurrency} pollers=${cell.pollerCount} m=${cell.collections} ` +
      `retry=${cell.retryPolicy} net=${cell.network}: ` +
      `class_a/writer/hr=${result.class_a_per_writer_per_hour.toFixed(3)} ` +
      `412_rate=${result.cas_412_rate.toFixed(3)} 429_rate=${result.rate_limit_429_rate.toFixed(3)} ` +
      `bound_holds=${result.cost_model_bound_holds}`,
  );

  return result.cost_model_bound_holds ? 0 : 1;
}

const code = await main();
process.exit(code);
