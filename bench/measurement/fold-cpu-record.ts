import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpus, freemem, loadavg, platform, release, totalmem } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { getHeapStatistics } from "node:v8";
import Ajv from "ajv";
import type { FoldCpuMeasurement, FoldCpuOperation, RuntimeArm } from "./fold-cpu.ts";

export const FOLD_CPU_SCHEMA = "baerly.fold-cpu/v2" as const;
export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Full working-tree patch, including staged and untracked measurement code. */
export const captureSource = (cwd: string) => {
  const git = (args: string[]): string =>
    execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean);
  let patch = git(["diff", "--no-color", "--binary", "--no-ext-diff", "HEAD", "--", "."]);
  for (const file of untracked) {
    const diff = spawnSync(
      "git",
      ["diff", "--no-color", "--binary", "--no-ext-diff", "--no-index", "--", "/dev/null", file],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    if (diff.error || (diff.status !== 0 && diff.status !== 1)) {
      throw diff.error ?? new Error(diff.stderr);
    }
    patch += diff.stdout;
  }
  return {
    sha: git(["rev-parse", "HEAD"]).trim(),
    patch,
    patch_sha256: sha256(patch),
    dirty: patch.length > 0,
    untracked_files: untracked,
  };
};

export const captureEnvironment = () => ({
  node: process.version,
  v8: process.versions.v8,
  platform: platform(),
  os_release: release(),
  arch: process.arch,
  cpu_models: [...new Set(cpus().map((cpu) => cpu.model))],
  logical_cores: cpus().length,
  total_memory_bytes: totalmem(),
  heap_limit_bytes: getHeapStatistics().heap_size_limit,
  exec_argv: process.execArgv,
});
export const captureLoad = () => ({
  at: new Date().toISOString(),
  load_average: loadavg(),
  free_memory_bytes: freemem(),
});
export type LoadSnapshot = ReturnType<typeof captureLoad>;

/** Heuristic host-noise screen, not evidence that an accepted envelope is safe. */
export const classifyLoad = (
  start: LoadSnapshot,
  end: LoadSnapshot,
  cores: number,
  memoryBytes: number,
) => {
  if (!Number.isInteger(cores) || cores < 1 || !Number.isFinite(memoryBytes) || memoryBytes <= 0) {
    throw new RangeError("valid host resources required");
  }
  const valid = [start, end].every(
    (s) =>
      s.load_average.length === 3 &&
      s.load_average.every((n) => Number.isFinite(n) && n >= 0) &&
      Number.isFinite(s.free_memory_bytes) &&
      s.free_memory_bytes >= 0,
  );
  const reasons: string[] = [];
  if (!valid) {
    reasons.push("invalid load observation");
  }
  if ([start, end].some((s) => s.load_average.some((n) => n / cores >= 0.5))) {
    reasons.push("load average >= 0.5 per logical core");
  }
  if ([start, end].some((s) => s.free_memory_bytes / memoryBytes < 0.1)) {
    reasons.push("free host memory < 10%");
  }
  return { classification: reasons.length ? "exploratory-loaded" : "quiet-local-screen", reasons };
};

export const computeMargins = (
  measurements: readonly FoldCpuMeasurement[],
  cpuBudget: number | null,
  latencyBudget: number | null,
) => {
  const samples = measurements.flatMap((m) => m.samples);
  const maxCpu = Math.max(...samples.map((s) => s.thread_cpu_ms));
  const maxLatency = Math.max(...samples.map((s) => s.latency_ms));
  return {
    cpu_budget_ms: cpuBudget,
    latency_budget_ms: latencyBudget,
    observed_max_thread_cpu_ms: maxCpu,
    observed_max_latency_ms: maxLatency,
    cpu_headroom_ms: cpuBudget === null ? null : cpuBudget - maxCpu,
    latency_headroom_ms: latencyBudget === null ? null : latencyBudget - maxLatency,
  };
};

export interface FoldCpuRecord {
  schema: typeof FOLD_CPU_SCHEMA;
  measurement_mode: "baseline" | "profile-instrumented";
  profiles: { manifest: string; sampling_interval_us: number } | null;
  source: ReturnType<typeof captureSource>;
  environment: ReturnType<typeof captureEnvironment>;
  start_load: LoadSnapshot;
  end_load: LoadSnapshot;
  load_screen: ReturnType<typeof classifyLoad>;
  workload: {
    seed: number;
    data_shape: string;
    id_shape: string;
    index_count: number;
    cache_state: string;
    repetitions: number;
    warmups: number;
    operations: FoldCpuOperation[];
    runtime_arms: RuntimeArm[];
  };
  measurements: FoldCpuMeasurement[];
  failures: number;
  margins: ReturnType<typeof computeMargins>;
  limitations: string[];
}

