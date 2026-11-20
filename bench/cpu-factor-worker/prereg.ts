// Preregistration check for the deployed CPU capture.
//   pnpm bench:cpu-factor:analyze <events> [node-baseline.json] --prereg <file.json>
//
// The file declares the decision cells, the sample floor, the p99 threshold,
// the percentile method and the capture constants the harness records. There
// are no defaults: a missing or null field is an error. Any mismatch between
// the capture and the declaration is a FAIL with the reason, never a pass.
import {
  type AnalyzeOptions,
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
  /**
   * Whether ok invocations that log `"cold":true` (first request in an
   * isolate) count toward n ok and p99. Cold kills count as kills either way.
   */
  readonly coldInvocations: ColdPolicy;
  readonly capture: {
    /** Non-warmup requests per decision cell (`run-cells.sh` N). */
    readonly requestsPerCell: number;
    /** `&warmup=1` requests per decision cell (`run-cells.sh` sends 5). */
    readonly warmupsPerCell: number;
    /** Requests in flight (`run-cells.sh` `xargs -P`). Not observable in events. */
    readonly concurrency: number;
  };
}

export type ColdPolicy = "exclude" | "include";
const COLD_POLICIES: readonly ColdPolicy[] = ["exclude", "include"];

const TOP_KEYS = new Set([
  "decisionCells",
  "sampleFloor",
  "p99ThresholdMs",
  "percentileMethod",
  "coldInvocations",
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
  const cold = raw["coldInvocations"];
  if (!COLD_POLICIES.includes(cold as ColdPolicy)) {
    errs.push(
      `coldInvocations must be one of ${COLD_POLICIES.join(", ")} (got ${JSON.stringify(cold)})`,
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
      } else if (CELL_BY_NAME[c]!.samples !== undefined) {
        errs.push(
          `decision cell "${c}" is sent ${CELL_BY_NAME[c]!.samples} times, not requestsPerCell; only uniformly sent cells can decide`,
        );
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
    const floor = raw["sampleFloor"];
    const n = cap["requestsPerCell"];
    if (typeof floor === "number" && typeof n === "number" && floor > n) {
      errs.push(
        `sampleFloor ${floor} exceeds capture.requestsPerCell ${n}, so no decision cell could pass`,
      );
    }
  }
  if (errs.length > 0) {
    throw new Error(`prereg: ${errs.join("; ")}`);
  }
  return raw as unknown as Prereg;
};

/**
 * Keys that occur twice in one JSON object, as dotted paths. `JSON.parse`
 * keeps the last value silently, so a file could declare two thresholds.
 */
export const duplicateKeys = (text: string): string[] => {
  const dups: string[] = [];
  // One frame per open container; `expectKey` marks where an object's next key starts.
  const stack: { obj: boolean; keys: Set<string>; path: string; expectKey: boolean }[] = [];
  let lastKey = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const top = stack.at(-1);
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        j += text[j] === "\\" ? 2 : 1;
      }
      if (top?.obj === true && top.expectKey) {
        let key: string;
        try {
          key = JSON.parse(text.slice(i, j + 1)) as string;
        } catch {
          return dups; // malformed; JSON.parse reports it
        }
        if (top.keys.has(key)) {
          dups.push(top.path === "" ? key : `${top.path}.${key}`);
        }
        top.keys.add(key);
        top.expectKey = false;
        lastKey = key;
      }
      i = j;
    } else if (ch === "{" || ch === "[") {
      let path = "";
      if (top !== undefined) {
        const parent = top.obj ? lastKey : "[]";
        path = top.path === "" ? parent : `${top.path}.${parent}`;
      }
      stack.push({ obj: ch === "{", keys: new Set(), path, expectKey: ch === "{" });
    } else if (ch === "}" || ch === "]") {
      stack.pop();
    } else if (ch === "," && top?.obj === true) {
      top.expectKey = true;
    }
  }
  return dups;
};

