/**
 * Node reference for the deployed cells: the identical fold tick
 * (`runFoldStep`) over the same fixture files, on in-memory storage behind
 * the adapter retry (the Worker's `memory` cells), recording the main
 * thread's CPU (`process.threadCpuUsage`, user + system) per tick. As in
 * the Worker, a sample loads a fresh bucket from the decoded fixture and
 * then folds, and both are timed.
 *
 *   pnpm bench:tree-fold-cpu:node-baseline [--samples=5] [--warmup=1] [--out=<file>] [cell...]
 *
 * Cells default to every `memory` cell; an `r2` cell is run on memory too.
 * Writes `out/node-baseline.json` and prints a table. Records the load
 * average before and after: a loaded machine inflates CPU, so read a loaded
 * baseline as an upper bound.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runAsCliEntrypoint } from "../measurement/cli-entrypoint.ts";
import { type Cell, CELLS, type FixtureManifest, selectCells } from "./cells.ts";
import { OUT_DIR } from "./fixtures.ts";
import { type FoldStepResult, memoryStorageOf, runFoldStep, sampleProblem } from "./fold-step.ts";

export interface NodeCellResult {
  readonly cell: string;
  readonly n: number;
  /** Median thread CPU per tick, ms. */
  readonly cpuMs: number;
  readonly cpuMsMin: number;
  readonly cpuMsMax: number;
  readonly folded: number;
  readonly ledgerCharged: number;
  readonly nodesWritten: number;
  /** Entries folded per CPU second, at the median. */
  readonly entriesPerCpuSecond: number;
}

export interface NodeBaseline {
  readonly host: string;
  readonly samples: number;
  readonly warmup: number;
  readonly load: {
    readonly before: number;
    readonly after: number;
    readonly cpus: number;
  };
  readonly cells: readonly NodeCellResult[];
}

export const median = (xs: readonly number[]): number => {
  if (xs.length === 0) {
    return Number.NaN;
  }
  const s = xs.toSorted((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const threadCpuMs = (): number => {
  const u = process.threadCpuUsage();
  return (u.user + u.system) / 1000;
};

const decoded = new Map<string, Map<string, Uint8Array>>();

/** The decoded fixture of `tenant`, from `out/fixtures/`, checked against the manifest. */
const fixtureObjects = (tenant: string, manifests: readonly FixtureManifest[]) => {
  let objects = decoded.get(tenant);
  if (objects === undefined) {
    const m = manifests.find((x) => x.tenant === tenant);
    if (m === undefined) {
      throw new Error(`no manifest for ${tenant}; run pnpm bench:tree-fold-cpu:fixtures`);
    }
    const json = JSON.parse(readFileSync(join(OUT_DIR, "fixtures", m.file), "utf8")) as Record<
      string,
      string
    >;
    const enc = new TextEncoder();
    objects = new Map(Object.entries(json).map(([k, v]) => [k, enc.encode(v)]));
    if (objects.size !== m.objects) {
      throw new Error(`${tenant}: fixture has ${objects.size} objects, manifest ${m.objects}`);
    }
    decoded.clear();
    decoded.set(tenant, objects);
  }
  return objects;
};

const runCell = async (
  cell: Cell,
  manifests: readonly FixtureManifest[],
  samples: number,
  warmup: number,
): Promise<NodeCellResult> => {
  const objects = fixtureObjects(cell.fixture.tenant, manifests);
  const cpu: number[] = [];
  let last: FoldStepResult | undefined;
  for (let i = 0; i < warmup + samples; i++) {
    const t0 = threadCpuMs();
    const result = await runFoldStep(await memoryStorageOf(objects), cell);
    const t1 = threadCpuMs();
    const problem = sampleProblem(cell, result);
    if (problem !== null) {
      throw new Error(`${cell.name}: ${problem}`);
    }
    if (i >= warmup) {
      cpu.push(t1 - t0);
    }
    last = result;
  }
  const cpuMs = median(cpu);
  return {
    cell: cell.name,
    n: cpu.length,
    cpuMs,
    cpuMsMin: Math.min(...cpu),
    cpuMsMax: Math.max(...cpu),
    folded: last!.folded,
    ledgerCharged: last!.ledgerCharged,
    nodesWritten: last!.nodesWritten,
    entriesPerCpuSecond: last!.folded / (cpuMs / 1000),
  };
};

const main = async (): Promise<number> => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      samples: { type: "string", default: "5" },
      warmup: { type: "string", default: "1" },
      out: { type: "string", default: join(OUT_DIR, "node-baseline.json") },
    },
  });
  const samples = Number(values.samples);
  const warmup = Number(values.warmup);
  if (!Number.isInteger(samples) || samples < 1 || !Number.isInteger(warmup) || warmup < 0) {
    throw new Error("--samples must be a positive integer and --warmup a non-negative one");
  }
  const cells =
    positionals.length === 0
      ? CELLS.filter((c) => c.storage === "memory")
      : selectCells(positionals);
  const manifests = JSON.parse(
    readFileSync(join(OUT_DIR, "manifest.json"), "utf8"),
  ) as FixtureManifest[];
  const before = loadavg()[0]!;
  const results: NodeCellResult[] = [];
  console.log(
    "cell                    n   cpu ms (min-max)        folded  ledger  nodes  entries/s",
  );
  for (const cell of cells) {
    const r = await runCell(cell, manifests, samples, warmup);
    results.push(r);
    console.log(
      `${r.cell.padEnd(22)} ${String(r.n).padStart(2)} ${r.cpuMs.toFixed(0).padStart(7)} (${r.cpuMsMin.toFixed(0)}-${r.cpuMsMax.toFixed(0)})`.padEnd(
        48,
      ) +
        `${String(r.folded).padStart(6)} ${String(r.ledgerCharged).padStart(7)} ${String(r.nodesWritten).padStart(6)} ${r.entriesPerCpuSecond.toFixed(0).padStart(10)}`,
    );
  }
  const baseline: NodeBaseline = {
    host: `${process.platform}-${process.arch} node ${process.version}`,
    samples,
    warmup,
    load: { before, after: loadavg()[0]!, cpus: cpus().length },
    cells: results,
  };
  writeFileSync(values.out, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(
    `load average ${baseline.load.before.toFixed(1)} -> ${baseline.load.after.toFixed(1)} on ${baseline.load.cpus} CPUs; wrote ${values.out}`,
  );
  return 0;
};

await runAsCliEntrypoint(import.meta.url, main);
