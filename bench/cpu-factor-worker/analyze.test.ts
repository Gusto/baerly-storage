import { describe, expect, test } from "vitest";
import { analyze, formatReport, type NodeBaseline, parseStream } from "./analyze.ts";
import { CELLS } from "./src/cells.ts";

const FACTOR = 7.5;
const QUIET = { loadavgBefore: 0.1, loadavgAfter: 0.1, cpus: 8, loaded: false };

/** Node p50 per cell: deterministic and above the analyzer's 0.5 ms floor. */
const nodeP50 = (i: number) => 0.6 + i * 0.01;

const makeBaseline = (load: NodeBaseline["load"]): NodeBaseline => ({
  host: "test-host",
  samples: 200,
  cells: Object.fromEntries(
    CELLS.flatMap((c, i) =>
      c.kind === "probe" ? [] : [[c.name, { p50: nodeP50(i), p99: nodeP50(i) * 1.5, n: 200 }]],
    ),
  ),
  ...(load === undefined ? {} : { load }),
});

/** Deployed events whose CPU is exactly FACTOR x the Node p50. */
const makeEvents = (perCell = 60) =>
  CELLS.flatMap((c, i) => {
    if (c.kind === "probe") {
      return [];
    }
    const cpu = FACTOR * nodeP50(i);
    return Array.from({ length: perCell }, () => ({
      outcome: "ok",
      cpuTime: cpu,
      url: `https://x.workers.dev/?cell=${c.name}`,
      logs: [{ message: [`CPUFACTOR ${JSON.stringify({ cell: c.name, cold: false })}`] }],
    }));
  });

describe("analyze", () => {
  test("recovers an injected factor from a quiet baseline and is not exploratory", () => {
    const a = analyze(makeEvents(), makeBaseline(QUIET));
    expect(a.exploratory).toBe(false);
    expect(a.factor.overall.p50).toBeCloseTo(FACTOR, 9);
    // Node p99 is 1.5x its p50 in this baseline.
    expect(a.factor.overall.p99).toBeCloseTo(FACTOR / 1.5, 9);
    for (const kind of ["subject", "fold", "tree"]) {
      expect(a.factor.perKind[kind]!.p50).toBeCloseTo(FACTOR, 9);
    }
    expect(formatReport(a)).not.toContain("EXPLORATORY");
  });

  test("labels a loaded baseline exploratory", () => {
    const a = analyze(
      makeEvents(),
      makeBaseline({ loadavgBefore: 6, loadavgAfter: 7, cpus: 8, loaded: true }),
    );
    expect(a.exploratory).toBe(true);
    expect(a.exploratoryReasons.join()).toContain("under load");
    expect(a.factor.overall.p50).toBeCloseTo(FACTOR, 9);
    expect(formatReport(a)).toContain("EXPLORATORY");
  });

  test("labels a baseline with no recorded load exploratory", () => {
    const a = analyze(makeEvents(), makeBaseline(undefined));
    expect(a.exploratory).toBe(true);
    expect(a.exploratoryReasons.join()).toContain("no load average");
  });

  test("drops warm-ups and cold invocations, counts killed cells out of the factor", () => {
    const events = makeEvents();
    const target = CELLS.find((c) => c.kind === "tree" && c.tree!.k === 8)!;
    const i = CELLS.indexOf(target);
    const url = `https://x.workers.dev/?cell=${target.name}`;
    events.push(
      { outcome: "ok", cpuTime: 999, url: `${url}&warmup=1`, logs: [] },
      {
        outcome: "ok",
        cpuTime: 999,
        url,
        logs: [{ message: [`CPUFACTOR ${JSON.stringify({ cold: true })}`] }],
      },
    );
    // Killed on Free: 10% of requests exceed CPU, so the cell does not fit.
    for (let n = 0; n < 10; n++) {
      events.push({ outcome: "exceededCpu", cpuTime: 10, url, logs: [] });
    }
    const a = analyze(events, makeBaseline(QUIET));
    const row = a.rows.find((r) => r.cell.name === target.name)!;
    expect(row.n).toBe(60);
    expect(row.cold).toBe(1);
    expect(row.killed).toBe(10);
    expect(row.fits).toBe(false);
    expect(row.d.p50).toBeCloseTo(FACTOR * nodeP50(i), 9);
    expect(a.factor.overall.p50).toBeCloseTo(FACTOR, 9);
  });

  test("reports leaves per step that fit from direct deployed CPU", () => {
    const a = analyze(makeEvents(), makeBaseline(QUIET));
    // Every tree cell sits well under 8 ms here, so the whole grid fits.
    expect(a.tree.maxLeaves.length).toBe(9);
    for (const m of a.tree.maxLeaves) {
      expect(m.underFree).toBe(8);
    }
  });

  test("summarizes S1 probe results from log lines", () => {
    const probeEvent = (probe: unknown) => ({
      outcome: "ok",
      cpuTime: 1,
      cell: "probe-r2-head",
      logs: [{ message: [`CPUFACTOR ${JSON.stringify({ cell: "probe-r2-head", probe })}`] }],
    });
    const failed = {
      probe: "r2-head",
      attempted: 51,
      completed: 50,
      failedAt: 51,
      error: { name: "Error", message: "Too many subrequests" },
    };
    const a = analyze(
      [
        probeEvent(failed),
        probeEvent(failed),
        probeEvent({ ...failed, failedAt: null, error: null, completed: 60 }),
      ],
      makeBaseline(QUIET),
    );
    const p = a.probes["r2-head"]!;
    expect(p.runs).toBe(3);
    expect(p.failedAt).toEqual([51, 51]);
    expect(p.cleanRuns).toBe(1);
    expect(p.errors).toEqual(["Error: Too many subrequests"]);
    expect(formatReport(a)).toContain("first failing call 51,51");
  });
});

describe("parseStream", () => {
  test("parses concatenated and line-delimited JSON, skipping noise", () => {
    expect(parseStream('{"a":1}\n{"b":"}"}\nnoise {not json}\n{"c":{"d":2}}')).toEqual([
      { a: 1 },
      { b: "}" },
      { c: { d: 2 } },
    ]);
  });
});