/** Parse and validate prereg file text; refuses duplicate keys. Throws on any problem. */
export const parsePreregText = (text: string): Prereg => {
  const dups = duplicateKeys(text);
  if (dups.length > 0) {
    throw new Error(`prereg: duplicate key(s) ${dups.map((k) => `"${k}"`).join(", ")}`);
  }
  return parsePrereg(JSON.parse(text));
};

export const ANALYZE_USAGE =
  "usage: pnpm bench:cpu-factor:analyze <events> [node-baseline.json] [--prereg <file.json> | --prereg=<file.json>]";

export type AnalyzeArgs =
  | { readonly eventsPath: string; readonly basePath?: string; readonly preregPath?: string }
  | { readonly error: string };

/**
 * Parse the analyzer's argv. `--prereg` takes `<file>` or `=<file>`; any
 * other flag is refused, so a mistyped flag can never drop the verdict.
 */
export const parseAnalyzeArgs = (argv: readonly string[]): AnalyzeArgs => {
  const positional: string[] = [];
  let preregPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    let value: string | undefined;
    if (arg === "--prereg") {
      value = argv[++i];
      if (value === undefined || value.startsWith("-")) {
        return { error: "--prereg needs a file argument" };
      }
    } else if (arg.startsWith("--prereg=")) {
      value = arg.slice("--prereg=".length);
      if (value === "") {
        return { error: "--prereg needs a file argument" };
      }
    } else if (arg.startsWith("-") && arg !== "-") {
      return { error: `unknown flag ${arg}` };
    } else {
      positional.push(arg);
      continue;
    }
    if (preregPath !== undefined) {
      return { error: "--prereg given more than once" };
    }
    preregPath = value;
  }
  if (positional.length === 0) {
    return { error: "missing <events>" };
  }
  if (positional.length > 2) {
    return { error: `unexpected argument ${positional[2]}` };
  }
  const [eventsPath, basePath] = positional as [string, string | undefined];
  return {
    eventsPath,
    ...(basePath === undefined ? {} : { basePath }),
    ...(preregPath === undefined ? {} : { preregPath }),
  };
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

const listed = (xs: readonly string[]) =>
  xs.length > 10 ? `${xs.slice(0, 10).join(", ")}, ... (${xs.length})` : xs.join(", ");

/**
 * `run-cells.sh` numbers a cell's requests `&i=1..N`. A decision cell's ids
 * must be exactly that set: a repeated id is a duplicated event line, which
 * could otherwise cancel a shortfall in the per-cell count.
 */
const requestIdMismatches = (name: string, row: CellRow, n: number): string[] => {
  const out: string[] = [];
  if (row.missingRequestId > 0) {
    out.push(
      `${name}: ${row.missingRequestId} event(s) without a request id (&i=), so duplicates cannot be ruled out`,
    );
  }
  const counts = new Map<string, number>();
  for (const id of row.requestIds) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const dup = [...counts].filter(([, c]) => c > 1).map(([id, c]) => `i=${id} x${c}`);
  if (dup.length > 0) {
    out.push(`${name}: duplicate request id(s) ${listed(dup)}`);
  }
  const outside = [...counts.keys()].filter((id) => !/^[1-9][0-9]*$/.test(id) || Number(id) > n);
  if (outside.length > 0) {
    out.push(`${name}: request id(s) outside 1..${n}: ${listed(outside.map((id) => `i=${id}`))}`);
  }
  return out;
};

/** Analyzer options a preregistration fixes. */
export const analyzeOptionsOf = (p: Prereg): AnalyzeOptions => ({
  method: p.percentileMethod,
  includeCold: p.coldInvocations === "include",
});

