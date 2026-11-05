// Node reference for the deployed factor: drive the exact deployed bundle
// (dist/worker.js) in-process, one handler call per sample, and record the
// main thread's CPU (process.threadCpuUsage, user + system) per call.
//   pnpm bench:cpu-factor:node-baseline [samples=200] [out=out/node-baseline.json]
// Run it on a quiet machine. The file records the load average before and
// after the run; the analyzer labels a loaded or unrecorded baseline
// exploratory. Probe cells need Workers bindings and are skipped.
import { writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CELLS } from "./src/cells.ts";
import { LOADED_LOAD_PER_CPU, type NodeBaseline } from "./analyze.ts";

const here = dirname(fileURLToPath(import.meta.url));
const samples = Number(process.argv[2] ?? 200);
const outPath = process.argv[3] ?? join(here, "out/node-baseline.json");
const WARMUP = 10;

const workerModule = await import(pathToFileURL(join(here, "dist/worker.js")).href);
const worker = workerModule.default as {
  fetch: (request: Request) => Promise<Response>;
};

const cpuMs = () => {
  const u = process.threadCpuUsage();
  return (u.user + u.system) / 1000;
};
const pct = (xs: number[], p: number) => {
  const s = xs.toSorted((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
};

const load0 = loadavg()[0]!;
const out: NodeBaseline = {
  host: `${process.platform}-${process.arch} node ${process.version}`,
  samples,
  cells: {},
};
const log = console.log;
console.log = () => {}; // the handler's CPUFACTOR lines
for (const cell of CELLS) {
  if (cell.kind === "probe") {
    continue;
  }
  const xs: number[] = [];
  for (let i = 0; i < samples + WARMUP; i++) {
    const req = new Request(`https://bench.local/?cell=${cell.name}`);
    const t0 = cpuMs();
    const res = await worker.fetch(req);
    await res.text();
    const t1 = cpuMs();
    if (res.status !== 200) {
      throw new Error(`${cell.name}: HTTP ${res.status}`);
    }
    if (i >= WARMUP) {
      xs.push(t1 - t0);
    }
  }
  out.cells[cell.name] = { p50: pct(xs, 50), p90: pct(xs, 90), p99: pct(xs, 99), n: xs.length };
  process.stderr.write(
    `${cell.name}: p50 ${pct(xs, 50).toFixed(2)} p99 ${pct(xs, 99).toFixed(2)}\n`,
  );
}
console.log = log;
const load1 = loadavg()[0]!;
const ncpu = cpus().length;
out.load = {
  loadavgBefore: load0,
  loadavgAfter: load1,
  cpus: ncpu,
  loaded: Math.max(load0, load1) / ncpu >= LOADED_LOAD_PER_CPU,
};
writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${outPath}; loaded=${out.load.loaded}`);
