/**
 * R2 contention bench harness — main entrypoint.
 *
 * Three scenarios:
 *   - **S1**: concurrent CAS storm — N writers race on one
 *     `current.json` for a configurable wall-clock window.
 *   - **S2-idle**: idle reader bound — M pollers issue
 *     `readCurrentJson` every 2 seconds with zero writers; the
 *     canonical Phase-5 cost-model gate (< 1 Class A op / writer /
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

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  casUpdateCurrentJson,
  createCurrentJson,
  readCurrentJson,
  MPS3Error,
  type CurrentJson,
} from "@baerly/protocol";
import { buildBenchStorage, ensureBucket, type CountingStorage } from "./storage.ts";
import { Metrics } from "./metrics.ts";
import { clearToxics, installToxics, isToxiproxyReady } from "./toxiproxy.ts";
import type { Network, RetryPolicy, RunResult, Scenario, SweepCell } from "./types.ts";

const CURRENT_KEY = "bench/tenant-A/collection-K/current.json";
const BUCKET = "baerly-bench";
const MINIO_HEALTH_URL = "http://127.0.0.1:9102/minio/health/ready";
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

function viaFor(network: Network): "direct" | "toxiproxy" {
  return network === "direct" ? "direct" : "toxiproxy";
}

function jitter(policy: RetryPolicy, attempt: number, prevSleepMs: number): number {
  switch (policy) {
    case "no-jitter":
      return Math.min(CAP_MS, BASE_MS * 2 ** attempt);
    case "full-jitter":
      return Math.random() * Math.min(CAP_MS, BASE_MS * 2 ** attempt);
    case "decorrelated":
      return Math.min(CAP_MS, Math.random() * (3 * prevSleepMs - BASE_MS) + BASE_MS);
  }
}

async function preflight(network: Network): Promise<void> {
  // Minio readiness. Anything other than 200 means `pnpm dev:storage`
  // hasn't been run (or hasn't finished); bail with a clear message.
  let res: Response;
  try {
    res = await fetch(MINIO_HEALTH_URL);
  } catch (e) {
    throw new Error(
      `bench: Minio not reachable at ${MINIO_HEALTH_URL} (${(e as Error).message}). ` +
        `Did you run 'pnpm dev:storage'?`, { cause: e },
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
  } catch (e: unknown) {
    if (e instanceof MPS3Error && e.code === "Conflict") return; // already there
    throw e;
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
      } catch (e: unknown) {
        if (e instanceof MPS3Error && e.code === "Conflict") {
          metrics.recordConflict412();
          const sleepMs = jitter(retryPolicy, attempts, prevSleep);
          prevSleep = sleepMs;
          await new Promise((r) => setTimeout(r, sleepMs));
          attempts++;
          continue;
        }
        if (e instanceof MPS3Error && e.code === "NetworkError") {
          metrics.recordRateLimit429();
          const sleepMs = jitter(retryPolicy, attempts, prevSleep);
          prevSleep = sleepMs;
          await new Promise((r) => setTimeout(r, sleepMs));
          attempts++;
          continue;
        }
        throw e;
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
  return {
    scenario,
    concurrency: Number(arg("concurrency", "16")),
    pollerCount: Number(arg("pollers", "10")),
    retryPolicy,
    network,
    durationMs: Number(arg("duration-s", "60")) * 1000,
  };
}

async function main(): Promise<number> {
  const cell = parseArgs(process.argv.slice(2));
  await preflight(cell.network);
  const result =
    cell.scenario === "S1"
      ? await runS1(cell)
      : cell.scenario === "S2-idle"
        ? await runS2Idle(cell)
        : await runS3Toxic(cell);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = path.join("bench/results", `${cell.scenario}-${stamp}.json`);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(result, null, 2));

  // One-line summary to stdout. Operator parses this for at-a-glance
  // sweep results.
  console.log(
    `${cell.scenario} c=${cell.concurrency} pollers=${cell.pollerCount} retry=${cell.retryPolicy} net=${cell.network}: ` +
      `class_a/writer/hr=${result.class_a_per_writer_per_hour.toFixed(3)} ` +
      `412_rate=${result.cas_412_rate.toFixed(3)} 429_rate=${result.rate_limit_429_rate.toFixed(3)} ` +
      `bound_holds=${result.cost_model_bound_holds}`,
  );

  return result.cost_model_bound_holds ? 0 : 1;
}

const code = await main();
process.exit(code);
