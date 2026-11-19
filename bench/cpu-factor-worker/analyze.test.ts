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
const makeEvents = (perCell = 60, factor = FACTOR) =>
  CELLS.flatMap((c, i) => {
    if (c.kind === "probe") {
      return [];
    }
    const cpu = factor * nodeP50(i);
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
    for (const kind of ["fold", "tree"]) {
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
    const a = analyze(makeEvents(60, 1), makeBaseline(QUIET));
    // Every tree cell sits well under 8 ms here, so the whole grid fits.
    // 3 leaf sizes x 3 depths shared, plus 3 x 2 distinct (no d = 1).
    expect(a.tree.maxLeaves.length).toBe(15);
    for (const m of a.tree.maxLeaves) {
      expect(m.underFree).toBe(8);
    }
  });

  test("groups tree rows by path mode and reports node counts", () => {
    // Distinct-path k = 8 cells run over Free's limit; the shared grid stays under.
    const cpuFor = (name: string) => (name.endsWith("-distinct") && name.includes("-k8-") ? 12 : 5);
    const events = makeEvents().map((e) => {
      const name = new URL(e.url).searchParams.get("cell")!;
      return name.startsWith("tree-") ? Object.assign({}, e, { cpuTime: cpuFor(name) }) : e;
    });
    const a = analyze(events, makeBaseline(QUIET));
    const shared = a.tree.maxLeaves.filter((m) => m.path === "shared");
    const distinct = a.tree.maxLeaves.filter((m) => m.path === "distinct");
    expect(shared).toHaveLength(9);
    expect(distinct).toHaveLength(6);
    expect(shared.every((m) => m.underFree === 8)).toBe(true);
    // k = 8 is over Free's limit, so the distinct groups stop at k = 4.
    expect(distinct.every((m) => m.underFree === 4 && m.d >= 2)).toBe(true);
    const row = (path: string, k: number, d: number) =>
      a.tree.rows.find((t) => t.path === path && t.k === k && t.bKiB === 16 && t.d === d)!;
    expect(row("shared", 4, 3).nodes).toBe(3);
    expect(row("distinct", 4, 3).nodes).toBe(9);
    expect(row("distinct", 8, 2).nodes).toBe(9);
    expect(row("shared", 8, 2).row.cell.name).toBe("tree-k8-b16-d2");
    expect(row("distinct", 8, 2).row.cell.name).toBe("tree-k8-b16-d2-distinct");
    const report = formatReport(a);
    expect(report).toContain("distinct | 4 | 16 | 3 | 9 |");
    expect(report).toContain("\n4 | 16 | 3 | 60 | 0 |");
    expect(report).toContain("DISTINCT paths");
    expect(report).toContain("distinct paths, leaf 16 KiB, d=3: <= 8 ms: 4");
  });

  test("distinct-path cells do not move the headline factors and get their own", () => {
    // Shared cells at FACTOR x node; distinct cells at 2x that.
    const events = makeEvents().map((e) => {
      const name = new URL(e.url).searchParams.get("cell")!;
      return name.endsWith("-distinct") ? Object.assign({}, e, { cpuTime: e.cpuTime * 2 }) : e;
    });
    const a = analyze(events, makeBaseline(QUIET));
    expect(a.factor.overall.p50).toBeCloseTo(FACTOR, 9);
    expect(a.factor.perKind["tree"]!.p50).toBeCloseTo(FACTOR, 9);
    expect(a.factor.perKind["tree"]!.n).toBe(36);
    expect(a.factor.distinct.p50).toBeCloseTo(FACTOR * 2, 9);
    expect(a.factor.distinct.n).toBe(24);
  });

  test("a capture without distinct cells reports them as not measured, not as 0", () => {
    const old = makeEvents(60, 1).filter(
      (e) => !new URL(e.url).searchParams.get("cell")!.endsWith("-distinct"),
    );
    const a = analyze(old, makeBaseline(QUIET));
    const distinct = a.tree.maxLeaves.filter((m) => m.path === "distinct");
    expect(distinct).toHaveLength(6);
    expect(distinct.every((m) => !m.measured)).toBe(true);
    expect(a.tree.maxLeaves.filter((m) => m.path === "shared").every((m) => m.measured)).toBe(true);
    const report = formatReport(a);
    expect(report).toContain("distinct paths, leaf 16 KiB, d=3: not measured");
    expect(report).not.toContain("distinct paths, leaf 16 KiB, d=3: <=");
  });

  test.each(["killed", "missing", "insufficient"] as const)(
    "%s deployed measurements cannot establish passing gates or sizes",
    (condition) => {
      const baseline = makeBaseline(QUIET);
      // Keep all estimates below PASS_MS, so only deployed evidence can
      // distinguish a valid pass from these failed or incomplete captures.
      const events = makeEvents(60, 1);
      const gateNames = new Set(CELLS.filter((c) => c.gate !== undefined).map((c) => c.name));
      const captured = events.filter((e) => {
        const name = new URL(e.url).searchParams.get("cell")!;
        return !gateNames.has(name);
      });
      for (const name of gateNames) {
        const n = { killed: 200, insufficient: 49, missing: 0 }[condition];
        for (let i = 0; i < n; i++) {
          captured.push({
            outcome: condition === "killed" ? "exceededCpu" : "ok",
            cpuTime: 1,
            url: `https://x.workers.dev/?cell=${name}`,
            logs: [],
          });
        }
      }
      const a = analyze(captured, baseline);
      expect(a.gate).toHaveLength(2);
      for (const gate of a.gate) {
        expect(gate.ms).toBeLessThan(8);
        expect(gate.pass).toBe(false);
      }
      expect(a.largestPassing).toEqual({ c: 256, e: 1024 });
      expect(formatReport(a)).toContain("=> FAIL");
    },
  );

  test("sufficient deployed measurements can establish passing gates and sizes", () => {
    const a = analyze(makeEvents(60, 1), makeBaseline(QUIET));
    expect(a.gate.every((g) => g.pass)).toBe(true);
    expect(a.largestPassing).toEqual({ c: 512, e: 2028 });
    expect(formatReport(a)).toContain("=> PASS");
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
