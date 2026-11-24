import { describe, expect, test } from "vitest";
import { fitLine, foldEventOf, joinSamples, parseJsonStream, report } from "./analyze.ts";
import { headKey, savedHeadKey } from "./cells.ts";
import {
  DEFAULT_SAMPLES,
  DEFAULT_WARMUP,
  parseRunOptions,
  sampleTag,
  uploadBatches,
} from "./drive.ts";

describe("driver", () => {
  test("run options: defaults, patterns and refusals", () => {
    const all = parseRunOptions([]);
    expect(all.samples).toBe(DEFAULT_SAMPLES);
    expect(all.warmup).toBe(DEFAULT_WARMUP);
    expect(all.cells).toHaveLength(48);
    const some = parseRunOptions(["--samples=3", "--warmup=0", "d1k5-ledger"]);
    expect(some).toMatchObject({ samples: 3, warmup: 0 });
    expect(some.cells.map((c) => c.name)).toEqual(["d1k5-ledger-r2", "d1k5-ledger-memory"]);
    expect(() => parseRunOptions(["--samples=0"])).toThrow(/--samples/);
    expect(() => parseRunOptions(["--warmup=-1"])).toThrow(/--warmup/);
    expect(() => parseRunOptions(["--bogus"])).toThrow(/Unknown option/);
    expect(() => parseRunOptions(["nope"])).toThrow(/no cell matches/);
  });

  test("tags are unique per run, cell and sample", () => {
    expect(sampleTag("r1", "d1k5-100-r2", 0)).not.toBe(sampleTag("r1", "d1k5-100-r2", 1));
    expect(sampleTag("r1", "d1k5-100-r2", 0)).not.toBe(sampleTag("r2", "d1k5-100-r2", 0));
  });

  test("upload batches cover every object once, within limits, head copy then head last", () => {
    const tenant = "d1k5";
    const objects: Record<string, string> = { [headKey(tenant)]: '{"head":1}' };
    for (let i = 0; i < 1000; i++) {
      objects[`app/tf/tenant/${tenant}/manifests/notes/log/${i}.json`] = "x".repeat(9000);
    }
    const batches = uploadBatches(tenant, objects);
    expect(batches.at(-1)).toEqual({ [headKey(tenant)]: '{"head":1}' });
    expect(batches.at(-2)).toEqual({ [savedHeadKey(tenant)]: '{"head":1}' });
    const body = batches.slice(0, -2);
    for (const b of body) {
      const keys = Object.keys(b);
      expect(keys.length).toBeLessThanOrEqual(400);
      expect(keys.reduce((n, k) => n + b[k]!.length, 0)).toBeLessThanOrEqual(4_000_000);
      expect(keys).not.toContain(headKey(tenant));
    }
    const uploaded = body.flatMap((b) => Object.keys(b));
    expect(uploaded).toHaveLength(1000);
    expect(new Set(uploaded).size).toBe(1000);
    expect(() => uploadBatches(tenant, {})).toThrow(/no head/);
  });
});

describe("analyzer", () => {
  const url = (cell: string, tag: string) =>
    `https://bench.example/bench/fold?cell=${cell}&tag=${encodeURIComponent(tag)}`;

  test("reads JSON Lines and concatenated pretty JSON, braces inside strings included", () => {
    const text = `{"a":1}\n{\n  "b": "}{\\"",\n  "c": [1, {"d": 2}]\n}\n{"e":3}`;
    expect(parseJsonStream(text)).toEqual([{ a: 1 }, { b: '}{"', c: [1, { d: 2 }] }, { e: 3 }]);
    expect(() => parseJsonStream('{"a":')).toThrow(/truncated/);
  });

  test("keeps only fold events, from raw tail events or normalized ones", () => {
    const raw = {
      outcome: "ok",
      cpuTime: 1234,
      wallTime: 5000,
      event: { request: { url: url("d1k5-100-r2", "r.d1k5-100-r2.1"), headers: { a: "b" } } },
    };
    const e = foldEventOf(raw)!;
    expect(e).toEqual({
      tag: "r.d1k5-100-r2.1",
      cell: "d1k5-100-r2",
      outcome: "ok",
      cpuTime: 1234,
      wallTime: 5000,
    });
    expect(foldEventOf(e)).toEqual(e);
    expect(foldEventOf({ event: { request: { url: "https://x/bench/reset?tenant=d1k5" } } })).toBe(
      null,
    );
    expect(foldEventOf({ event: { scheduledTime: 1 } })).toBe(null);
  });

  test("joins by tag, drops warmup, cold, failed and unmatched samples, and fits CPU per entry", () => {
    const line = (cell: string, sample: number, over: Record<string, unknown> = {}) => ({
      kind: "fold",
      cell,
      sample,
      tag: `r.${cell}.${sample}`,
      warmup: false,
      status: 200,
      clientMs: 100,
      cold: false,
      folded: cell.includes("-100-") ? 100 : 1000,
      ledgerCharged: 300,
      nodesWritten: 5,
      problem: null,
      ...over,
    });
    const lines = [
      { kind: "reset", deleted: 5, nodes: 57 },
      line("d1k5-100-memory", 0, { warmup: true }),
      line("d1k5-100-memory", 1),
      line("d1k5-100-memory", 2, { cold: true }),
      line("d1k5-1000-memory", 1),
      line("d1k5-1000-memory", 2, { status: 500 }),
      line("d1k5-1000-memory", 3),
    ];
    const cpu: Record<string, number> = {
      "r.d1k5-100-memory.1": 120,
      "r.d1k5-1000-memory.1": 1020,
    };
    const events = Object.entries(cpu).map(([tag, cpuTime]) => ({
      tag,
      cell: tag.split(".")[1]!,
      outcome: "ok",
      cpuTime,
      wallTime: null,
    }));
    const joined = joinSamples(lines, events);
    expect(joined.samples.map((s) => [s.cell, s.cpuMs])).toEqual([
      ["d1k5-100-memory", 120],
      ["d1k5-1000-memory", 1020],
    ]);
    expect(joined.dropped).toEqual({ warmup: 1, cold: 1, failed: 1, "no tail event": 1 });
    const lines2 = report(joined, {
      host: "test",
      samples: 1,
      warmup: 0,
      load: { before: 1, after: 1, cpus: 1 },
      cells: [
        {
          cell: "d1k5-1000-memory",
          n: 1,
          cpuMs: 255,
          cpuMsMin: 255,
          cpuMsMax: 255,
          folded: 1000,
          ledgerCharged: 300,
          nodesWritten: 5,
          entriesPerCpuSecond: 3922,
        },
      ],
    });
    expect(lines2.find((l) => l.startsWith("d1k5-1000-memory"))).toMatch(/255\s+4\.00$/);
    expect(lines2.find((l) => l.includes("d1k5-memory"))).toMatch(/a 20\.0 {2}b 1\.000\/entry/);
  });

  test("fitLine is exact on a line and refuses a single x", () => {
    expect(
      fitLine([
        [1, 5],
        [2, 7],
        [4, 11],
      ]),
    ).toEqual({ a: 3, b: 2 });
    expect(
      fitLine([
        [3, 1],
        [3, 2],
      ]),
    ).toBeNull();
  });
});
