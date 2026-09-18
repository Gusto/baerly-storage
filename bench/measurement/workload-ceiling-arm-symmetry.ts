/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key field. */
/**
 * Workload-ceiling arm-symmetry probe.
 *
 * Measures the monolithic control and chunked candidate on one Node CPU axis:
 * a complete production read followed by the fold computation each arm runs.
 * Read validation is also decomposed into hash, JSON decode, and canonical
 * re-encode so the candidate-only integrity cost stays visible.
 *
 * The workerd column is NOT a measurement. It applies the inherited factors
 * from the deleted `05-workerd-ratio.ts` apparatus, as preserved in the
 * increase-workload-ceiling program ticket. The record labels that conversion
 * inherited and unverified; rebuilding that apparatus is separate work.
 *
 * MEASURES ONLY. This probe changes no format, planner, margin, or production
 * behavior. In particular, it does not weaken the chunk reader's canonical
 * re-encode check.
 */
import {
  MemoryStorage,
  SNAPSHOT_SCHEMA_VERSION,
  WRITE_TICK_FOLD_ENTRIES_PER_PASS,
  decodeJsonBytes,
  snapshotHash,
  type DocumentData,
  type LogEntry,
} from "@baerly/protocol";
import {
  encodeSnapshotBody,
  loadSnapshotAsMap,
  snapshotKey,
  type SnapshotBody,
} from "@baerly/server";
import {
  encodeSnapshotChunk,
  encodeSnapshotManifest,
  openSnapshotView,
  snapshotManifestKey,
  type SnapshotChunk,
  type SnapshotManifest,
} from "@baerly/server/_internal/testing";
import { planChunkedFold } from "../../packages/server/src/chunked-fold-planner.ts";
import { CHUNK_BOUNDARY_POLICIES } from "../../packages/server/src/snapshot-chunk-builder.ts";
import {
  WIN_MODEL_BUDGET,
  WIN_MODEL_CELLS,
  WIN_MODEL_COLLECTION,
  WIN_MODEL_COLLECTION_PREFIX,
  WIN_MODEL_DOCUMENT_BYTES,
  WIN_MODEL_INCARNATION,
  WIN_MODEL_SEEDS,
  buildRows,
  entriesOf,
  median,
  packedBase,
  rangeLabel,
  type PackedBase,
  type WinModelLocality,
} from "./workload-ceiling-win-model.ts";

export const ARM_SYMMETRY_VERSION = "baerly.workload-ceiling-arm-symmetry/v1" as const;
export const ARM_SYMMETRY_POLICY = "c128-r512" as const;
export const ARM_SYMMETRY_WARMUP_ITERATIONS = 3 as const;
export const ARM_SYMMETRY_MEASURE_ITERATIONS = 20 as const;
export const ARM_SYMMETRY_READ_SHAPE = "complete" as const;

export const WORKERD_CONVERSION_PROVENANCE = {
  status: "inherited-unverified",
  source:
    "docs/superpowers/programs/increase-workload-ceiling/plans/tickets/edit-scale-ceilings-workerd-factor.md; original driver 05-workerd-ratio.ts is deleted with no history",
  warning: "Converted workerd values are estimates, not measurements.",
  factors_by_cell: {
    "0.5MiB": 6.89,
    "1MiB": 8.55,
    "2MiB": 9.57,
    "4MiB": 8.91,
  },
} as const;

export type ArmSymmetryArm = "monolithic-control" | "chunked-candidate";

export interface TimingSummary {
  readonly median_ms: number;
  readonly range_ms: string;
}

export interface ArmSymmetryTrial {
  readonly iteration: number;
  readonly seed: number;
  readonly hash_ms: number;
  readonly decode_ms: number;
  readonly canonical_reencode_ms: number;
  readonly read_total_ms: number;
  readonly fold_ms: number;
  readonly invocation_ms: number;
  readonly fold_entries: number;
}