/** Apply the declared rule to an analysis made with `analyzeOptionsOf(prereg)`. */
export const evaluatePrereg = (a: Analysis, p: Prereg): PreregVerdict => {
  const failures: string[] = [];
  if (a.method !== p.percentileMethod) {
    failures.push(
      `analysis used percentile method ${a.method}, prereg declares ${p.percentileMethod}`,
    );
  }
  if (a.coldIncluded !== (p.coldInvocations === "include")) {
    failures.push(
      `analysis ${a.coldIncluded ? "included" : "excluded"} cold invocations, prereg declares ${p.coldInvocations}`,
    );
  }
  const unattributed = a.incomplete.filter((i) => i.cell === null);
  if (unattributed.length > 0) {
    failures.push(
      `${unattributed.length} incomplete event(s) cannot be attributed to any cell, so none can be ruled out of a decision cell`,
    );
  }
  if (a.unmatchedNonOk > 0) {
    failures.push(
      `${a.unmatchedNonOk} unmatched event(s) with a non-ok outcome; any of them may be a decision-cell kill whose cell could not be read`,
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
    failures.push(...requestIdMismatches(name, row, p.capture.requestsPerCell));
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
    `Percentile method (deployed CPU): ${p.percentileMethod === "r7" ? "R-7 (linear interpolation, Hyndman-Fan type 7)" : "nearest-rank"}; the Node baseline's percentiles are nearest-rank whatever is declared`,
    p.coldInvocations === "include"
      ? 'Cold invocations ("cold":true): INCLUDED in n ok and p99, as declared.'
      : 'Cold invocations ("cold":true): EXCLUDED from n ok and p99, as declared, so a slow cold start cannot fail a cell by p99; a killed cold invocation still counts as a kill. Events without the CPUFACTOR log line cannot be tagged cold and count as warm.',
    `Declared: sample floor ${p.sampleFloor} ok; p99 threshold ${p.p99ThresholdMs} ms; ${p.capture.requestsPerCell} requests + ${p.capture.warmupsPerCell} warmups per cell; concurrency ${p.capture.concurrency} (not observable in the capture, taken as declared)`,
    "Rule per decision cell: no incomplete events, killed = 0, other = 0, n ok >= floor, p99 <= threshold. Overall: any decision cell passes and no run-level mismatch.",
    "Warmups (&warmup=1) are excluded from every check by preregistration; their kills and other outcomes are listed, never counted.",
    "cell | n ok | killed | other | cold | missing outcome | incomplete | warmups killed / other | p99 ms | result",
  ];
  for (const c of v.cells) {
    const r = c.row;
    out.push(
      `${c.cell} | ${r?.n ?? 0} | ${r?.killed ?? 0} | ${r?.other ?? 0} | ${r?.cold ?? 0} | ${a.incomplete.filter((i) => i.cell === c.cell && i.missing.includes("outcome")).length} | ${c.incomplete} | ${r?.warmupKilled ?? 0} / ${r?.warmupOther ?? 0} | ${f2(r?.d.p99 ?? Number.NaN)} | ${c.pass ? "PASS" : `FAIL (${c.reasons.join("; ")})`}`,
    );
  }
  out.push(
    `Unmatched events: ${a.unmatched} (non-ok: ${a.unmatchedNonOk}). A non-ok one fails the run; an ok one is listed only, since the workers.dev URL is public.`,
    `Incomplete events (missing url, outcome or cpuTime): ${a.incomplete.length}`,
    ...a.incomplete.map(
      (i) =>
        `  event #${i.index} cell ${i.cell ?? "(unattributed)"}: missing ${i.missing.join(", ")}`,
    ),
  );
  const warmKills = v.cells.filter((c) => (c.row?.warmupKilled ?? 0) > 0);
  if (warmKills.length > 0) {
    out.push(
      `Note: ${warmKills.length} decision cell(s) had killed warmups (${warmKills.map((c) => c.cell).join(", ")}); excluded by preregistration, so they do not affect the verdict.`,
    );
  }
  if (v.failures.length > 0) {
    out.push("Mismatches:", ...v.failures.map((f) => `  - ${f}`));
  }
  out.push(
    `Any decision cell passes: ${v.cells.some((c) => c.pass) ? "yes" : "no"}`,
    v.pass ? "PREREG VERDICT: PASS" : "PREREG VERDICT: FAIL",
  );
  return `${out.join("\n")}\n`;
};
