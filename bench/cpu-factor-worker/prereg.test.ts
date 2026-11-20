import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { analyze, formatReport, type NodeBaseline, pct, pctR7 } from "./analyze.ts";
import {
  analyzeOptionsOf,
  evaluatePrereg,
  formatPrereg,
  parseAnalyzeArgs,
  parsePrereg,
  parsePreregText,
  duplicateKeys,
} from "./prereg.ts";
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
  coldInvocations: "exclude",
  capture: { requestsPerCell: 60, warmupsPerCell: 2, concurrency: 2 },
};

const url = (cell: string, extra = "") => `https://x.workers.dev/?cell=${cell}${extra}`;
interface Ev {
  outcome: string;
  cpuTime: number;
  url: string;
  logs?: unknown[];
}
/** Request `i` of a cell, as `run-cells.sh` sends it. */
const ev = (cell: string, i: number, cpu = 5, outcome = "ok"): Ev => ({
  outcome,
  cpuTime: cpu,
  url: url(cell, `&i=${i}`),
  logs: [],
});

/** A capture that satisfies PREREG on every decision cell. */
const goodEvents = (cells: readonly string[] = DECISION): Ev[] =>
  cells.flatMap((c) => [
    ...Array.from({ length: 2 }, () => ({ outcome: "ok", cpuTime: 99, url: url(c, "&warmup=1") })),
    ...Array.from({ length: 60 }, (_, i) => ev(c, i + 1)),
  ]);
/** Index of request `i` of `cell` in `goodEvents()`. */
const at = (events: readonly { url: string }[], cell: string, i: number) =>
  events.findIndex((e) => e.url === url(cell, `&i=${i}`));

