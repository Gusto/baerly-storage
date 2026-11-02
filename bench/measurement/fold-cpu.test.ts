import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { Profiler } from "node:inspector";
import { describe, expect, test, vi } from "vitest";
import { MemoryStorage } from "@baerly/protocol";
import { buildFixture, FOLD_CURRENT_JSON_KEY, SEED } from "../lib/fold-fixture.ts";
import * as fixtures from "../lib/fold-fixture.ts";
import {
  createInvocationProfile,
  summarizeProfile,
  type ProfileEntry,
} from "./fold-cpu-profile.ts";
import { selectValues } from "./fold-cpu-run.ts";
import { measureInvocation, runFoldCpuCell, type FoldCpuMeasurement } from "./fold-cpu.ts";
import {
  assertFoldCpuRecord,
  captureSource,
  classifyLoad,
  computeMargins,
  FOLD_CPU_SCHEMA,
  sha256,
  type FoldCpuRecord,
  type LoadSnapshot,
} from "./fold-cpu-record.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const load = (average = 0, free = 500): LoadSnapshot => ({
  at: "2026-11-01T00:00:00.000Z",
  load_average: [average, average, average],
  free_memory_bytes: free,
});
const cell = { axis: "rows" as const, rows: 4, bytes_per_doc: 128, tail_entries: 2 };

const recordFor = (measurement: FoldCpuMeasurement): FoldCpuRecord => ({
  schema: FOLD_CPU_SCHEMA,
  measurement_mode: "baseline",
  profiles: null,
  source: {
    sha: "a".repeat(40),
    patch: "",
    patch_sha256: sha256(""),
    dirty: false,
    untracked_files: [],
  },
  environment: {
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    os_release: "test",
    arch: process.arch,
    cpu_models: ["test"],
    logical_cores: 4,
    total_memory_bytes: 1000,
    heap_limit_bytes: 1000,
    exec_argv: [],
  },
  start_load: load(),
  end_load: load(),
  load_screen: classifyLoad(load(), load(), 4, 1000),
  workload: {
    seed: SEED,
    data_shape: "notes",
    id_shape: "sequential",
    index_count: 0,
    cache_state: "no cache",
    repetitions: measurement.samples.length,
    warmups: 1,
    operations: [measurement.operation],
    runtime_arms: [measurement.runtime_arm],
  },
  measurements: [measurement],
  failures: measurement.samples.filter((s) => s.outcome === "failed").length,
  margins: computeMargins([measurement], null, null),
  limitations: ["host-only"],
});

describe("host load classification", () => {
  test("checks both endpoints and all load windows at the documented boundary", () => {
    expect(classifyLoad(load(1.99), load(), 4, 1000).classification).toBe("quiet-local-screen");
    expect(classifyLoad(load(), load(2), 4, 1000).classification).toBe("exploratory-loaded");
    expect(classifyLoad(load(2), load(), 4, 1000).classification).toBe("exploratory-loaded");
    expect(classifyLoad(load(0, 99), load(), 4, 1000).classification).toBe("exploratory-loaded");
    expect(classifyLoad(load(0, 100), load(), 4, 1000).classification).toBe("quiet-local-screen");
    expect(
      classifyLoad({ ...load(), load_average: [0, 0, 2] }, load(), 4, 1000).classification,
    ).toBe("exploratory-loaded");
    expect(classifyLoad({ ...load(), load_average: [NaN] }, load(), 4, 1000).classification).toBe(
      "exploratory-loaded",
    );
  });
});

