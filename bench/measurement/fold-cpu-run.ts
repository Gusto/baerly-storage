import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { relative, resolve, sep } from "node:path";
import { SEED } from "../lib/fold-fixture.ts";
import { runAsCliEntrypoint } from "./cli-entrypoint.ts";
import {
  runFoldCpuCell,
  type FoldCpuCell,
  type FoldCpuMeasurement,
  type FoldCpuOperation,
  type RuntimeArm,
} from "./fold-cpu.ts";
import {
  createInvocationProfile,
  PROFILE_INTERVAL_US,
  type ProfileEntry,
} from "./fold-cpu-profile.ts";
import {
  assertFoldCpuRecord,
  captureEnvironment,
  captureLoad,
  captureSource,
  classifyLoad,
  FOLD_CPU_SCHEMA,
  computeMargins,
  sha256,
  type FoldCpuRecord,
} from "./fold-cpu-record.ts";

const positive = (raw: string, label: string): number => {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label}: positive integer required`);
  }
  return value;
};
const ladder = (raw: string, label: string): number[] =>
  raw.split(",").map((n) => positive(n, label));

export const selectValues = <T extends string>(raw: string, allowed: readonly T[]): T[] => {
  const selected = raw.split(",");
  if (!selected.length || selected.some((value) => !allowed.includes(value as T))) {
    throw new RangeError(`expected comma-separated values from ${allowed.join(",")}`);
  }
  return [...new Set(selected)] as T[];
};

const budget = (raw: string | undefined): number | null => {
  if (raw === undefined) {
    return null;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new RangeError("budget must be finite and positive");
  }
  return n;
};

export const main = async (): Promise<number> => {
  const { values } = parseArgs({
    options: {
      "byte-targets": { type: "string", default: "65536,262144,524288,1048576" },
      rows: { type: "string", default: "256,1024,2048,8192" },
      tails: { type: "string", default: "0,1,16" },
      repetitions: { type: "string", default: "11" },
      warmups: { type: "string", default: "3" },
      operations: { type: "string", default: "get,all,fold" },
      arms: { type: "string", default: "unprimed,warmed" },
      "profile-dir": { type: "string" },
      "cpu-budget-ms": { type: "string" },
      "latency-budget-ms": { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "pnpm bench:fold-cpu [--byte-targets=65536,524288] [--rows=256,2048] [--tails=0,1,16] " +
        "[--repetitions=11] [--warmups=3] [--operations=get,all,fold] [--arms=unprimed,warmed] " +
        "[--profile-dir=bench/results/fold-cpu/PROFILE-RUN] " +
        "[--cpu-budget-ms=N] [--latency-budget-ms=N] [--out=PATH]",
    );
    return 0;
  }
  const repetitions = positive(values.repetitions, "repetitions");
  const warmups = positive(values.warmups, "warmups");
  const cpuBudget = budget(values["cpu-budget-ms"]);
  const latencyBudget = budget(values["latency-budget-ms"]);
  const operations = selectValues<FoldCpuOperation>(values.operations, ["get", "all", "fold"]);
  const arms = selectValues<RuntimeArm>(values.arms, ["unprimed", "warmed"]);
  const cells: FoldCpuCell[] = [];
  const tails = values.tails.split(",").map((raw) => {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isSafeInteger(n) || n < 0) {
      throw new RangeError("tails: nonnegative integers required");
    }
    return n;
  });
  for (const tail of tails) {
    for (const target of ladder(values["byte-targets"], "byte-targets")) {
      cells.push({
        axis: "bytes",
        rows: Math.max(1, Math.round(target / 2048)),
        bytes_per_doc: 2048,
        tail_entries: tail,
      });
    }
    for (const rows of ladder(values.rows, "rows")) {
      cells.push({ axis: "rows", rows, bytes_per_doc: 64, tail_entries: tail });
    }
  }
  const cwd = process.cwd();
  if (operations.every((op) => op === "fold") && cells.every((cell) => cell.tail_entries === 0)) {
    throw new RangeError("fold requires at least one nonempty tail");
  }
  const profileDirectory = values["profile-dir"] ? resolve(values["profile-dir"]) : null;
  if (profileDirectory) {
    const withinResults = relative(resolve(cwd, "bench/results"), profileDirectory);
    if (!withinResults || withinResults.startsWith(`..${sep}`) || withinResults === "..") {
      throw new RangeError("profile-dir must be a new directory within ignored bench/results/");
    }
    await mkdir(resolve(profileDirectory, ".."), { recursive: true });
    await mkdir(profileDirectory);
    console.warn(
      "PROFILE-INSTRUMENTED: timing includes inspector overhead; run baseline separately.",
    );
  }
  const source = captureSource(cwd);
  const environment = captureEnvironment();
  const start = captureLoad();
  const initial = classifyLoad(
    start,
    start,
    environment.logical_cores,
    environment.total_memory_bytes,
  );
  if (initial.classification === "exploratory-loaded") {
    console.warn(`EXPLORATORY loaded host: ${initial.reasons.join("; ")}`);
  }
  const measurements: FoldCpuMeasurement[] = [];
  const profiles: ProfileEntry[] = [];
  console.log(
    "axis rows bytes tail op arm maxThreadMs maxLatencyMs cpuMarginMs latencyMarginMs failures",
  );
  for (const cell of cells) {
    for (const operation of operations) {
      if (operation === "fold" && cell.tail_entries === 0) {
        continue;
      }
      for (const arm of arms) {
        const result = await runFoldCpuCell(
          cell,
          operation,
          arm,
          repetitions,
          warmups,
          profileDirectory
            ? (identity) => createInvocationProfile(profileDirectory, identity, profiles)
            : undefined,
        );
        measurements.push(result);
        const cpu = Math.max(...result.samples.map((s) => s.thread_cpu_ms));
        const latency = Math.max(...result.samples.map((s) => s.latency_ms));
        console.log(
          `${cell.axis} ${cell.rows} ${result.snapshot_bytes} ${cell.tail_entries} ${operation} ${arm} ` +
            `${cpu.toFixed(3)} ${latency.toFixed(3)} ` +
            `${cpuBudget === null ? "unset" : (cpuBudget - cpu).toFixed(3)} ` +
            `${latencyBudget === null ? "unset" : (latencyBudget - latency).toFixed(3)} ` +
            result.samples.filter((s) => s.outcome === "failed").length,
        );
      }
    }
  }
  const end = captureLoad();
  const endSource = captureSource(cwd);
  if (endSource.sha !== source.sha || endSource.patch_sha256 !== source.patch_sha256) {
    throw new Error("working tree changed during measurement; rerun with a stable tree");
  }
  const screen = classifyLoad(
    start,
    end,
    environment.logical_cores,
    environment.total_memory_bytes,
  );
  const result: FoldCpuRecord = {
    schema: FOLD_CPU_SCHEMA,
    measurement_mode: profileDirectory ? "profile-instrumented" : "baseline",
    profiles: profileDirectory
      ? {
          manifest: resolve(profileDirectory, "manifest.json"),
          sampling_interval_us: PROFILE_INTERVAL_US,
        }
      : null,
    source,
    environment,
    start_load: start,
    end_load: end,
    load_screen: screen,
    workload: {
      seed: SEED,
      data_shape:
        "notes: title, seeded integer/boolean, repeated ASCII x padding; canonical JSON; uniform full-post-image updates",
      id_shape: "doc-00000000: sequential fixed-width ASCII strings; point query doc-00000000",
      index_count: 0,
      cache_state:
        "MemoryStorage resident bytes; no parsed snapshot cache; unprimed has no explicit warmup; warmed has separate-fixture same-operation warmups; shared process/JIT throughout",
      repetitions,
      warmups,
      operations,
      runtime_arms: arms,
    },
    measurements,
    failures: measurements.flatMap((m) => m.samples).filter((s) => s.outcome === "failed").length,
    margins: computeMargins(measurements, cpuBudget, latencyBudget),
    limitations: [
      "Local exploratory screen only; no Worker/S3/R2 capacity, tail quantile, sustained-load or policy claims.",
      "Thread CPU includes JavaScript but excludes off-thread crypto/GC workers. Process CPU includes other runtime threads; both are reported.",
      "Whole get/all and compact calls include parse, merge, sorting/copying, hashing and publication where production performs them. Fixture setup, warmups and result writing excluded.",
      "Unprimed uses a fresh fixture/Db but shares module/runtime/JIT state with earlier cells. Warmed is runtime warmup, not a cache-hit or fresh-isolate comparison.",
      "Heap samples at 1ms plus endpoints can miss synchronous peaks; GC may lower deltas. RSS endpoints and absolute heap are diagnostic, not isolate peak memory.",
      "MemoryStorage retains body references; no network wait, transport encoding, realistic storage concurrency, real data heterogeneity or index work.",
      "Margins printed as supplied budget minus observed maximum; no budget selected by harness, no confidence or safety guarantee.",
      "Load screen uses endpoint 1/5/15-minute averages >= 0.5 per logical core or free memory <10%; quiet does not prove absence of contention. Acceptance needs a quiet owner-run study.",
      ...(profileDirectory
        ? [
            "Inspector profiling is enabled for each measured invocation only; timings include inspector stop overhead and are not uninstrumented baseline evidence. Profiles sample the calling thread, not off-thread crypto/GC work; short invocations may have few samples.",
          ]
        : []),
    ],
  };
  assertFoldCpuRecord(result);
  const out = resolve(
    values.out ?? `bench/results/fold-cpu/${start.at.replace(/[:.]/g, "-")}.json`,
  );
  await mkdir(resolve(out, ".."), { recursive: true });
  const contents = JSON.stringify(result, null, 2) + "\n";
  await writeFile(out, contents);
  if (profileDirectory) {
    await writeFile(
      resolve(profileDirectory, "manifest.json"),
      JSON.stringify(
        {
          schema: "baerly.fold-cpu-profiles/v1",
          source: { sha: source.sha, patch_sha256: source.patch_sha256 },
          result: { file: out, sha256: sha256(contents) },
          sampling_interval_us: PROFILE_INTERVAL_US,
          scope:
            "One profile per measured invocation; fixture construction, warmups, source capture and file writing excluded. Inspector start/stop boundary frames may appear; summaries are sample-weighted self/inclusive stack observations, not exact phase timings.",
          entries: profiles,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    console.log(`wrote ${profiles.length} scoped profiles and ${result.profiles!.manifest}`);
  }
  if (screen.classification === "exploratory-loaded") {
    console.warn(`EXPLORATORY loaded run: ${screen.reasons.join("; ")}`);
  }
  console.log(`${screen.classification}; ${result.failures} failures; wrote ${out}`);
  return result.failures > 0 ? 1 : 0;
};

await runAsCliEntrypoint(import.meta.url, main);
