// CLI wrapper: pnpm bench:cpu-factor:analyze <events> [node-baseline.json] [--prereg <file.json>]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, formatReport, type NodeBaseline, parseStream } from "./analyze.ts";
import { evaluatePrereg, formatPrereg, parsePrereg, type Prereg } from "./prereg.ts";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = argv.indexOf("--prereg");
let preregPath: string | undefined;
if (flag >= 0) {
  preregPath = argv[flag + 1];
  if (preregPath === undefined || preregPath.startsWith("--")) {
    console.error("--prereg needs a file argument");
    process.exit(2);
  }
  argv.splice(flag, 2);
}
const [eventsPath, basePath = join(here, "out/node-baseline.json")] = argv;
if (eventsPath === undefined) {
  console.error(
    "usage: pnpm bench:cpu-factor:analyze <events> [node-baseline.json] [--prereg <file.json>]",
  );
  process.exit(2);
}
let prereg: Prereg | undefined;
if (preregPath !== undefined) {
  try {
    prereg = parsePrereg(JSON.parse(readFileSync(preregPath, "utf8")));
  } catch (error) {
    console.error(
      `PREREG VERDICT: FAIL (invalid preregistration file): ${(error as Error).message}`,
    );
    process.exit(1);
  }
}
const events = parseStream(readFileSync(eventsPath, "utf8"));
const base = JSON.parse(readFileSync(basePath, "utf8")) as NodeBaseline;
const a = analyze(events, base, prereg === undefined ? {} : { method: prereg.percentileMethod });
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
