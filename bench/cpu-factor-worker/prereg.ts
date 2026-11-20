// Preregistration check for the deployed CPU capture.
//   pnpm bench:cpu-factor:analyze <events> [node-baseline.json] --prereg <file.json>
//
// The file declares the decision cells, the sample floor, the p99 threshold,
// the percentile method and the capture constants the harness records. There
// are no defaults: a missing or null field is an error. Any mismatch between
// the capture and the declaration is a FAIL with the reason, never a pass.
import {
  type Analysis,
  type CellRow,
  PERCENTILE_METHODS,
  type PercentileMethod,
} from "./analyze.ts";
import { CELL_BY_NAME } from "./src/cells.ts";

export interface Prereg {
  readonly decisionCells: readonly string[];
  readonly sampleFloor: number;
  readonly p99ThresholdMs: number;
  readonly percentileMethod: PercentileMethod;
  readonly capture: {
    /** Non-warmup requests per decision cell (`run-cells.sh` N). */
    readonly requestsPerCell: number;
    /** `&warmup=1` requests per decision cell (`run-cells.sh` sends 5). */
    readonly warmupsPerCell: number;
    /** Requests in flight (`run-cells.sh` `xargs -P`). Not observable in events. */
    readonly concurrency: number;
  };
}

const TOP_KEYS = new Set([
  "decisionCells",
  "sampleFloor",
  "p99ThresholdMs",
  "percentileMethod",
  "capture",
]);
const CAPTURE_KEYS = new Set(["requestsPerCell", "warmupsPerCell", "concurrency"]);

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/** Validate a parsed prereg file; throws one Error listing every problem. */
export const parsePrereg = (raw: unknown): Prereg => {
  const errs: string[] = [];
  if (!isRecord(raw)) {
    throw new Error("prereg: file must contain a JSON object");
  }
  for (const k of Object.keys(raw)) {
    if (!TOP_KEYS.has(k)) {
      errs.push(`unexpected field "${k}"`);
    }
  }
  const num = (v: unknown, name: string, integer: boolean, min: number) => {
    if (v === undefined || v === null) {
      errs.push(
        `${name} must be set (got ${v === null ? "null" : "nothing"}); the owner declares it`,
      );
    } else if (
      typeof v !== "number" ||
      !Number.isFinite(v) ||
      (integer && !Number.isInteger(v)) ||
      v < min
    ) {
      errs.push(
        `${name} must be ${integer ? "an integer" : "a number"} >= ${min} (got ${JSON.stringify(v)})`,
      );
    }
  };
  num(raw["sampleFloor"], "sampleFloor", true, 1);
  num(raw["p99ThresholdMs"], "p99ThresholdMs", false, Number.MIN_VALUE);
  const method = raw["percentileMethod"];
  if (!PERCENTILE_METHODS.includes(method as PercentileMethod)) {
    errs.push(
      `percentileMethod must be one of ${PERCENTILE_METHODS.join(", ")} (got ${JSON.stringify(method)})`,
    );
  }
  const cells = raw["decisionCells"];
  if (!Array.isArray(cells) || cells.length === 0 || cells.some((c) => typeof c !== "string")) {
    errs.push("decisionCells must be a non-empty array of cell names");
  } else {
    const seen = new Set<string>();
    for (const c of cells as string[]) {
      if (!Object.hasOwn(CELL_BY_NAME, c)) {
        errs.push(`decision cell "${c}" is not a known cell`);
      }
      if (seen.has(c)) {
        errs.push(`decision cell "${c}" is listed twice`);
      }
      seen.add(c);
    }
  }
  const cap = raw["capture"];
  if (!isRecord(cap)) {
    errs.push("capture must be an object of expected capture constants");
  } else {
    for (const k of Object.keys(cap)) {
      if (!CAPTURE_KEYS.has(k)) {
        errs.push(`unexpected capture constant "${k}"`);
      }
    }
    num(cap["requestsPerCell"], "capture.requestsPerCell", true, 1);
    num(cap["warmupsPerCell"], "capture.warmupsPerCell", true, 0);
    num(cap["concurrency"], "capture.concurrency", true, 1);
  }
  if (errs.length > 0) {
    throw new Error(`prereg: ${errs.join("; ")}`);
  }
  return raw as unknown as Prereg;
};

export interface DecisionRow {
  readonly cell: string;
  readonly row: CellRow | undefined;
  readonly present: boolean;
  /** Incomplete events (missing url, outcome or CPU time) attributed to this cell. */
  readonly incomplete: number;
  readonly pass: boolean;
  readonly reasons: string[];
}

export interface PreregVerdict {
  readonly pass: boolean;
  /** Run-level mismatches: each one forces FAIL whatever the cells did. */
  readonly failures: string[];
  readonly cells: DecisionRow[];
}