export interface ArmSymmetryRow {
  readonly cell: string;
  readonly locality: WinModelLocality;
  readonly arm: ArmSymmetryArm;
  readonly actual_snapshot_bytes: number;
  readonly read_shape: typeof ARM_SYMMETRY_READ_SHAPE;
  readonly chunk_fanout: number;
  readonly objects_read: number;
  readonly canonical_reencode_artifacts: number;
  readonly iterations: number;
  readonly hash: TimingSummary;
  readonly decode: TimingSummary;
  readonly canonical_reencode: TimingSummary;
  readonly read_total: TimingSummary;
  readonly fold: TimingSummary;
  readonly invocation: TimingSummary;
  readonly fold_entries_median: number;
  readonly read_delta_vs_control: TimingSummary;
  readonly fold_delta_vs_control: TimingSummary;
  readonly net_vs_control_node: TimingSummary;
  readonly net_vs_control_workerd_converted: TimingSummary;
  readonly workerd_conversion_factor: number;
  readonly trials: readonly ArmSymmetryTrial[];
}

export interface ArmSymmetryRecord {
  readonly version: typeof ARM_SYMMETRY_VERSION;
  readonly subject_commit: string;
  readonly node_version: string;
  readonly platform: string;
  readonly arch: string;
  readonly cpu_measurement: "process.cpuUsage-user-plus-system";
  readonly read_component_method: "standalone-production-primitives";
  readonly read_total_method: "production-read-path";
  readonly median_algorithm: "quantile-r7-v1";
  readonly policy: typeof ARM_SYMMETRY_POLICY;
  readonly mutations_per_fold: number;
  readonly warmup_iterations: number;
  readonly measure_iterations: number;
  readonly read_shape: typeof ARM_SYMMETRY_READ_SHAPE;
  readonly workerd_conversion: typeof WORKERD_CONVERSION_PROVENANCE;
  readonly rows: readonly ArmSymmetryRow[];
  readonly findings: readonly string[];
}

interface EncodedArtifact {
  readonly kind: "manifest" | "chunk";
  readonly bytes: Uint8Array;
  readonly parsed: SnapshotManifest | SnapshotChunk;
}

interface ProbeFixture {
  readonly storage: MemoryStorage;
  readonly rows: readonly DocumentData[];
  readonly packed: PackedBase;
  readonly monolithicKey: string;
  readonly monolithicBytes: Uint8Array;
  readonly manifestKey: string;
  readonly candidateArtifacts: readonly EncodedArtifact[];
}

interface Measured<T> {
  readonly value: T;
  readonly cpuMs: number;
}

const cpuMs = async <T>(operation: () => T | Promise<T>): Promise<Measured<T>> => {
  const start = process.cpuUsage();
  const value = await operation();
  const elapsed = process.cpuUsage(start);
  return { value, cpuMs: (elapsed.user + elapsed.system) / 1000 };
};

const assertEqualBytes = (left: Uint8Array, right: Uint8Array): void => {
  if (left.byteLength !== right.byteLength) {
    throw new Error("arm-symmetry: canonical re-encode length changed");
  }
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) {
      throw new Error("arm-symmetry: canonical re-encode bytes changed");
    }
  }
};

