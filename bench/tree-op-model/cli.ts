/**
 * Print the tree op-count model's Paid and Free + R2 tables:
 *
 * 1. Paid: depths 0-3 of a Paid C/E collection (8 MiB / 32,768 rows)
 *    against the 9,000-request Paid ledger, per leaf target;
 * 2. Free + R2: the depth-0 tick and reads of a floor C/E collection
 *    (512 KiB / 2,048 rows) against the 900-request ledger;
 * 3. Free + R2 reads of the Paid C/E trees of table 1 (Free reads trees of
 *    any depth).
 *
 * Every row is printed happy path and with every attempt charged.
 *
 *   pnpm bench:tree-op-model [--leaf-bytes=16384,65536] [--min-fill=0.5]
 *     [--min-fanout=32] [--max-fanout=Infinity] [--t-bytes=524288]
 *     [--t-rows=2048] [--tail=<host default>] [--lag=128] [--neighbors=1]
 *     [--splits=1] [--write-read=point|scan] [--concurrent=0]
 *     [--sharing=distinct|shared]
 *
 * Pure arithmetic over `./model.ts`; no storage, no network.
 */
import { parseArgs } from "node:util";
import { MAINTENANCE_TAIL_HINT_REFRESH_WRITES } from "@baerly/protocol";
import { runAsCliEntrypoint } from "../measurement/cli-entrypoint.ts";
import {
  ALL_ATTEMPTS,
  assertSafeInteger,
  canonicalDepth,
  collectionShape,
  commitHoldRequests,
  DEFAULT_ASSUMPTIONS,
  FREE_R2_HOST,
  type HostProfile,
  hostPointReadVerdict,
  hostScanVerdict,
  HAPPY_PATH,
  internalNodeCount,
  LEAF_TARGET_SWEEP,
  PAID_HOST,
  type RetryPolicy,
  type Scenario,
  summarizeDepth,
  PROTOTYPE_TREE_DEFAULTS,
  type TreeParams,
  type Verdict,
  validateTreeParams,
} from "./model.ts";

const DEPTHS = [0, 1, 2, 3] as const;
const POLICIES: readonly (readonly [string, RetryPolicy])[] = [
  ["happy", HAPPY_PATH],
  ["all", ALL_ATTEMPTS],
];

const cell = (v: Verdict | null): string =>
  v === null ? "-" : `${v.charge.internal}${v.fits ? "" : "!"}`;

const pad = (s: string | number, w: number): string => String(s).padStart(w);

const rowNote = (depth: number, s: Scenario): string => {
  const canonical = canonicalDepth(s.params, s.host.collection);
  const shape = collectionShape(depth, s.params, s.host.collection);
  if (depth === canonical) {
    return "canonical";
  }
  if (depth === 0) {
    return "today's layout (over T)";
  }
  if (shape !== null && shape.fanout < s.params.minFanout) {
    return `fanout < ${s.params.minFanout}`;
  }
  return "";
};

/** Write-tick table: one row per depth and retry policy. */
const writeTable = (base: Omit<Scenario, "policy">, depths: readonly number[]): string[] => {
  const lines = [
    [
      pad("d", 2),
      pad("policy", 6),
      pad("F", 5),
      pad("leaves", 6),
      pad("nodes", 5),
      pad("read", 5),
      pad("scan", 6),
      pad("tick1", 5),
      pad("tickW", 6),
      pad("gc", 5),
      pad("budget", 6),
      pad("maxK", 5),
      " over",
      " note",
    ].join(" "),
  ];
  for (const depth of depths) {
    for (const [name, policy] of POLICIES) {
      const s: Scenario = { ...base, policy };
      const sum = summarizeDepth(depth, s);
      const shape = sum.shape;
      if (shape === null) {
        lines.push(`${pad(depth, 2)} ${pad(name, 6)}  (the collection does not reach this depth)`);
        continue;
      }
      lines.push(
        [
          pad(depth, 2),
          pad(name, 6),
          pad(shape.fanout, 5),
          pad(shape.leaves, 6),
          pad(internalNodeCount(shape), 5),
          pad(cell(sum.pointRead), 5),
          pad(cell(sum.scan), 6),
          pad(cell(sum.foldTick1), 5),
          pad(cell(sum.worstFoldTick), 6),
          pad(cell(sum.gcTick), 5),
          pad(sum.gcTick?.budget.internal ?? "-", 6),
          pad(sum.maxK, 5),
          sum.overBudget ? "  yes" : "   no",
          ` ${rowNote(depth, s)}`,
        ].join(" "),
      );
    }
  }
  return lines;
};

