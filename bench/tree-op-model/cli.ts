/**
 * Print the tree op-count model's floor sweep: for each leaf size, depths
 * 0-3 of the floor collection (512 KiB / 2,048 rows) against the Workers
 * Free + R2 binding ledger, all attempts charged.
 *
 *   pnpm bench:tree-op-model [--leaf-bytes=65536,16384,4096,1024]
 *     [--min-fill=0.5] [--max-fanout=Infinity] [--tail=50] [--lag=128]
 *     [--neighbors=1] [--splits=1] [--write-read=point|scan] [--concurrent=0]
 *     [--happy]
 *
 * Pure arithmetic over `./model.ts`; no storage, no network.
 */
import { parseArgs } from "node:util";
import {
  MAINTENANCE_TAIL_HINT_REFRESH_WRITES,
  WRITE_TICK_MIN_ENTRIES_TO_COMPACT,
} from "@baerly/protocol";
import { runAsCliEntrypoint } from "../measurement/cli-entrypoint.ts";
import {
  ALL_ATTEMPTS,
  DEFAULT_ASSUMPTIONS,
  FLOOR_COLLECTION,
  FLOOR_PROFILE,
  floorFoldTickVerdict,
  FREE_LEDGER,
  HAPPY_PATH,
  internalNodeCount,
  type PathSharing,
  type Scenario,
  summarizeDepth,
  type Verdict,
} from "./model.ts";

const K_VALUES = [1, 2, 4, 8, 16, 32, 64, 128, 256] as const;
const DEPTHS = [0, 1, 2, 3] as const;

const cell = (v: Verdict | null): string =>
  v === null ? "-" : `${v.charge.internal}${v.fits ? "" : "!"}`;

const pad = (s: string | number, w: number): string => String(s).padStart(w);

const table = (s: Scenario): string[] => {
  const head = [
    pad("d", 2),
    pad("F", 4),
    pad("leaves", 6),
    pad("nodes", 5),
    pad("read", 5),
    pad("scan", 5),
    pad("gc", 5),
    pad("budget", 6),
    ...K_VALUES.map((k) => pad(`k=${k}`, 6)),
    pad("maxK", 5),
    " over",
  ].join(" ");
  const lines = [head];
  for (const depth of DEPTHS) {
    const sum = summarizeDepth(depth, s);
    const shape = sum.shape;
    if (shape === null) {
      lines.push(`${pad(depth, 2)}  (the floor collection does not reach this depth)`);
      continue;
    }
    const ticks = K_VALUES.map((k) =>
      k > shape.leaves ? pad("-", 6) : pad(cell(floorFoldTickVerdict(shape, k, s)), 6),
    );
    lines.push(
      [
        pad(depth, 2),
        pad(shape.fanout, 4),
        pad(shape.leaves, 6),
        pad(internalNodeCount(shape), 5),
        pad(cell(sum.pointRead), 5),
        pad(cell(sum.scan), 5),
        pad(cell(sum.gcTick), 5),
        pad(sum.gcTick?.budget.internal ?? "-", 6),
        ...ticks,
        pad(sum.maxK, 5),
        sum.overBudget ? "  yes" : "   no",
      ].join(" "),
    );
  }
  return lines;
};

const main = async (): Promise<number> => {
  const { values } = parseArgs({
    options: {
      "leaf-bytes": { type: "string", default: "65536,16384,4096,1024" },
      "min-fill": { type: "string", default: "0.5" },
      "max-fanout": { type: "string", default: "Infinity" },
      tail: { type: "string", default: String(WRITE_TICK_MIN_ENTRIES_TO_COMPACT) },
      lag: { type: "string", default: String(MAINTENANCE_TAIL_HINT_REFRESH_WRITES) },
      neighbors: {
        type: "string",
        default: String(DEFAULT_ASSUMPTIONS.neighborLeavesPerChangedLeaf),
      },
      splits: { type: "string", default: String(DEFAULT_ASSUMPTIONS.splitCreatesPerRewrittenNode) },
      "write-read": { type: "string", default: "point" },
      concurrent: { type: "string", default: "0" },
      happy: { type: "boolean", default: false },
    },
  });
  const writeRead = values["write-read"] === "scan" ? "scan" : "point";
  const assumptions = {
    ...DEFAULT_ASSUMPTIONS,
    neighborLeavesPerChangedLeaf: Number(values.neighbors),
    splitCreatesPerRewrittenNode: Number(values.splits),
  };
  const policy = values.happy ? HAPPY_PATH : ALL_ATTEMPTS;
  const out: string[] = [
    `Floor collection ${FLOOR_COLLECTION.bytes} B / ${FLOOR_COLLECTION.rows} rows; ` +
      `ledger ${FREE_LEDGER.internal} internal (R2 binding, 0 external); ` +
      `${values.happy ? "happy path" : "every attempt charged"}.`,
    `Fixed: tail ${values.tail} entries, tail_hint lag ${values.lag}, ` +
      `${values.concurrent} concurrent commits during the fold's tail probe, ` +
      `pass max(k, ${FLOOR_PROFILE.entriesPerPass}) entries, GC ${FLOOR_PROFILE.gcSweeps} sweeps + ` +
      `${FLOOR_PROFILE.retirementDeletes} retirements under maximal pending contention, ` +
      "head CAS lost (closing hint refresh).",
    `Unspecified-design parameters: leaf min fill ${values["min-fill"]}, max fanout ` +
      `${values["max-fanout"]}, boundary neighbors/changed leaf ${assumptions.neighborLeavesPerChangedLeaf}, ` +
      `split creates/rewritten node ${assumptions.splitCreatesPerRewrittenNode}, ` +
      `GC membership ${String(assumptions.gcMembershipGets)}, GC listed/live node ` +
      `${assumptions.gcListedObjectsPerLiveNode}, write state read ${writeRead}, ` +
      `adoption readbacks/create ${policy.adoptionReadbacksPerCreate}.`,
    "Cells are internal-pool requests; '!' = over budget. Tick cells are fold ticks with k changed " +
      "leaves; 'budget' is what a tick may spend: the ledger less the write route and its commit hold " +
      "(reads may spend the whole ledger).",
  ];
  for (const leafBytes of values["leaf-bytes"].split(",").map(Number)) {
    for (const sharing of ["distinct", "shared"] as PathSharing[]) {
      const scenario: Scenario = {
        sizing: {
          leafTargetBytes: leafBytes,
          leafMinFill: Number(values["min-fill"]),
          maxFanout: Number(values["max-fanout"]),
        },
        sharing,
        tailEntries: Number(values.tail),
        tailHintLag: Number(values.lag),
        concurrentCommits: Number(values.concurrent),
        writeStateRead: writeRead,
        policy,
        assumptions,
      };
      out.push("", `leaf target ${leafBytes} B, ${sharing} paths`, ...table(scenario));
    }
  }
  console.log(out.join("\n"));
  return 0;
};

await runAsCliEntrypoint(import.meta.url, main);