// Validate persisted evidence at the writer boundary, including raw samples.
const number = { type: "number", minimum: 0 };
const integer = { type: "integer", minimum: 0 };
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  required: Object.keys(properties),
  additionalProperties: false,
  properties,
});
const string = { type: "string" };
const strings = { type: "array", items: string };
const load = object({
  at: string,
  load_average: {
    type: "array",
    items: number,
    minItems: 3,
    maxItems: 3,
  },
  free_memory_bytes: number,
});
const nullableBudget = { anyOf: [{ type: "number", exclusiveMinimum: 0 }, { type: "null" }] };
const schema = object({
  schema: { const: FOLD_CPU_SCHEMA },
  measurement_mode: { enum: ["baseline", "profile-instrumented"] },
  profiles: {
    anyOf: [
      object({ manifest: string, sampling_interval_us: { type: "integer", minimum: 1 } }),
      { type: "null" },
    ],
  },
  source: object({
    sha: { type: "string", pattern: "^[a-f0-9]{40}$" },
    patch: string,
    patch_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    dirty: { type: "boolean" },
    untracked_files: strings,
  }),
  environment: object({
    node: string,
    v8: string,
    platform: string,
    os_release: string,
    arch: string,
    cpu_models: { type: "array", items: string, minItems: 1 },
    logical_cores: { type: "integer", minimum: 1 },
    total_memory_bytes: { type: "number", exclusiveMinimum: 0 },
    heap_limit_bytes: number,
    exec_argv: strings,
  }),
  start_load: load,
  end_load: load,
  load_screen: object({
    classification: { enum: ["exploratory-loaded", "quiet-local-screen"] },
    reasons: strings,
  }),
  workload: object({
    seed: integer,
    data_shape: string,
    id_shape: string,
    index_count: integer,
    cache_state: string,
    repetitions: { type: "integer", minimum: 1 },
    warmups: { type: "integer", minimum: 1 },
    operations: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { enum: ["get", "all", "fold"] },
    },
    runtime_arms: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { enum: ["unprimed", "warmed"] },
    },
  }),
  measurements: {
    type: "array",
    minItems: 1,
    items: object({
      cell: object({
        axis: { enum: ["bytes", "rows"] },
        rows: { type: "integer", minimum: 1 },
        bytes_per_doc: { type: "integer", minimum: 1 },
        tail_entries: integer,
      }),
      operation: { enum: ["get", "all", "fold"] },
      runtime_arm: { enum: ["unprimed", "warmed"] },
      snapshot_bytes: number,
      samples: {
        type: "array",
        minItems: 1,
        items: object({
          thread_cpu_ms: number,
          process_cpu_ms: number,
          latency_ms: number,
          heap_start_bytes: number,
          heap_end_bytes: number,
          sampled_heap_peak_bytes: number,
          rss_start_bytes: number,
          rss_end_bytes: number,
          operations: object({
            get: integer,
            put: integer,
            delete: integer,
            list: integer,
            listed_entries: integer,
            get_body_bytes: integer,
            put_body_bytes: integer,
          }),
          outcome: { enum: ["ok", "failed"] },
          error: { anyOf: [string, { type: "null" }] },
        }),
      },
    }),
  },
  failures: integer,
  margins: object({
    cpu_budget_ms: nullableBudget,
    latency_budget_ms: nullableBudget,
    observed_max_thread_cpu_ms: number,
    observed_max_latency_ms: number,
    cpu_headroom_ms: { type: ["number", "null"] },
    latency_headroom_ms: { type: ["number", "null"] },
  }),
  limitations: strings,
});
const validate = new Ajv({ strict: true, allErrors: true }).compile<FoldCpuRecord>(schema);

export function assertFoldCpuRecord(value: unknown): asserts value is FoldCpuRecord {
  if (!validate(value)) {
    throw new TypeError(JSON.stringify(validate.errors));
  }
  const record = value;
  const failures = record.measurements
    .flatMap((m) => m.samples)
    .filter((s) => s.outcome === "failed").length;
  if (
    record.source.patch_sha256 !== sha256(record.source.patch) ||
    record.source.dirty !== record.source.patch.length > 0 ||
    failures !== record.failures ||
    (record.measurement_mode === "profile-instrumented") !== (record.profiles !== null) ||
    record.measurements.some(
      (m) =>
        m.samples.length !== record.workload.repetitions ||
        !record.workload.operations.includes(m.operation) ||
        !record.workload.runtime_arms.includes(m.runtime_arm) ||
        m.samples.some(
          (s) =>
            (s.outcome === "failed") !== (s.error !== null) ||
            s.sampled_heap_peak_bytes < Math.max(s.heap_start_bytes, s.heap_end_bytes),
        ),
    )
  ) {
    throw new TypeError("inconsistent fold CPU record");
  }
  if (
    !isDeepStrictEqual(
      computeMargins(
        record.measurements,
        record.margins.cpu_budget_ms,
        record.margins.latency_budget_ms,
      ),
      record.margins,
    )
  ) {
    throw new TypeError("inconsistent margins");
  }
  const screen = classifyLoad(
    record.start_load,
    record.end_load,
    record.environment.logical_cores,
    record.environment.total_memory_bytes,
  );
  if (!isDeepStrictEqual(screen, record.load_screen)) {
    throw new TypeError("inconsistent load classification");
  }
}