describe("whole invocation probe", () => {
  test("reads include snapshot plus controlled tail and never publish", async () => {
    for (const operation of ["get", "all"] as const) {
      const noTail = await runFoldCpuCell(
        { ...cell, tail_entries: 0 },
        operation,
        "unprimed",
        1,
        1,
      );
      const tail = await runFoldCpuCell(cell, operation, "warmed", 2, 1);
      expect(tail.samples).toHaveLength(2);
      expect(tail.samples[0]!.operations.get).toBe(noTail.samples[0]!.operations.get + 2);
      for (const sample of tail.samples) {
        expect(sample.outcome).toBe("ok");
        expect(sample.operations.put).toBe(0);
        expect(sample.operations.get_body_bytes).toBeGreaterThan(tail.snapshot_bytes);
      }
    }
  });

  test("each fold publishes exactly one snapshot and head; setup/warmups are excluded", async () => {
    const result = await runFoldCpuCell(cell, "fold", "warmed", 2, 2);
    for (const sample of result.samples) {
      expect(sample.outcome).toBe("ok");
      expect(sample.operations.put).toBe(2);
      expect(sample.operations.list).toBe(0);
      expect(sample.operations.put_body_bytes).toBeGreaterThan(result.snapshot_bytes);
      expect(sample.thread_cpu_ms).toBeGreaterThanOrEqual(0);
      expect(sample.process_cpu_ms).toBeGreaterThanOrEqual(0);
      expect(sample.sampled_heap_peak_bytes).toBeGreaterThanOrEqual(sample.heap_start_bytes);
    }
  });

  test("failed operations retain elapsed observations and attempted op counts", async () => {
    const storage = new MemoryStorage();
    storage.get = async () => {
      throw new Error("injected failure");
    };
    const sample = await measureInvocation(storage, async (inner) => {
      await inner.get("key");
    });
    expect(sample).toMatchObject({ outcome: "failed", operations: { get: 1, get_body_bytes: 0 } });
    expect(sample.error).not.toBeNull();
  });

  test("configured tail is physically seeded and fixture bytes are deterministic", async () => {
    const fixture = await buildFixture(4, 128, 2);
    const duplicate = await buildFixture(4, 128, 2);
    await expect(fixture.storage.get(FOLD_CURRENT_JSON_KEY)).resolves.toEqual(
      await duplicate.storage.get(FOLD_CURRENT_JSON_KEY),
    );
    await expect(
      fixture.storage.get("app/x/tenant/t/manifests/notes/log/5.json"),
    ).resolves.not.toBeNull();
    await expect(
      fixture.storage.get("app/x/tenant/t/manifests/notes/log/6.json"),
    ).resolves.toBeNull();
    await expect(buildFixture(0, 128)).rejects.toBeInstanceOf(RangeError);
  });
});

describe("persisted record schema", () => {
  test("validates round-trip evidence and rejects missing, corrupt or contradictory provenance", async () => {
    const record = recordFor(await runFoldCpuCell(cell, "get", "unprimed", 1, 1));
    expect(() => assertFoldCpuRecord(JSON.parse(JSON.stringify(record)))).not.toThrow();
    const corruptions: ((r: FoldCpuRecord) => void)[] = [
      (r) => {
        r.source.patch = "hidden patch";
      },
      (r) => {
        r.measurement_mode = "profile-instrumented";
      },
      (r) => {
        r.workload.operations = ["fold"];
      },
      (r) => {
        r.environment.logical_cores = 0;
      },
      (r) => {
        r.failures = 1;
      },
      (r) => {
        r.measurements[0]!.samples[0]!.thread_cpu_ms = -1;
      },
      (r) => {
        r.workload.repetitions = 2;
      },
      (r) => {
        r.end_load = load(20);
      },
      (r) => {
        r.margins.cpu_headroom_ms = 5;
      },
      (r) => {
        r.measurements[0]!.samples[0]!.outcome = "failed";
        r.failures = 1;
      },
    ];
    for (const corrupt of corruptions) {
      const copy = structuredClone(record);
      corrupt(copy);
      expect(() => assertFoldCpuRecord(copy)).toThrow(TypeError);
    }
    const { environment: _environment, ...missing } = record;
    expect(() => assertFoldCpuRecord(missing)).toThrow(TypeError);
  });

  test("caller supplied budgets produce arithmetic headroom including negative margins", async () => {
    const measured = await runFoldCpuCell(cell, "get", "unprimed", 1, 1);
    measured.samples[0]!.thread_cpu_ms = 12;
    measured.samples[0]!.latency_ms = 20;
    expect(computeMargins([measured], 10, 30)).toMatchObject({
      cpu_headroom_ms: -2,
      latency_headroom_ms: 10,
    });
  });
});