const buildFixture = async (
  rows: readonly DocumentData[],
  packed: PackedBase,
): Promise<ProbeFixture> => {
  const storage = new MemoryStorage();
  const monolithicBody: SnapshotBody = {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    min_seq: 0,
    max_seq: 0,
    collection: WIN_MODEL_COLLECTION,
    docs: rows.map((body) => ({ _id: body["_id"] as string, body })),
  };
  const monolithicBytes = encodeSnapshotBody(monolithicBody);
  const monolithicKey = snapshotKey(
    WIN_MODEL_COLLECTION_PREFIX,
    0,
    0,
    await snapshotHash(monolithicBytes),
  );
  await storage.put(monolithicKey, monolithicBytes);

  const chunkArtifacts: EncodedArtifact[] = [];
  for (const descriptor of packed.descriptors) {
    const docs = packed.loaded.get(descriptor.key);
    if (docs === undefined) {
      throw new Error(`arm-symmetry: packed fixture is missing ${descriptor.key}`);
    }
    const chunk: SnapshotChunk = {
      schema_version: 2,
      collection: WIN_MODEL_COLLECTION,
      incarnation: WIN_MODEL_INCARNATION,
      first_id: descriptor.first_id,
      last_id: descriptor.last_id,
      docs,
    };
    const bytes = encodeSnapshotChunk(chunk);
    const digest = await snapshotHash(bytes);
    if (!descriptor.key.endsWith(`/${digest}.json`)) {
      throw new Error("arm-symmetry: packed descriptor digest does not match its chunk body");
    }
    await storage.put(descriptor.key, bytes);
    chunkArtifacts.push({ kind: "chunk", bytes, parsed: chunk });
  }

  const manifest: SnapshotManifest = {
    schema_version: 2,
    collection: WIN_MODEL_COLLECTION,
    log_seq_start: 0,
    incarnation: WIN_MODEL_INCARNATION,
    collation: "utf8-scalar-v1",
    chunks: packed.descriptors,
  };
  const manifestBytes = encodeSnapshotManifest(manifest);
  const manifestKey = snapshotManifestKey(
    WIN_MODEL_COLLECTION_PREFIX,
    WIN_MODEL_INCARNATION,
    await snapshotHash(manifestBytes),
  );
  await storage.put(manifestKey, manifestBytes);

  return {
    storage,
    rows,
    packed,
    monolithicKey,
    monolithicBytes,
    manifestKey,
    candidateArtifacts: [
      { kind: "manifest", bytes: manifestBytes, parsed: manifest },
      ...chunkArtifacts,
    ],
  };
};

const measureHash = async (artifacts: readonly Uint8Array[]): Promise<number> => {
  const measured = await cpuMs(async () => {
    for (const bytes of artifacts) {
      await snapshotHash(bytes);
    }
  });
  return measured.cpuMs;
};

const measureDecode = async (artifacts: readonly Uint8Array[]): Promise<number> => {
  const measured = await cpuMs(() => {
    for (const bytes of artifacts) {
      decodeJsonBytes(bytes);
    }
  });
  return measured.cpuMs;
};

const measureCanonicalReencode = async (artifacts: readonly EncodedArtifact[]): Promise<number> => {
  const measured = await cpuMs(() => {
    for (const artifact of artifacts) {
      const encoded =
        artifact.kind === "manifest"
          ? encodeSnapshotManifest(artifact.parsed as SnapshotManifest)
          : encodeSnapshotChunk(artifact.parsed as SnapshotChunk);
      assertEqualBytes(artifact.bytes, encoded);
    }
  });
  return measured.cpuMs;
};

const compareIds = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const rebuildMonolithic = async (
  base: Map<string, DocumentData>,
  entries: readonly LogEntry[],
): Promise<void> => {
  for (const entry of entries) {
    if (entry.op === "D") {
      base.delete(entry.doc_id);
    } else if (entry.after !== undefined) {
      base.set(entry.doc_id, entry.after);
    }
  }
  const docs = [...base.entries()]
    .toSorted(([left], [right]) => compareIds(left, right))
    .map(([id, body]) => ({ _id: id, body }));
  const bytes = encodeSnapshotBody({
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    min_seq: 0,
    max_seq: entries.length,
    collection: WIN_MODEL_COLLECTION,
    docs,
  });
  await snapshotHash(bytes);
};

const measureControlTrial = async (
  fixture: ProbeFixture,
  entries: readonly LogEntry[],
  iteration: number,
  seed: number,
): Promise<ArmSymmetryTrial> => {
  const hashMs = await measureHash([fixture.monolithicBytes]);
  const decodeMs = await measureDecode([fixture.monolithicBytes]);
  const read = await cpuMs(() =>
    loadSnapshotAsMap(fixture.storage, fixture.monolithicKey, WIN_MODEL_COLLECTION),
  );
  const fold = await cpuMs(() => rebuildMonolithic(read.value, entries));
  return {
    iteration,
    seed,
    hash_ms: hashMs,
    decode_ms: decodeMs,
    canonical_reencode_ms: 0,
    read_total_ms: read.cpuMs,
    fold_ms: fold.cpuMs,
    invocation_ms: read.cpuMs + fold.cpuMs,
    fold_entries: entries.length,
  };
};