/** Apply the declared rule to an analysis made with `prereg.percentileMethod`. */
export const evaluatePrereg = (a: Analysis, p: Prereg): PreregVerdict => {
  const failures: string[] = [];
  if (a.method !== p.percentileMethod) {
    failures.push(
      `analysis used percentile method ${a.method}, prereg declares ${p.percentileMethod}`,
    );
  }
  const unattributed = a.incomplete.filter((i) => i.cell === null);
  if (unattributed.length > 0) {
    failures.push(
      `${unattributed.length} incomplete event(s) cannot be attributed to any cell, so none can be ruled out of a decision cell`,
    );
  }
  const cells = p.decisionCells.map((name): DecisionRow => {
    const row = a.rows.find((r) => r.cell.name === name);
    const reasons: string[] = [];
    const incomplete = a.incomplete.filter((i) => i.cell === name).length;
    const present = row !== undefined && row.invocations > 0;
    if (row === undefined || !present) {
      failures.push(`decision cell ${name} is absent from the capture`);
      return { cell: name, row, present: false, incomplete, pass: false, reasons: ["absent"] };
    }
    if (row.invocations !== p.capture.requestsPerCell) {
      failures.push(
        `${name}: ${row.invocations} non-warmup events, prereg expects ${p.capture.requestsPerCell} requests per cell`,
      );
    }
    if (row.warmups !== p.capture.warmupsPerCell) {
      failures.push(
        `${name}: ${row.warmups} warmup events, prereg expects ${p.capture.warmupsPerCell}`,
      );
    }
    if (incomplete > 0) {
      reasons.push(`${incomplete} event(s) missing url, outcome or cpuTime`);
      failures.push(`${name}: ${incomplete} event(s) missing url, outcome or cpuTime`);
    }
    if (row.killed > 0) {
      reasons.push(`${row.killed} killed`);
    }
    if (row.other > 0) {
      reasons.push(`${row.other} other outcome(s)`);
    }
    if (row.n < p.sampleFloor) {
      reasons.push(`n ok ${row.n} < floor ${p.sampleFloor}`);
    }
    if (!(row.d.p99 <= p.p99ThresholdMs)) {
      reasons.push(`p99 ${row.d.p99.toFixed(2)} ms > ${p.p99ThresholdMs} ms`);
    }
    return { cell: name, row, present, incomplete, pass: reasons.length === 0, reasons };
  });
  const anyPass = cells.some((c) => c.pass);
  if (!anyPass) {
    failures.push("no decision cell passes");
  }
  return { pass: failures.length === 0, failures, cells };
};

const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");

export const formatPrereg = (a: Analysis, p: Prereg, v: PreregVerdict): string => {
  const out: string[] = [
    "",
    "PREREGISTERED VERDICT",
    `Percentile method: ${p.percentileMethod === "r7" ? "R-7 (linear interpolation, Hyndman-Fan type 7)" : "nearest-rank"}`,
    `Declared: sample floor ${p.sampleFloor} ok; p99 threshold ${p.p99ThresholdMs} ms; ${p.capture.requestsPerCell} requests + ${p.capture.warmupsPerCell} warmups per cell; concurrency ${p.capture.concurrency} (not observable in the capture, taken as declared)`,
    "Rule per decision cell: no incomplete events, killed = 0, other = 0, n ok >= floor, p99 <= threshold. Overall: any decision cell passes and no run-level mismatch.",
    "cell | n ok | killed | other | missing outcome | incomplete | p99 ms | result",
  ];
  for (const c of v.cells) {
    const r = c.row;
    out.push(
      `${c.cell} | ${r?.n ?? 0} | ${r?.killed ?? 0} | ${r?.other ?? 0} | ${a.incomplete.filter((i) => i.cell === c.cell && i.missing.includes("outcome")).length} | ${c.incomplete} | ${f2(r?.d.p99 ?? Number.NaN)} | ${c.pass ? "PASS" : `FAIL (${c.reasons.join("; ")})`}`,
    );
  }
  out.push(
    `Incomplete events (missing url, outcome or cpuTime): ${a.incomplete.length}`,
    ...a.incomplete.map(
      (i) =>
        `  event #${i.index} cell ${i.cell ?? "(unattributed)"}: missing ${i.missing.join(", ")}`,
    ),
  );
  if (v.failures.length > 0) {
    out.push("Mismatches:", ...v.failures.map((f) => `  - ${f}`));
  }
  out.push(
    `Any decision cell passes: ${v.cells.some((c) => c.pass) ? "yes" : "no"}`,
    v.pass ? "PREREG VERDICT: PASS" : "PREREG VERDICT: FAIL",
  );
  return `${out.join("\n")}\n`;
};