const verdict = (events: object[], prereg: object = PREREG) => {
  const p = parsePrereg(prereg);
  const a = analyze(events, BASE, analyzeOptionsOf(p));
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
    const events = [1, 2, 3, 4].map((cpu, i) => ev("noop", i + 1, cpu));
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
    const { coldInvocations: _c, ...noCold } = PREREG;
    expect(() => parsePrereg(noCold)).toThrow(/coldInvocations must be one of exclude, include/);
    expect(() => parsePrereg({ ...PREREG, capture: { ...PREREG.capture, rate: 1 } })).toThrow(
      /unexpected capture constant "rate"/,
    );
  });
  test("accepts a complete file", () => {
    expect(parsePrereg(PREREG).sampleFloor).toBe(50);
    expect(parsePreregText(JSON.stringify(PREREG)).sampleFloor).toBe(50);
  });
  test("the committed example parses once floor and threshold are filled in", () => {
    const text = readFileSync(new URL("prereg.example.json", import.meta.url), "utf8");
    expect(() => parsePreregText(text)).toThrow(/sampleFloor must be set/);
    const filled = text.replace('"sampleFloor": null', '"sampleFloor": 50');
    expect(
      parsePreregText(filled.replace('"p99ThresholdMs": null', '"p99ThresholdMs": 8')),
    ).toEqual({ ...JSON.parse(text), sampleFloor: 50, p99ThresholdMs: 8 });
  });
  test("refuses a sample floor above the requests per cell", () => {
    expect(() =>
      parsePrereg({
        ...PREREG,
        sampleFloor: 61,
        capture: { ...PREREG.capture, requestsPerCell: 60 },
      }),
    ).toThrow(/sampleFloor 61 exceeds capture.requestsPerCell 60/);
    expect(parsePrereg({ ...PREREG, sampleFloor: 60 }).sampleFloor).toBe(60);
  });
  test("refuses duplicate keys at any depth, including escaped spellings", () => {
    const text = (inner: string) => JSON.stringify(PREREG).replace(/^\{/, `{${inner},`);
    expect(() => parsePreregText(text('"p99ThresholdMs":1000'))).toThrow(
      /duplicate key\(s\) "p99ThresholdMs"/,
    );
    expect(() => parsePreregText(text('"\\u0073ampleFloor":1'))).toThrow(/"sampleFloor"/);
    const nested = JSON.stringify(PREREG).replace('"capture":{', '"capture":{"concurrency":9,');
    expect(() => parsePreregText(nested)).toThrow(/duplicate key\(s\) "capture.concurrency"/);
    // The same key in sibling objects, and key-like strings in values or arrays, are not.
    expect(duplicateKeys('{"a":{"b":1},"c":{"b":2},"d":"\\"a\\":","e":["a","a",{"a":1}]}')).toEqual(
      [],
    );
    expect(duplicateKeys('{"e":[{"a":1,"a":2}]}')).toEqual(["e.[].a"]);
  });
  test("refuses decision cells the driver does not send requestsPerCell times", () => {
    expect(() => parsePrereg({ ...PREREG, decisionCells: ["probe-fetch"] })).toThrow(
      /decision cell "probe-fetch" is sent 5 times, not requestsPerCell/,
    );
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
    const events = goodEvents();
    events[at(events, DECISION[0]!, 4)] = ev(DECISION[0]!, 4, 10, "exceededCpu"); // one ok -> kill
    const { v } = verdict(events);
    expect(v.cells[0]!.pass).toBe(false);
    expect(v.cells[0]!.reasons.join()).toContain("1 killed");
    expect(v.cells.slice(1).every((c) => c.pass)).toBe(true);
    // One passing cell is enough, so the others carry the verdict ...
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
    const events = goodEvents();
    for (const c of DECISION) {
      const coldLog = [{ message: [`CPUFACTOR ${JSON.stringify({ cell: c, cold: true })}`] }];
      events[at(events, c, 1)]!.logs = coldLog; // one cold, excluded: 59 ok per cell
    }
    const { v } = verdict(events, { ...PREREG, sampleFloor: 60 });
    expect(v.pass).toBe(false);
    expect(v.cells[0]!.reasons).toEqual(["n ok 59 < floor 60"]);
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

  test("a duplicated event line FAILs even when it cancels a count shortfall", () => {
    const events = goodEvents();
    const target = DECISION[0]!;
    events[at(events, target, 7)] = ev(target, 8); // request 7 lost, request 8 twice
    const { v, a } = verdict(events);
    expect(a.rows.find((r) => r.cell.name === target)!.invocations).toBe(60);
    expect(v.failures).toEqual([`${target}: duplicate request id(s) i=8 x2`]);
    expect(v.pass).toBe(false);
  });

  test("a decision-cell event without a request id, or with one outside 1..N, FAILs", () => {
    const target = DECISION[0]!;
    const noId = goodEvents();
    noId[at(noId, target, 3)]!.url = url(target);
    expect(verdict(noId).v.failures).toEqual([
      `${target}: 1 event(s) without a request id (&i=), so duplicates cannot be ruled out`,
    ]);
    const outside = goodEvents();
    outside[at(outside, target, 60)]!.url = url(target, "&i=61");
    expect(verdict(outside).v.failures).toEqual([`${target}: request id(s) outside 1..60: i=61`]);
  });

  test("an unmatched non-ok event FAILs the run; an unmatched ok one is only listed", () => {
    const mangled = { outcome: "exceededCpu", cpuTime: 12, url: "https://x.workers.dev/?cel=x" };
    const killed = verdict([...goodEvents(), mangled]);
    expect(killed.v.failures).toEqual([
      "1 unmatched event(s) with a non-ok outcome; any of them may be a decision-cell kill whose cell could not be read",
    ]);
    expect(killed.v.pass).toBe(false);
    const stray = verdict([...goodEvents(), { ...mangled, outcome: "ok" }]);
    expect(stray.v.pass).toBe(true);
    expect(formatPrereg(stray.a, stray.p, stray.v)).toContain("Unmatched events: 1 (non-ok: 0)");
  });

  test("a killed warmup is reported but does not fail its decision cell", () => {
    const events = goodEvents();
    const target = DECISION[0]!;
    const warm = events.findIndex((e) => e.url === url(target, "&warmup=1"));
    events[warm] = { ...events[warm]!, outcome: "exceededCpu" };
    events[warm + 1] = { ...events[warm + 1]!, outcome: "exception" };
    const { v, a, p } = verdict(events);
    expect(v.cells[0]!.pass).toBe(true);
    expect(v.pass).toBe(true);
    const text = formatPrereg(a, p, v);
    expect(text).toContain(`${target} | 60 | 0 | 0 | 0 | 0 | 0 | 1 / 1 | 5.00 | PASS`);
    expect(text).toContain(`Note: 1 decision cell(s) had killed warmups (${target})`);
  });

  test("cold invocations: excluded or included from n ok and p99 as declared", () => {
    const target = DECISION[0]!;
    const events = goodEvents();
    const coldLog = [{ message: [`CPUFACTOR ${JSON.stringify({ cell: target, cold: true })}`] }];
    events[at(events, target, 1)] = { ...ev(target, 1, 30), logs: coldLog };
    const excluded = verdict(events);
    expect(excluded.v.cells[0]!.pass).toBe(true);
    expect(excluded.v.cells[0]!.row!.n).toBe(59);
    expect(excluded.v.cells[0]!.row!.cold).toBe(1);
    expect(formatPrereg(excluded.a, excluded.p, excluded.v)).toContain(
      'Cold invocations ("cold":true): EXCLUDED',
    );
    expect(formatReport(excluded.a)).not.toContain("COLD-INCLUSIVE");
    const included = verdict(events, { ...PREREG, coldInvocations: "include" });
    expect(included.v.cells[0]!.row!.n).toBe(60);
    expect(included.v.cells[0]!.reasons).toEqual(["p99 30.00 ms > 8 ms"]);
    expect(formatReport(included.a)).toContain("COLD-INCLUSIVE");
  });

  test("a killed cold invocation is a kill under either cold policy", () => {
    const target = DECISION[0]!;
    const events = goodEvents();
    const coldLog = [{ message: [`CPUFACTOR ${JSON.stringify({ cell: target, cold: true })}`] }];
    events[at(events, target, 1)] = { ...ev(target, 1, 12, "exceededCpu"), logs: coldLog };
    for (const coldInvocations of ["exclude", "include"]) {
      expect(verdict(events, { ...PREREG, coldInvocations }).v.cells[0]!.reasons).toEqual([
        "1 killed",
      ]);
    }
  });

  test("an analysis whose cold handling differs from the prereg FAILs", () => {
    const p = parsePrereg(PREREG);
    const a = analyze(goodEvents(), BASE, { includeCold: true });
    expect(evaluatePrereg(a, p).failures).toContain(
      "analysis included cold invocations, prereg declares exclude",
    );
  });

  test("boundaries: p99 equal to the threshold and n ok equal to the floor pass", () => {
    const target = DECISION[0]!;
    const events = goodEvents();
    events[at(events, target, 60)]!.cpuTime = 8; // nearest-rank p99 of 60 = the max
    const exact = verdict(events, { ...PREREG, sampleFloor: 60 });
    expect(exact.v.cells[0]!.row!.d.p99).toBe(8);
    expect(exact.v.cells[0]!.pass).toBe(true);
    expect(exact.v.pass).toBe(true);
    events[at(events, target, 60)]!.cpuTime = 8.01;
    expect(verdict(events).v.cells[0]!.reasons).toEqual(["p99 8.01 ms > 8 ms"]);
  });

  test("an other outcome fails its decision cell", () => {
    const target = DECISION[0]!;
    const events = goodEvents();
    events[at(events, target, 9)]!.outcome = "exception";
    const { v } = verdict(events, { ...PREREG, decisionCells: [target] });
    expect(v.cells[0]!.reasons).toEqual(["1 other outcome(s)"]);
    expect(v.failures).toEqual(["no decision cell passes"]);
  });

  test("a missing outcome reaches other, and is never an ok sample", () => {
    const target = DECISION[0]!;
    const events: Partial<Ev>[] = goodEvents();
    delete events[at(goodEvents(), target, 9)]!.outcome;
    const { v, a } = verdict(events, { ...PREREG, decisionCells: [target] });
    expect(a.missingOutcome).toBe(1);
    expect(v.cells[0]!.row!.other).toBe(1);
    expect(v.cells[0]!.row!.n).toBe(59);
    expect(v.cells[0]!.reasons).toEqual([
      "1 event(s) missing url, outcome or cpuTime",
      "1 other outcome(s)",
    ]);
  });

  test("without prereg the report is unchanged by incomplete tracking", () => {
    const a = analyze(goodEvents(), BASE);
    expect(a.method).toBe("nearest-rank");
  });
});

describe("parseAnalyzeArgs", () => {
  test("accepts --prereg <file> and --prereg=<file> anywhere", () => {
    const want = { eventsPath: "e.jsonl", basePath: "b.json", preregPath: "p.json" };
    expect(parseAnalyzeArgs(["e.jsonl", "b.json", "--prereg", "p.json"])).toEqual(want);
    expect(parseAnalyzeArgs(["e.jsonl", "b.json", "--prereg=p.json"])).toEqual(want);
    expect(parseAnalyzeArgs(["--prereg=p.json", "e.jsonl", "b.json"])).toEqual(want);
    expect(parseAnalyzeArgs(["e.jsonl"])).toEqual({ eventsPath: "e.jsonl" });
  });
  test("refuses unknown flags, a missing or repeated --prereg, and extra arguments", () => {
    for (const [argv, error] of [
      [["e.jsonl", "--perreg=p.json"], "unknown flag --perreg=p.json"],
      [["e.jsonl", "-p"], "unknown flag -p"],
      [["e.jsonl", "--prereg"], "--prereg needs a file argument"],
      [["e.jsonl", "--prereg="], "--prereg needs a file argument"],
      [["e.jsonl", "--prereg", "--x"], "--prereg needs a file argument"],
      [["e.jsonl", "--prereg=a", "--prereg", "b"], "--prereg given more than once"],
      [["e.jsonl", "b.json", "c"], "unexpected argument c"],
      [["--prereg=p.json"], "missing <events>"],
    ] as const) {
      expect(parseAnalyzeArgs(argv)).toEqual({ error });
    }
  });
});