const measureCandidateTrial = async (
  fixture: ProbeFixture,
  entries: readonly LogEntry[],
  iteration: number,
  seed: number,
): Promise<ArmSymmetryTrial> => {
  const artifactBytes = fixture.candidateArtifacts.map((artifact) => artifact.bytes);
  const hashMs = await measureHash(artifactBytes);
  const decodeMs = await measureDecode(artifactBytes);
  const reencodeMs = await measureCanonicalReencode(fixture.candidateArtifacts);
  const read = await cpuMs(async () => {
    const view = await openSnapshotView({
      storage: fixture.storage,
      manifestKey: fixture.manifestKey,
      collection: WIN_MODEL_COLLECTION,
      expectedLogSeqStart: 0,
    });
    return view.materialize();
  });
  if (read.value.size !== fixture.rows.length) {
    throw new Error(
      `arm-symmetry: candidate materialized ${read.value.size} rows, expected ${fixture.rows.length}`,
    );
  }
  const fold = await cpuMs(() =>
    planChunkedFold({
      collection: WIN_MODEL_COLLECTION,
      collectionPrefix: WIN_MODEL_COLLECTION_PREFIX,
      entries,
      descriptors: fixture.packed.descriptors,
      loadedChunks: fixture.packed.loaded,
      budget: WIN_MODEL_BUDGET,
      incarnation: WIN_MODEL_INCARNATION,
      policy: CHUNK_BOUNDARY_POLICIES[ARM_SYMMETRY_POLICY],
      baseLogSeq: 0,
    }),
  );
  if (fold.value === null) {
    throw new Error("arm-symmetry: planChunkedFold admitted no mutation");
  }
  const admitted = entries.findIndex((entry) => entry.seq === fold.value!.log_seq_end) + 1;
  return {
    iteration,
    seed,
    hash_ms: hashMs,
    decode_ms: decodeMs,
    canonical_reencode_ms: reencodeMs,
    read_total_ms: read.cpuMs,
    fold_ms: fold.cpuMs,
    invocation_ms: read.cpuMs + fold.cpuMs,
    fold_entries: admitted,
  };
};

const summary = (values: readonly number[]): TimingSummary => ({
  median_ms: median(values),
  range_ms: rangeLabel(values),
});

const zeroSummary = (): TimingSummary => ({ median_ms: 0, range_ms: "0.00-0.00" });

export const buildRowsFromTrials = (input: {
  readonly cell: string;
  readonly locality: WinModelLocality;
  readonly actualSnapshotBytes: number;
  readonly chunkFanout: number;
  readonly workerdFactor: number;
  readonly control: readonly ArmSymmetryTrial[];
  readonly candidate: readonly ArmSymmetryTrial[];
}): readonly [ArmSymmetryRow, ArmSymmetryRow] => {
  if (input.control.length !== input.candidate.length || input.control.length === 0) {
    throw new Error("arm-symmetry: paired control/candidate trials must have equal nonzero length");
  }
  const summarizeArm = (
    arm: ArmSymmetryArm,
    trials: readonly ArmSymmetryTrial[],
    artifactCount: number,
    objectsRead: number,
    chunkFanout: number,
    readDelta: TimingSummary,
    foldDelta: TimingSummary,
    net: TimingSummary,
    workerdNet: TimingSummary,
  ): ArmSymmetryRow => ({
    cell: input.cell,
    locality: input.locality,
    arm,
    actual_snapshot_bytes: input.actualSnapshotBytes,
    read_shape: ARM_SYMMETRY_READ_SHAPE,
    chunk_fanout: chunkFanout,
    objects_read: objectsRead,
    canonical_reencode_artifacts: artifactCount,
    iterations: trials.length,
    hash: summary(trials.map((trial) => trial.hash_ms)),
    decode: summary(trials.map((trial) => trial.decode_ms)),
    canonical_reencode: summary(trials.map((trial) => trial.canonical_reencode_ms)),
    read_total: summary(trials.map((trial) => trial.read_total_ms)),
    fold: summary(trials.map((trial) => trial.fold_ms)),
    invocation: summary(trials.map((trial) => trial.invocation_ms)),
    fold_entries_median: median(trials.map((trial) => trial.fold_entries)),
    read_delta_vs_control: readDelta,
    fold_delta_vs_control: foldDelta,
    net_vs_control_node: net,
    net_vs_control_workerd_converted: workerdNet,
    workerd_conversion_factor: input.workerdFactor,
    trials,
  });

  const readDeltas = input.candidate.map(
    (trial, index) => trial.read_total_ms - input.control[index]!.read_total_ms,
  );
  const foldDeltas = input.candidate.map(
    (trial, index) => trial.fold_ms - input.control[index]!.fold_ms,
  );
  const netDeltas = input.candidate.map(
    (trial, index) => trial.invocation_ms - input.control[index]!.invocation_ms,
  );
  const zero = zeroSummary();
  return [
    summarizeArm("monolithic-control", input.control, 0, 1, 0, zero, zero, zero, zero),
    summarizeArm(
      "chunked-candidate",
      input.candidate,
      input.chunkFanout + 1,
      input.chunkFanout + 1,
      input.chunkFanout,
      summary(readDeltas),
      summary(foldDeltas),
      summary(netDeltas),
      summary(netDeltas.map((value) => value * input.workerdFactor)),
    ),
  ];
};

