import { describe, expect, test } from "vitest";
import { analyze, type NodeBaseline, pct, pctR7 } from "./analyze.ts";
import { evaluatePrereg, formatPrereg, parsePrereg } from "./prereg.ts";
import { CELLS } from "./src/cells.ts";

const DECISION = CELLS.filter(
  (c) => c.kind === "tree" && c.tree!.path === "distinct" && c.tree!.d === 2,
).map((c) => c.name);

const BASE: NodeBaseline = { host: "h", samples: 1, cells: {} };

const PREREG = {
  decisionCells: DECISION,
  sampleFloor: 50,
  p99ThresholdMs: 8,
  percentileMethod: "nearest-rank",
  capture: { requestsPerCell: 60, warmupsPerCell: 2, concurrency: 2 },
};

const url = (cell: string, extra = "") => `https://x.workers.dev/?cell=${cell}${extra}`;
const ev = (cell: string, cpu = 5, outcome = "ok") => ({
  outcome,
  cpuTime: cpu,
  url: url(cell),
  logs: [],
});

/** A capture that satisfies PREREG on every decision cell. */
const goodEvents = (cells: readonly string[] = DECISION) =>
  cells.flatMap((c) => [
    ...Array.from({ length: 2 }, () => ({ outcome: "ok", cpuTime: 99, url: url(c, "&warmup=1") })),
    ...Array.from({ length: 60 }, () => ev(c)),
  ]);

const verdict = (events: object[], prereg: object = PREREG) => {
  const p = parsePrereg(prereg);
  const a = analyze(events, BASE, { method: p.percentileMethod });
  return { a, p, v: evaluatePrereg(a, p) };
};

describe("percentile methods", () => {
  const xs = [10, 1, 5, 2, 8, 3, 9, 4, 7, 6];
  test("R-7 interpolates linearly between order statistics", () => {
    // sorted 1..10: h = (n-1)p => p50 4.5, p90 8.1, p99 8.91
    expect(pctR7(xs, 50)).toBeCloseTo(5.5, 12);
    expect(pctR7(xs, 90)).toBeCloseTo(9.1, 12);
    expect(pctR7(xs, 99)).toBeCloseTo(9.91, 12);
    expect(pctR7(xs, 0)).toBe(1);
    expect(pctR7(xs, 100)).toBe(10);
    expect(pctR7([7], 99)).toBe(7);
    expect(pctR7([], 50)).toBeNaN();
  });
  test("nearest-rank stays the default and differs from R-7", () => {
    expect(pct(xs, 90)).toBe(9);
    expect(pct(xs, 50)).toBe(5);
    const events = [1, 2, 3, 4].map((cpu) => ev("noop", cpu));
    expect(analyze(events, BASE).rows.find((r) => r.cell.name === "noop")!.d.p50).toBe(2);
    expect(
      analyze(events, BASE, { method: "r7" }).rows.find((r) => r.cell.name === "noop")!.d.p50,
    ).toBe(2.5);
  });
});

describe("parsePrereg", () => {
  test("refuses null threshold and floor (the committed example is a placeholder)", () => {
    expect(() => parsePrereg({ ...PREREG, p99ThresholdMs: null })).toThrow(
      /p99ThresholdMs must be set/,
    );
    expect(() => parsePrereg({ ...PREREG, sampleFloor: null })).toThrow(/sampleFloor must be set/);
  });
  test("refuses missing fields, unknown fields, unknown cells and unknown methods", () => {
    const { sampleFloor: _, ...noFloor } = PREREG;
    expect(() => parsePrereg(noFloor)).toThrow(/sampleFloor/);
    expect(() => parsePrereg({ ...PREREG, extra: 1 })).toThrow(/unexpected field "extra"/);
    expect(() => parsePrereg({ ...PREREG, decisionCells: ["nope"] })).toThrow(/not a known cell/);
    expect(() => parsePrereg({ ...PREREG, percentileMethod: "r8" })).toThrow(/percentileMethod/);
    expect(() => parsePrereg({ ...PREREG, capture: { ...PREREG.capture, rate: 1 } })).toThrow(
      /unexpected capture constant "rate"/,
    );
  });
  test("accepts a complete file", () => {
    expect(parsePrereg(PREREG).sampleFloor).toBe(50);
  });
});