describe("operation-scoped CPU profiles", () => {
  test("selection rejects invalid operations and de-duplicates selected values", () => {
    expect(selectValues("get,fold,get", ["get", "all", "fold"])).toEqual(["get", "fold"]);
    for (const invalid of ["", "get,", "get,other"]) {
      expect(() => selectValues(invalid, ["get", "all", "fold"])).toThrow(RangeError);
    }
  });

  test("fixtures and warmups stay outside profiles; persistence follows stop", async () => {
    let active = false;
    const events: string[] = [];
    const original = fixtures.buildFixture;
    const spy = vi.spyOn(fixtures, "buildFixture").mockImplementation(async (...args) => {
      expect(active).toBe(false);
      events.push("fixture");
      return original(...args);
    });
    try {
      const result = await runFoldCpuCell(cell, "fold", "warmed", 2, 2, (identity) => {
        expect(identity).toMatchObject({ cell, operation: "fold", runtime_arm: "warmed" });
        return {
          async start() {
            expect(active).toBe(false);
            active = true;
            events.push("start");
          },
          async stop() {
            expect(active).toBe(true);
            active = false;
            events.push("stop");
          },
          async save() {
            expect(active).toBe(false);
            events.push("save");
          },
        };
      });
      expect(result.samples.every((sample) => sample.outcome === "ok")).toBe(true);
      expect(events).toEqual([
        "fixture",
        "fixture",
        "fixture",
        "start",
        "stop",
        "save",
        "fixture",
        "start",
        "stop",
        "save",
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  test("failed invocation still stops and persists its profile", async () => {
    const events: string[] = [];
    const result = await measureInvocation(
      new MemoryStorage(),
      async () => {
        events.push("invoke");
        throw new Error("injected failure");
      },
      {
        async start() {
          events.push("start");
        },
        async stop() {
          events.push("stop");
        },
        async save() {
          events.push("save");
        },
      },
    );
    expect(result.outcome).toBe("failed");
    expect(events).toEqual(["start", "invoke", "stop", "save"]);
  });

  test("weights self samples and counts recursive inclusive frames once per stack", () => {
    const frame = (functionName: string) => ({
      functionName,
      url: "file:///operation.ts",
      lineNumber: 3,
      columnNumber: 0,
      scriptId: "1",
    });
    const profile: Profiler.Profile = {
      startTime: 0,
      endTime: 80,
      nodes: [
        { id: 1, callFrame: frame("(root)"), children: [2] },
        { id: 2, callFrame: frame("recursive"), children: [3] },
        { id: 3, callFrame: frame("recursive"), children: [4] },
        { id: 4, callFrame: frame("leaf") },
      ],
      samples: [3, 4, 2],
      timeDeltas: [10, 20, 30],
    };
    expect(summarizeProfile(profile)).toMatchObject({
      samples: 3,
      sampled_us: 60,
      duration_us: 80,
      frames: [
        { function: "recursive", self_us: 40, inclusive_us: 60 },
        { function: "leaf", self_us: 20, inclusive_us: 20 },
        { function: "(root)", self_us: 0, inclusive_us: 60 },
      ],
    });
    expect(summarizeProfile({ ...profile, samples: [], timeDeltas: [] }).frames).toEqual([]);
  });

  test("inspector writes a readable profile linked to exact invocation identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fold-cpu-profile-"));
    const entries: ProfileEntry[] = [];
    const identity = {
      cell,
      operation: "get" as const,
      runtime_arm: "unprimed" as const,
      repetition: 0,
      snapshot_bytes: 12,
    };
    try {
      const profiler = createInvocationProfile(directory, identity, entries);
      const result = await measureInvocation(
        new MemoryStorage(),
        async () => {
          const end = performance.now() + 10;
          while (performance.now() < end) {
            // Give the 1 ms sampling profiler several operation samples.
          }
        },
        profiler,
      );
      expect(result.outcome).toBe("ok");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject(identity);
      const contents = await readFile(join(directory, entries[0]!.file), "utf8");
      expect(sha256(contents)).toBe(entries[0]!.sha256);
      const profile = JSON.parse(contents) as Profiler.Profile;
      expect(profile.nodes.length).toBeGreaterThan(0);
      expect(entries[0]!.summary).toEqual(summarizeProfile(profile));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("source patch reconstructs staged, unstaged and untracked measurement code", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "fold-cpu-provenance-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  try {
    git("init");
    await writeFile(join(cwd, "tracked.ts"), "base\n");
    git("add", "tracked.ts");
    git(
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--no-verify",
      "-m",
      "test fixture",
    );
    await writeFile(join(cwd, "tracked.ts"), "staged\n");
    git("add", "tracked.ts");
    await writeFile(join(cwd, "tracked.ts"), "unstaged final\n");
    await writeFile(join(cwd, "new.ts"), "measurement code\n");
    const source = captureSource(cwd);
    expect(source.dirty).toBe(true);
    expect(source.untracked_files).toEqual(["new.ts"]);
    expect(source.patch_sha256).toBe(sha256(source.patch));
    git("reset", "--hard", "HEAD");
    await rm(join(cwd, "new.ts"));
    execFileSync("git", ["apply", "-"], { cwd, input: source.patch });
    await expect(readFile(join(cwd, "tracked.ts"), "utf8")).resolves.toBe("unstaged final\n");
    await expect(readFile(join(cwd, "new.ts"), "utf8")).resolves.toBe("measurement code\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