export const runArmSymmetryCell = async (input: {
  readonly cell: string;
  readonly rows: number;
  readonly documentBytes: number;
  readonly locality: WinModelLocality;
  readonly workerdFactor: number;
  readonly warmupIterations: number;
  readonly measureIterations: number;
}): Promise<readonly [ArmSymmetryRow, ArmSymmetryRow]> => {
  const baseRows = buildRows(input.rows, input.documentBytes);
  const packed = await packedBase(baseRows, CHUNK_BOUNDARY_POLICIES[ARM_SYMMETRY_POLICY]);
  const fixture = await buildFixture(baseRows, packed);
  const control: ArmSymmetryTrial[] = [];
  const candidate: ArmSymmetryTrial[] = [];
  const totalIterations = input.warmupIterations + input.measureIterations;

  for (let iteration = 0; iteration < totalIterations; iteration++) {
    const seed = WIN_MODEL_SEEDS[iteration % WIN_MODEL_SEEDS.length]! * 7919 + input.rows;
    const entries = entriesOf(
      baseRows,
      WRITE_TICK_FOLD_ENTRIES_PER_PASS,
      input.locality,
      seed,
      input.documentBytes,
    );
    const measureControlFirst = iteration % 2 === 0;
    const first = measureControlFirst ? measureControlTrial : measureCandidateTrial;
    const second = measureControlFirst ? measureCandidateTrial : measureControlTrial;
    const firstResult = await first(fixture, entries, iteration, seed);
    const secondResult = await second(fixture, entries, iteration, seed);
    if (iteration < input.warmupIterations) {
      continue;
    }
    if (measureControlFirst) {
      control.push(firstResult);
      candidate.push(secondResult);
    } else {
      candidate.push(firstResult);
      control.push(secondResult);
    }
  }

  return buildRowsFromTrials({
    cell: input.cell,
    locality: input.locality,
    actualSnapshotBytes: fixture.monolithicBytes.byteLength,
    chunkFanout: packed.descriptors.length,
    workerdFactor: input.workerdFactor,
    control,
    candidate,
  });
};

export const runArmSymmetryGrid = async (
  onRows?: (rows: readonly [ArmSymmetryRow, ArmSymmetryRow]) => void,
): Promise<readonly ArmSymmetryRow[]> => {
  const rows: ArmSymmetryRow[] = [];
  for (const locality of ["uniform", "append"] as const) {
    for (const cell of WIN_MODEL_CELLS) {
      const measured = await runArmSymmetryCell({
        cell: cell.label,
        rows: cell.rows,
        documentBytes: WIN_MODEL_DOCUMENT_BYTES,
        locality,
        workerdFactor: WORKERD_CONVERSION_PROVENANCE.factors_by_cell[cell.label],
        warmupIterations: ARM_SYMMETRY_WARMUP_ITERATIONS,
        measureIterations: ARM_SYMMETRY_MEASURE_ITERATIONS,
      });
      rows.push(...measured);
      onRows?.(measured);
    }
  }
  return rows;
};