describe("evaluatePrereg", () => {
  test("a clean capture passes", () => {
    const { v, a, p } = verdict(goodEvents());
    expect(v.failures).toEqual([]);
    expect(v.pass).toBe(true);
    expect(formatPrereg(a, p, v)).toContain("PREREG VERDICT: PASS");
  });

  test("missing decision cell: passes the analyzer's own rule but FAILs under prereg", () => {
    const events = goodEvents(DECISION.slice(1));
    const { v, a, p } = verdict(events);
    expect(a.rows.filter((r) => DECISION.slice(1).includes(r.cell.name)).every((r) => r.fits)).toBe(
      true,
    );
    expect(v.pass).toBe(false);
    expect(v.failures.join()).toContain(`decision cell ${DECISION[0]} is absent`);
    expect(formatPrereg(a, p, v)).toContain("PREREG VERDICT: FAIL");
  });

  test("a kill in a decision cell fails the run even though other cells pass", () => {
    const events = goodEvents().filter((_, i) => i !== 5); // drop one ok of cell 0 ...
    events.push(ev(DECISION[0]!, 10, "exceededCpu")); // ... replaced by a kill
    const { v } = verdict(events);
    expect(v.cells[0]!.pass).toBe(false);
    expect(v.cells[0]!.reasons.join()).toContain("1 killed");
    expect(v.cells.slice(1).every((c) => c.pass)).toBe(true);
    // F1 needs only one passing cell, so the others carry the verdict ...
    expect(v.pass).toBe(true);
    // ... but a prereg whose only decision cell took the kill FAILs.
    const only = verdict(events, { ...PREREG, decisionCells: [DECISION[0]!] });
    expect(only.v.pass).toBe(false);
    expect(only.v.failures).toContain("no decision cell passes");
  });

  test("fails when no cell passes: threshold applied as declared", () => {
    const { v } = verdict(goodEvents(), { ...PREREG, p99ThresholdMs: 4 });
    expect(v.pass).toBe(false);
    expect(v.failures).toContain("no decision cell passes");
  });

  test("floor applied as declared", () => {
    const { v } = verdict(goodEvents(), { ...PREREG, sampleFloor: 61 });
    expect(v.pass).toBe(false);
    expect(v.cells[0]!.reasons.join()).toContain("n ok 60 < floor 61");
  });

  test("unexpected capture constants fail loudly", () => {
    const { v } = verdict(goodEvents(), {
      ...PREREG,
      capture: { ...PREREG.capture, requestsPerCell: 200, warmupsPerCell: 5 },
    });
    expect(v.pass).toBe(false);
    expect(v.failures.join()).toContain("prereg expects 200 requests per cell");
    expect(v.failures.join()).toContain("prereg expects 5");
  });

  test("percentile method changes the p99 the rule sees", () => {
    // 60 samples: nearest-rank p99 = 60th value (max), R-7 p99 interpolates below it.
    const events = goodEvents();
    const target = DECISION[0]!;
    let i = 0;
    for (const e of events) {
      if (e.url.includes(`cell=${target}`) && !e.url.includes("warmup")) {
        e.cpuTime = i++ === 59 ? 8.4 : 5;
      }
    }
    const nr = verdict(events, { ...PREREG, p99ThresholdMs: 8 });
    const r7 = verdict(events, { ...PREREG, p99ThresholdMs: 8, percentileMethod: "r7" });
    expect(nr.v.cells[0]!.pass).toBe(false);
    expect(r7.v.cells[0]!.pass).toBe(true);
    expect(formatPrereg(r7.a, r7.p, r7.v)).toContain("R-7");
  });

  test("an event missing url, outcome or cpuTime is listed and fails its decision cell", () => {
    for (const drop of ["outcome", "cpuTime"] as const) {
      const events: any[] = goodEvents();
      const target = DECISION[0]!;
      const idx = events.findIndex(
        (e) => e.url.includes(`cell=${target}`) && !e.url.includes("warmup"),
      );
      const { [drop]: _, ...rest } = events[idx];
      events[idx] = rest;
      const { v, a, p } = verdict(events);
      expect(a.incomplete).toEqual([{ index: idx, cell: target, missing: [drop] }]);
      expect(v.cells[0]!.pass).toBe(false);
      expect(v.pass).toBe(false);
      expect(v.cells[0]!.reasons.join()).toContain("missing url, outcome or cpuTime");
      expect(formatPrereg(a, p, v)).toContain(`event #${idx} cell ${target}: missing ${drop}`);
    }
  });

  test("an event missing its url (cell field only) is incomplete; unattributable ones fail the run", () => {
    const events: any[] = goodEvents();
    events.push({ outcome: "ok", cpuTime: 1, cell: DECISION[1] });
    events.push({ outcome: "ok", cpuTime: 1 });
    const { v, a } = verdict(events);
    expect(a.incomplete.map((i) => i.missing)).toEqual([["url"], ["url"]]);
    expect(v.cells[1]!.pass).toBe(false);
    expect(v.failures.join()).toContain("cannot be attributed to any cell");
    expect(v.pass).toBe(false);
  });

  test("without prereg the report is unchanged by incomplete tracking", () => {
    const a = analyze(goodEvents(), BASE);
    expect(a.method).toBe("nearest-rank");
  });
});
