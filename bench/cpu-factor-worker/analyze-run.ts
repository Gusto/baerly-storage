// CLI wrapper: pnpm bench:cpu-factor:analyze <events> [node-baseline.json]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, formatReport, type NodeBaseline, parseStream } from "./analyze.ts";

const here = dirname(fileURLToPath(import.meta.url));
const [eventsPath, basePath = join(here, "out/node-baseline.json")] = process.argv.slice(2);
if (eventsPath === undefined) {
  console.error("usage: pnpm bench:cpu-factor:analyze <events> [node-baseline.json]");
  process.exit(2);
}
const events = parseStream(readFileSync(eventsPath, "utf8"));
const base = JSON.parse(readFileSync(basePath, "utf8")) as NodeBaseline;
const a = analyze(events, base);
if (a.missingCpu > 0 && a.rows.every((r) => r.n === 0)) {
  console.error(
    `No cpuTime found on ${a.missingCpu} events. This wrangler's tail output lacks cpuTime; export per-invocation CPU from Workers Observability instead (see README).`,
  );
  process.exit(1);
}
process.stdout.write(formatReport(a));