/** Reads of `base.host`'s collection on another host's ledger. */
const crossReadTable = (base: Omit<Scenario, "policy">, reader: HostProfile): string[] => {
  const lines = [[pad("d", 2), pad("policy", 6), pad("read", 5), pad("scan", 6)].join(" ")];
  for (const depth of DEPTHS) {
    const shape = collectionShape(depth, base.params, base.host.collection);
    for (const [name, policy] of POLICIES) {
      const s: Scenario = { ...base, policy };
      lines.push(
        [
          pad(depth, 2),
          pad(name, 6),
          pad(cell(shape === null ? null : hostPointReadVerdict(shape, s, reader.ledger)), 5),
          pad(cell(shape === null ? null : hostScanVerdict(shape, s, reader.ledger)), 6),
        ].join(" "),
      );
    }
  }
  return lines;
};

const numberOption = (name: string, value: string): number => {
  if (value.trim() === "") {
    throw new RangeError(`${name} must be a number`);
  }
  return Number(value);
};
const countOption = (name: string, value: string): number => {
  const count = numberOption(name, value);
  assertSafeInteger(count, name);
  return count;
};

const main = async (): Promise<number> => {
  const { values } = parseArgs({
    options: {
      "leaf-bytes": { type: "string", default: LEAF_TARGET_SWEEP.join(",") },
      "min-fill": { type: "string", default: String(PROTOTYPE_TREE_DEFAULTS.leafMinFill) },
      "min-fanout": { type: "string", default: String(PROTOTYPE_TREE_DEFAULTS.minFanout) },
      "max-fanout": { type: "string", default: String(PROTOTYPE_TREE_DEFAULTS.maxFanout) },
      "t-bytes": { type: "string", default: String(PROTOTYPE_TREE_DEFAULTS.depth0.bytes) },
      "t-rows": { type: "string", default: String(PROTOTYPE_TREE_DEFAULTS.depth0.rows) },
      tail: { type: "string" },
      lag: { type: "string", default: String(MAINTENANCE_TAIL_HINT_REFRESH_WRITES) },
      neighbors: {
        type: "string",
        default: String(DEFAULT_ASSUMPTIONS.neighborLeavesPerChangedLeaf),
      },
      splits: { type: "string", default: String(DEFAULT_ASSUMPTIONS.splitCreatesPerRewrittenNode) },
      "write-read": { type: "string", default: "point" },
      concurrent: { type: "string", default: "0" },
      sharing: { type: "string", default: "distinct" },
    },
  });
  const writeRead = values["write-read"];
  if (writeRead !== "point" && writeRead !== "scan") {
    throw new RangeError("write-read must be point or scan");
  }
  const sharing = values.sharing;
  if (sharing !== "shared" && sharing !== "distinct") {
    throw new RangeError("sharing must be shared or distinct");
  }
  const tail = values.tail === undefined ? undefined : countOption("tail", values.tail);
  const lag = countOption("lag", values.lag);
  const concurrent = countOption("concurrent", values.concurrent);
  const assumptions = {
    ...DEFAULT_ASSUMPTIONS,
    neighborLeavesPerChangedLeaf: countOption("neighbors", values.neighbors),
    splitCreatesPerRewrittenNode: countOption("splits", values.splits),
  };
  const leafSizes = values["leaf-bytes"]
    .split(",")
    .map((value) => numberOption("leaf-bytes", value));
  const paramsFor = (leafTargetBytes: number): TreeParams => ({
    leafTargetBytes,
    leafMinFill: numberOption("min-fill", values["min-fill"]),
    minFanout: numberOption("min-fanout", values["min-fanout"]),
    maxFanout: numberOption("max-fanout", values["max-fanout"]),
    depth0: {
      bytes: numberOption("t-bytes", values["t-bytes"]),
      rows: numberOption("t-rows", values["t-rows"]),
    },
  });
  for (const leafBytes of leafSizes) {
    validateTreeParams(paramsFor(leafBytes));
  }
  const scenarioFor = (host: HostProfile, params: TreeParams): Omit<Scenario, "policy"> => ({
    host,
    params,
    sharing,
    tailEntries: tail ?? host.tailEntries,
    tailHintLag: lag,
    concurrentCommits: concurrent,
    writeStateRead: writeRead,
    assumptions,
  });
  const hostLine = (h: HostProfile): string =>
    `${h.name}: ledger ${h.ledger.internal}, C/E ${h.collection.bytes} B / ` +
    `${h.collection.rows} rows, pass ${h.entriesPerPass} entries, GC ${h.gcSweeps} sweeps + ` +
    `${h.retirementDeletes} retirements, read tail ` +
    `${values.tail ?? h.tailEntries} entries.`;
  const p0 = paramsFor(leafSizes[0] ?? PROTOTYPE_TREE_DEFAULTS.leafTargetBytes);

  const out: string[] = [
    `Tree layout parameters (prototype starting values unless overridden): leaf target ` +
      `${leafSizes.join(" / ")} B, leaf min fill ${p0.leafMinFill}, min fanout ${p0.minFanout}, ` +
      `max fanout ${p0.maxFanout}, depth-0 rule T = ${p0.depth0.bytes} B / ${p0.depth0.rows} rows.`,
    `Unspecified-design assumptions: boundary neighbors/changed leaf ` +
      `${assumptions.neighborLeavesPerChangedLeaf}, split creates/rewritten node ` +
      `${assumptions.splitCreatesPerRewrittenNode}, GC membership ` +
      `${String(assumptions.gcMembershipGets)}, GC listed/live node ` +
      `${assumptions.gcListedObjectsPerLiveNode}, write state read ${writeRead}, ${sharing} paths, ` +
      `adoption readbacks/create ${HAPPY_PATH.adoptionReadbacksPerCreate} happy / ` +
      `${ALL_ATTEMPTS.adoptionReadbacksPerCreate} all.`,
    hostLine(PAID_HOST),
    hostLine(FREE_R2_HOST),
    `Fixed: tail_hint lag ${values.lag}, ${values.concurrent} concurrent commits during the ` +
      `fold's tail probe, GC under maximal pending contention, head CAS lost (closing hint ` +
      `refresh). Ledgers already carry the 10% margin; every tick budget also holds the write ` +
      `route and its commit hold (${commitHoldRequests()} = log create at every attempt + ` +
      `COMMIT_RESOLUTION_RESERVE).`,
    "Cells are requests charged; '!' = over budget. read/scan may spend the whole ledger. " +
      "tick1 = fold tick changing 1 leaf; tickW = worst fold tick, one full pass with every " +
      "entry in a distinct leaf (k = min(pass, leaves)); gc = worst GC tick; budget = what a " +
      "tick may spend; maxK = most changed leaves one fold tick fits. 'happy' = one attempt " +
      "per call; 'all' = every attempt charged plus one adoption readback per create.",
  ];
  for (const leafBytes of leafSizes) {
    const params = paramsFor(leafBytes);
    const paid = scenarioFor(PAID_HOST, params);
    out.push(
      "",
      `[1] Paid, Paid C/E, leaf target ${leafBytes} B ` +
        `(canonical depth ${canonicalDepth(params, PAID_HOST.collection)})`,
      ...writeTable(paid, DEPTHS),
    );
  }
  out.push(
    "",
    `[2] Free + R2, floor C/E, depth 0 (canonical depth ` +
      `${canonicalDepth(p0, FREE_R2_HOST.collection)} under T)`,
    ...writeTable(scenarioFor(FREE_R2_HOST, p0), [0]),
  );
  for (const leafBytes of leafSizes) {
    out.push(
      "",
      `[3] Free + R2 reads (ledger ${FREE_R2_HOST.ledger.internal}) of the Paid C/E trees, ` +
        `leaf target ${leafBytes} B`,
      ...crossReadTable(scenarioFor(PAID_HOST, paramsFor(leafBytes)), FREE_R2_HOST),
    );
  }
  console.log(out.join("\n"));
  return 0;
};

await runAsCliEntrypoint(import.meta.url, main);
