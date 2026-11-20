// CLI wrapper: pnpm bench:cpu-factor:analyze <events> [node-baseline.json] [--prereg[=]<file.json>]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, formatReport, type NodeBaseline, parseStream } from "./analyze.ts";
import {
  ANALYZE_USAGE,
  analyzeOptionsOf,
  evaluatePrereg,
  formatPrereg,
  parseAnalyzeArgs,
  parsePreregText,
  type Prereg,
} from "./prereg.ts";

const here = dirname(fileURLToPath(import.meta.url));
const args = parseAnalyzeArgs(process.argv.slice(2));
if ("error" in args) {
  console.error(`${args.error}\n${ANALYZE_USAGE}`);
  process.exit(2);
}
const { eventsPath, basePath = join(here, "out/node-baseline.json"), preregPath } = args;
let prereg: Prereg | undefined;
if (preregPath !== undefined) {
  try {
    prereg = parsePreregText(readFileSync(preregPath, "utf8"));
  } catch (error) {
    console.error(
      `PREREG VERDICT: FAIL (invalid preregistration file): ${(error as Error).message}`,
    );
    process.exit(1);
  }
}
let events: ReturnType<typeof parseStream>;
try {
  events = parseStream(readFileSync(eventsPath, "utf8"), { strict: prereg !== undefined });
} catch (error) {
  if (prereg === undefined) {
    throw error;
  }
  console.error(`PREREG VERDICT: FAIL (invalid capture): ${(error as Error).message}`);
  process.exit(1);
}
const base = JSON.parse(readFileSync(basePath, "utf8")) as NodeBaseline;
const a = analyze(events, base, prereg === undefined ? {} : analyzeOptionsOf(prereg));
if (a.missingCpu > 0 && a.rows.every((r) => r.n === 0)) {
  console.error(
    `No cpuTime found on ${a.missingCpu} events. This wrangler's tail output lacks cpuTime; export per-invocation CPU from Workers Observability instead (see README).`,
  );
  process.exit(1);
}
process.stdout.write(formatReport(a));
if (prereg !== undefined) {
  const verdict = evaluatePrereg(a, prereg);
  process.stdout.write(formatPrereg(a, prereg, verdict));
  if (!verdict.pass) {
    process.exit(1);
  }
}