export const deriveArmSymmetryFindings = (): readonly string[] => [
  `Frequency: fold CPU is per write tick, with a ${WRITE_TICK_FOLD_ENTRIES_PER_PASS}-mutation pass as the amortisation unit; the planner can admit fewer, so each row reports actual K. Read validation is per read. The costs are 1:1 only in the deployed study Worker, which performs one complete read plus one fold per invocation.`,
  "Fan-out: read validation depends on shape — point reads touch 1 chunk, bounded ranges up to 8, and complete reads up to 32. Every measured row here is the deployed Worker arm's complete materialising read; `chunk_fanout` records the cell's actual count.",
  "Breakdown: hash, decode, and canonical re-encode time the production primitives independently; `read_total` times the production read path and additionally includes copies, structural checks, object fetches, and materialisation. Component medians are explanatory, not additive.",
  "Integrity: the chunked reader's canonical re-encode and byte comparison remain enabled. The probe measures their cost; it does not propose removing them.",
  "Conversion: workerd net values apply inherited 6.89x / 8.55x / 9.57x / 8.91x factors whose driver is deleted. They are inherited, unverified conversions—not workerd measurements.",
  "No verdict: these measurements expose read penalty, fold delta, and net CPU. The program decision must choose any admission margin; this probe writes none.",
];

export const buildArmSymmetryRecord = (input: {
  readonly rows: readonly ArmSymmetryRow[];
  readonly subject_commit: string;
}): ArmSymmetryRecord => ({
  version: ARM_SYMMETRY_VERSION,
  subject_commit: input.subject_commit,
  node_version: process.version,
  platform: process.platform,
  arch: process.arch,
  cpu_measurement: "process.cpuUsage-user-plus-system",
  read_component_method: "standalone-production-primitives",
  read_total_method: "production-read-path",
  median_algorithm: "quantile-r7-v1",
  policy: ARM_SYMMETRY_POLICY,
  mutations_per_fold: WRITE_TICK_FOLD_ENTRIES_PER_PASS,
  warmup_iterations: ARM_SYMMETRY_WARMUP_ITERATIONS,
  measure_iterations: ARM_SYMMETRY_MEASURE_ITERATIONS,
  read_shape: ARM_SYMMETRY_READ_SHAPE,
  workerd_conversion: WORKERD_CONVERSION_PROVENANCE,
  rows: input.rows,
  findings: deriveArmSymmetryFindings(),
});

const timingLabel = (value: TimingSummary): string =>
  `${value.median_ms.toFixed(2)} [${value.range_ms}]`;

export const renderArmSymmetryTables = (rows: readonly ArmSymmetryRow[]): string => {
  const lines: string[] = [
    "sign convention: deltas/net are arm - monolithic-control; negative is candidate CPU saved",
  ];
  for (const locality of ["uniform", "append"] as const) {
    lines.push("", `locality: ${locality} (N=${ARM_SYMMETRY_MEASURE_ITERATIONS}, CPU ms)`);
    lines.push(
      "cell | arm | read shape/fanout | hash med [range] | decode med [range] | canonical re-encode med [range] | read total med [range] | fold med [range] | invocation med [range] | read delta | fold delta | net Node | net workerd (CONVERTED, inherited/unverified)",
    );
    for (const row of rows.filter((candidate) => candidate.locality === locality)) {
      lines.push(
        [
          row.cell,
          row.arm,
          `${row.read_shape}/${row.chunk_fanout} chunks (${row.objects_read} objects)`,
          timingLabel(row.hash),
          timingLabel(row.decode),
          timingLabel(row.canonical_reencode),
          timingLabel(row.read_total),
          `${timingLabel(row.fold)} K=${row.fold_entries_median}`,
          timingLabel(row.invocation),
          timingLabel(row.read_delta_vs_control),
          timingLabel(row.fold_delta_vs_control),
          timingLabel(row.net_vs_control_node),
          `${timingLabel(row.net_vs_control_workerd_converted)} @ ${row.workerd_conversion_factor.toFixed(2)}x`,
        ].join(" | "),
      );
    }
  }
  return lines.join("\n");
};
