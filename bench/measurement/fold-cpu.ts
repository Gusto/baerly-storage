/** Whole production calls; fixture construction and warmup stay outside the timer. */
import { performance } from "node:perf_hooks";
import type { Storage } from "@baerly/protocol";
import { Db } from "@baerly/server";
import type { InternalCompactOptions } from "@baerly/server/_internal/testing";
import { compact } from "@baerly/server/maintenance";
import {
  buildFixture,
  FOLD_CURRENT_JSON_KEY,
  HEAP_SAMPLE_INTERVAL_MS,
} from "../lib/fold-fixture.ts";
import type { InvocationProfiler, ProfileIdentity } from "./fold-cpu-profile.ts";

export interface FoldCpuCell {
  axis: "bytes" | "rows";
  rows: number;
  bytes_per_doc: number;
  tail_entries: number;
}
export type FoldCpuOperation = "get" | "all" | "fold";
export type RuntimeArm = "unprimed" | "warmed";
export interface StorageCounts {
  get: number;
  put: number;
  delete: number;
  list: number;
  listed_entries: number;
  get_body_bytes: number;
  put_body_bytes: number;
}
export interface FoldCpuSample {
  thread_cpu_ms: number;
  process_cpu_ms: number;
  latency_ms: number;
  heap_start_bytes: number;
  heap_end_bytes: number;
  sampled_heap_peak_bytes: number;
  rss_start_bytes: number;
  rss_end_bytes: number;
  operations: StorageCounts;
  outcome: "ok" | "failed";
  error: string | null;
}
export interface FoldCpuMeasurement {
  cell: FoldCpuCell;
  operation: FoldCpuOperation;
  runtime_arm: RuntimeArm;
  snapshot_bytes: number;
  samples: FoldCpuSample[];
}

const countStorage = (inner: Storage): { storage: Storage; counts: StorageCounts } => {
  const counts: StorageCounts = {
    get: 0,
    put: 0,
    delete: 0,
    list: 0,
    listed_entries: 0,
    get_body_bytes: 0,
    put_body_bytes: 0,
  };
  const storage: Storage = {
    async get(key, options) {
      counts.get++;
      const result = await inner.get(key, options);
      counts.get_body_bytes += result?.body.byteLength ?? 0;
      return result;
    },
    put(key, body, options) {
      counts.put++;
      counts.put_body_bytes += body.byteLength;
      return inner.put(key, body, options);
    },
    delete(key, options) {
      counts.delete++;
      return inner.delete(key, options);
    },
    async *list(prefix, options) {
      counts.list++;
      for await (const entry of inner.list(prefix, options)) {
        counts.listed_entries++;
        yield entry;
      }
    },
  };
  return { storage, counts };
};

/** Includes errors in the measured population; counters describe attempted ops. */
export const measureInvocation = async (
  inner: Storage,
  invoke: (storage: Storage) => Promise<void>,
  profiler?: InvocationProfiler,
): Promise<FoldCpuSample> => {
  if (typeof process.threadCpuUsage !== "function") {
    throw new Error("bench:fold-cpu needs Node with process.threadCpuUsage() (Node 24.2+)");
  }
  const { storage, counts } = countStorage(inner);
  const memory = process.memoryUsage();
  let heapPeak = memory.heapUsed;
  const sampler = setInterval(() => {
    heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
  }, HEAP_SAMPLE_INTERVAL_MS);
  sampler.unref();
  // Profiling has a separate run mode. Start after all probe/fixture setup.
  try {
    if (profiler) {
      await profiler.start();
    }
  } catch (error) {
    clearInterval(sampler);
    throw error;
  }
  const processStart = process.cpuUsage();
  const threadStart = process.threadCpuUsage();
  const start = performance.now();
  let error: string | null = null;
  try {
    await invoke(storage);
  } catch (error_) {
    error = error_ instanceof Error ? `${error_.name}: ${error_.message}` : String(error_);
  } finally {
    clearInterval(sampler);
    if (profiler) {
      await profiler.stop();
    }
  }
  const latency = performance.now() - start;
  const thread = process.threadCpuUsage(threadStart);
  const cpu = process.cpuUsage(processStart);
  const end = process.memoryUsage();
  // Capture endpoints before profile serialization or writing can affect them.
  if (profiler?.save) {
    await profiler.save();
  }
  return {
    thread_cpu_ms: (thread.user + thread.system) / 1000,
    process_cpu_ms: (cpu.user + cpu.system) / 1000,
    latency_ms: latency,
    heap_start_bytes: memory.heapUsed,
    heap_end_bytes: end.heapUsed,
    sampled_heap_peak_bytes: Math.max(heapPeak, end.heapUsed),
    rss_start_bytes: memory.rss,
    rss_end_bytes: end.rss,
    operations: counts,
    outcome: error === null ? "ok" : "failed",
    error,
  };
};

const invoke = async (
  storage: Storage,
  operation: FoldCpuOperation,
  cell: FoldCpuCell,
): Promise<void> => {
  if (operation === "fold") {
    const options: InternalCompactOptions = {
      minEntriesToCompact: 1,
      maxEntriesPerRun: Number.MAX_SAFE_INTEGER,
    };
    const result = await compact({ storage, currentJsonKey: FOLD_CURRENT_JSON_KEY }, options);
    if (!result.written || result.entriesFolded !== cell.tail_entries) {
      throw new Error(`unexpected fold: ${JSON.stringify(result)}`);
    }
  } else {
    const collection = Db.create({ storage, app: "x", tenant: "t" }).collection("notes");
    if (operation === "get") {
      if ((await collection.get("doc-00000000")) === null) {
        throw new Error("fixture point read missing");
      }
    } else {
      const rows = await collection.all();
      if (rows.length !== cell.rows) {
        throw new Error("fixture scan row count mismatch");
      }
    }
  }
};

export const runFoldCpuCell = async (
  cell: FoldCpuCell,
  operation: FoldCpuOperation,
  runtimeArm: RuntimeArm,
  repetitions: number,
  warmups: number,
  profile?: (identity: ProfileIdentity) => InvocationProfiler,
): Promise<FoldCpuMeasurement> => {
  if (
    !Number.isSafeInteger(repetitions) ||
    repetitions < 1 ||
    !Number.isSafeInteger(warmups) ||
    warmups < 1 ||
    (operation === "fold" && cell.tail_entries < 1)
  ) {
    throw new RangeError("positive repetitions, warmups and tail required");
  }
  if (runtimeArm === "warmed") {
    for (let i = 0; i < warmups; i++) {
      const fixture = await buildFixture(cell.rows, cell.bytes_per_doc, cell.tail_entries);
      await invoke(fixture.storage, operation, cell);
    }
  }
  const samples: FoldCpuSample[] = [];
  let snapshotBytes = 0;
  for (let i = 0; i < repetitions; i++) {
    const fixture = await buildFixture(cell.rows, cell.bytes_per_doc, cell.tail_entries);
    snapshotBytes = fixture.snapshotBytes;
    samples.push(
      await measureInvocation(
        fixture.storage,
        (storage) => invoke(storage, operation, cell),
        profile?.({
          cell,
          operation,
          runtime_arm: runtimeArm,
          repetition: i,
          snapshot_bytes: snapshotBytes,
        }),
      ),
    );
  }
  return { cell, operation, runtime_arm: runtimeArm, snapshot_bytes: snapshotBytes, samples };
};
