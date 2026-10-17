/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key field. */
/**
 * Workload-ceiling arm-symmetry probe.
 *
 * Measures the monolithic control and chunked candidate on one Node CPU axis,
 * under two separately reported read shapes:
 *
 *  - `fold-read` — what each arm's fold has to read. The control reads its one
 *    whole-snapshot object, because the monolithic layout gives it no choice.
 *    The candidate follows the chunked fold's step order: read and validate the
 *    manifest, run the planner's metadata phase (`prefetchChunkedFold`) to bound
 *    the prefetch set, then fetch and validate ONLY those chunk bodies. This
 *    shape plus the fold is the net-CPU comparison.
 *  - `query-read` — the complete materialising read a complete query or
 *    `materialize` pays. Reported for scale and excluded from the fold net.
 *
 * Read validation is also decomposed into hash, JSON decode, and canonical
 * re-encode so the candidate-only integrity cost stays visible in both shapes.
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
  decodeSnapshotChunk,
  decodeSnapshotManifest,
  encodeSnapshotChunk,
  encodeSnapshotManifest,
  openSnapshotView,
  snapshotManifestKey,
  type SnapshotChunk,
  type SnapshotManifest,
} from "@baerly/server/_internal/testing";
import {
  planChunkedFold,
  prefetchChunkedFold,
} from "../../packages/server/src/chunked-fold-planner.ts";
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

export const ARM_SYMMETRY_VERSION = "baerly.workload-ceiling-arm-symmetry/v2" as const;
export const ARM_SYMMETRY_POLICY = "c128-r512" as const;
export const ARM_SYMMETRY_WARMUP_ITERATIONS = 3 as const;
export const ARM_SYMMETRY_MEASURE_ITERATIONS = 20 as const;
export const ARM_SYMMETRY_READ_SHAPES = ["fold-read", "query-read"] as const;
/** The documented prefetch bound: direct-touch ceiling plus the one selected neighbor. */
export const ARM_SYMMETRY_FOLD_READ_MAX_CHUNKS =
  WIN_MODEL_BUDGET.max_touched_chunks + WIN_MODEL_BUDGET.max_neighbor_chunks;

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
export type ArmSymmetryReadShape = (typeof ARM_SYMMETRY_READ_SHAPES)[number];

export interface TimingSummary {
  readonly median_ms: number;
  readonly range_ms: string;
}

export interface CountSummary {
  readonly median: number;
  readonly range: string;
}

/** One read shape's measured cost within a single trial. */
export interface ArmSymmetryReadTrial {
  /** Chunk bodies fetched and validated; 0 for the monolithic control. */
  readonly chunks_read: number;
  /** Storage objects fetched: the control's one body, or manifest + chunks. */
  readonly objects_read: number;
  readonly hash_ms: number;
  readonly decode_ms: number;
  readonly canonical_reencode_ms: number;
  readonly read_total_ms: number;
}

export interface ArmSymmetryTrial {
  readonly iteration: number;
  readonly seed: number;
  readonly fold_read: ArmSymmetryReadTrial;
  readonly query_read: ArmSymmetryReadTrial;
  /** The candidate's explicit metadata phase that bounds its fold-read; 0 for the control. */
  readonly prefetch_ms: number;
  readonly fold_ms: number;
  /** `fold_read.read_total_ms + prefetch_ms + fold_ms`; query-read is excluded. */
  readonly invocation_ms: number;
  readonly fold_entries: number;
}

export interface ArmSymmetryReadSummary {
  readonly read_shape: ArmSymmetryReadShape;
  readonly chunk_fanout: CountSummary;
  readonly objects_read: CountSummary;
  /** Artifacts whose canonical re-encode was checked: manifest + chunks, 0 for the control. */
  readonly canonical_reencode_artifacts: CountSummary;
  readonly hash: TimingSummary;
  readonly decode: TimingSummary;
  readonly canonical_reencode: TimingSummary;
  readonly read_total: TimingSummary;
  readonly read_delta_vs_control: TimingSummary;
}

export interface ArmSymmetryRow {
  readonly cell: string;
  readonly locality: WinModelLocality;
  readonly arm: ArmSymmetryArm;
  readonly actual_snapshot_bytes: number;
  /** Chunks in the candidate's manifest; 0 for the control. */
  readonly total_chunks: number;
  readonly iterations: number;
  readonly fold_read: ArmSymmetryReadSummary;
  readonly query_read: ArmSymmetryReadSummary;
  readonly prefetch: TimingSummary;
  readonly fold: TimingSummary;
  readonly invocation: TimingSummary;
  readonly fold_entries_median: number;
  readonly fold_delta_vs_control: TimingSummary;
  /** Paired `invocation` delta: fold-read + metadata phase + fold. Query-read is excluded. */
  readonly net_vs_control_node: TimingSummary;
  /**
   * `net_vs_control_node` split by which arm ran first in the pair. Whichever
   * arm runs second inherits the first arm's heap state, so strata that
   * disagree mean the pooled median measures arm order, not arm cost. `null`
   * for the control, or when a stratum has no trials.
   */
  readonly net_by_order: {
    readonly control_first: TimingSummary | null;
    readonly control_second: TimingSummary | null;
  } | null;
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
  readonly read_shapes: typeof ARM_SYMMETRY_READ_SHAPES;
  readonly net_read_shape: "fold-read";
  readonly fold_read_max_chunks: number;
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
  readonly manifestArtifact: EncodedArtifact;
  /** Indexed like `packed.descriptors`. */
  readonly chunkArtifacts: readonly EncodedArtifact[];
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

const assertSameIndexes = (
  fetched: readonly number[],
  planned: readonly number[],
  context: string,
): void => {
  if (fetched.length !== planned.length || fetched.some((value, i) => value !== planned[i])) {
    throw new Error(
      `arm-symmetry: ${context} fetched chunks [${fetched.join(",")}] but the plan admitted [${planned.join(",")}]`,
    );
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
    manifestArtifact: { kind: "manifest", bytes: manifestBytes, parsed: manifest },
    chunkArtifacts,
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

/** Hash / decode / canonical re-encode over exactly the artifacts one candidate read shape fetches. */
const measureCandidateComponents = async (
  artifacts: readonly EncodedArtifact[],
): Promise<Pick<ArmSymmetryReadTrial, "hash_ms" | "decode_ms" | "canonical_reencode_ms">> => {
  const bytes = artifacts.map((artifact) => artifact.bytes);
  return {
    hash_ms: await measureHash(bytes),
    decode_ms: await measureDecode(bytes),
    canonical_reencode_ms: await measureCanonicalReencode(artifacts),
  };
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

type FoldTrial = Omit<ArmSymmetryTrial, "query_read">;

const measureControlRead = async (
  fixture: ProbeFixture,
): Promise<{ readonly read: ArmSymmetryReadTrial; readonly base: Map<string, DocumentData> }> => {
  const hashMs = await measureHash([fixture.monolithicBytes]);
  const decodeMs = await measureDecode([fixture.monolithicBytes]);
  const read = await cpuMs(() =>
    loadSnapshotAsMap(fixture.storage, fixture.monolithicKey, WIN_MODEL_COLLECTION),
  );
  return {
    read: {
      chunks_read: 0,
      objects_read: 1,
      hash_ms: hashMs,
      decode_ms: decodeMs,
      canonical_reencode_ms: 0,
      read_total_ms: read.cpuMs,
    },
    base: read.value,
  };
};

const measureControlFoldTrial = async (
  fixture: ProbeFixture,
  entries: readonly LogEntry[],
  iteration: number,
  seed: number,
): Promise<FoldTrial> => {
  const { read, base } = await measureControlRead(fixture);
  const fold = await cpuMs(() => rebuildMonolithic(base, entries));
  return {
    iteration,
    seed,
    fold_read: read,
    prefetch_ms: 0,
    fold_ms: fold.cpuMs,
    invocation_ms: read.read_total_ms + fold.cpuMs,
    fold_entries: entries.length,
  };
};

/** The control's query-read is the same whole-snapshot read its fold pays, sampled in the query pass. */
const measureControlQueryRead = async (fixture: ProbeFixture): Promise<ArmSymmetryReadTrial> => {
  const { read } = await measureControlRead(fixture);
  return read;
};

const readCandidateManifest = async (fixture: ProbeFixture): Promise<SnapshotManifest> => {
  const stored = await fixture.storage.get(fixture.manifestKey);
  if (stored === null) {
    throw new Error(`arm-symmetry: manifest is missing: ${fixture.manifestKey}`);
  }
  return decodeSnapshotManifest(stored.body, fixture.manifestKey, WIN_MODEL_COLLECTION, 0);
};

/** Fetch and validate only the named chunk bodies — the same get + decode `openSnapshotView` runs per chunk. */
const readCandidateChunks = async (
  fixture: ProbeFixture,
  manifest: SnapshotManifest,
  chunkIndexes: readonly number[],
): Promise<Map<string, readonly DocumentData[]>> => {
  const loaded = new Map<string, readonly DocumentData[]>();
  for (const index of chunkIndexes) {
    const descriptor = manifest.chunks[index]!;
    const stored = await fixture.storage.get(descriptor.key);
    if (stored === null) {
      throw new Error(`arm-symmetry: chunk is missing: ${descriptor.key}`);
    }
    const chunk = await decodeSnapshotChunk(
      stored.body,
      descriptor.key,
      WIN_MODEL_COLLECTION,
      descriptor,
    );
    loaded.set(descriptor.key, chunk.docs);
  }
  return loaded;
};

const measureCandidateFoldTrial = async (
  fixture: ProbeFixture,
  entries: readonly LogEntry[],
  iteration: number,
  seed: number,
): Promise<FoldTrial> => {
  // The components need the admitted set before the timed read, so
  // derive it once untimed here; the timed path below re-derives it in step order.
  const plannedIndexes = prefetchChunkedFold({
    entries,
    descriptors: fixture.packed.descriptors,
    budget: WIN_MODEL_BUDGET,
  }).chunk_indexes;
  const foldComponents = await measureCandidateComponents([
    fixture.manifestArtifact,
    ...plannedIndexes.map((index) => fixture.chunkArtifacts[index]!),
  ]);
  const manifestRead = await cpuMs(() => readCandidateManifest(fixture));
  const prefetch = await cpuMs(() =>
    prefetchChunkedFold({
      entries,
      descriptors: manifestRead.value.chunks,
      budget: WIN_MODEL_BUDGET,
    }),
  );
  const chunkRead = await cpuMs(() =>
    readCandidateChunks(fixture, manifestRead.value, prefetch.value.chunk_indexes),
  );
  // Derived from what was actually loaded — the map the planner receives — not
  // from the plan, so a read that over-fetches fails the guards below.
  const fetchedIndexes = manifestRead.value.chunks.flatMap((descriptor, index) =>
    chunkRead.value.has(descriptor.key) ? [index] : [],
  );
  if (fetchedIndexes.length > ARM_SYMMETRY_FOLD_READ_MAX_CHUNKS) {
    throw new Error(
      `arm-symmetry: fold-read fetched ${fetchedIndexes.length} chunks, above the ${ARM_SYMMETRY_FOLD_READ_MAX_CHUNKS}-chunk prefetch bound`,
    );
  }
  // `loadedChunks` holds only the fetched set, so a planner that needs any
  // other chunk fails closed instead of reading a pre-built complete map.
  // The window also encodes and hashes the successor manifest (fold step 7),
  // matching the control's whole-body encode + hash; neither arm PUTs.
  const fold = await cpuMs(async () => {
    const plan = await planChunkedFold({
      collection: WIN_MODEL_COLLECTION,
      collectionPrefix: WIN_MODEL_COLLECTION_PREFIX,
      entries,
      descriptors: manifestRead.value.chunks,
      loadedChunks: chunkRead.value,
      budget: WIN_MODEL_BUDGET,
      incarnation: WIN_MODEL_INCARNATION,
      policy: CHUNK_BOUNDARY_POLICIES[ARM_SYMMETRY_POLICY],
      baseLogSeq: 0,
    });
    if (plan !== null) {
      await snapshotHash(
        encodeSnapshotManifest({
          ...manifestRead.value,
          log_seq_start: plan.log_seq_end,
          chunks: plan.build.chunks,
        }),
      );
    }
    return plan;
  });
  if (fold.value === null) {
    throw new Error("arm-symmetry: planChunkedFold admitted no mutation");
  }
  assertSameIndexes(fetchedIndexes, fold.value.prefetch.chunk_indexes, "fold-read");
  assertSameIndexes(fetchedIndexes, plannedIndexes, "fold-read components");
  const admitted = entries.findIndex((entry) => entry.seq === fold.value!.log_seq_end) + 1;
  const foldReadTotalMs = manifestRead.cpuMs + chunkRead.cpuMs;

  return {
    iteration,
    seed,
    fold_read: {
      chunks_read: fetchedIndexes.length,
      objects_read: fetchedIndexes.length + 1,
      ...foldComponents,
      read_total_ms: foldReadTotalMs,
    },
    prefetch_ms: prefetch.cpuMs,
    fold_ms: fold.cpuMs,
    invocation_ms: foldReadTotalMs + prefetch.cpuMs + fold.cpuMs,
    fold_entries: admitted,
  };
};

/** The complete materialising read a complete query or `materialize` pays. Excluded from the fold net. */
const measureCandidateQueryRead = async (fixture: ProbeFixture): Promise<ArmSymmetryReadTrial> => {
  const totalChunks = fixture.chunkArtifacts.length;
  const components = await measureCandidateComponents([
    fixture.manifestArtifact,
    ...fixture.chunkArtifacts,
  ]);
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
  return {
    chunks_read: totalChunks,
    objects_read: totalChunks + 1,
    ...components,
    read_total_ms: read.cpuMs,
  };
};

/**
 * Whether the control runs first at `iteration`. Plain `iteration % 2` would
 * alias with the even-length seed cycle and pin every seed to one arm order;
 * flipping parity each seed cycle gives every seed both orders.
 */
export const controlFirstAt = (iteration: number): boolean =>
  (iteration + Math.floor(iteration / WIN_MODEL_SEEDS.length)) % 2 === 0;

const summary = (values: readonly number[]): TimingSummary => ({
  median_ms: median(values),
  range_ms: rangeLabel(values),
});

const countSummary = (values: readonly number[]): CountSummary => ({
  median: median(values),
  range: `${Math.min(...values)}-${Math.max(...values)}`,
});

const zeroSummary = (): TimingSummary => ({ median_ms: 0, range_ms: "0.00-0.00" });

export const buildRowsFromTrials = (input: {
  readonly cell: string;
  readonly locality: WinModelLocality;
  readonly actualSnapshotBytes: number;
  readonly totalChunks: number;
  readonly workerdFactor: number;
  readonly control: readonly ArmSymmetryTrial[];
  readonly candidate: readonly ArmSymmetryTrial[];
}): readonly [ArmSymmetryRow, ArmSymmetryRow] => {
  if (input.control.length !== input.candidate.length || input.control.length === 0) {
    throw new Error("arm-symmetry: paired control/candidate trials must have equal nonzero length");
  }
  const pairedDelta = (value: (trial: ArmSymmetryTrial) => number): TimingSummary =>
    summary(input.candidate.map((trial, index) => value(trial) - value(input.control[index]!)));

  const summarizeShape = (
    shape: ArmSymmetryReadShape,
    trials: readonly ArmSymmetryTrial[],
    isCandidate: boolean,
  ): ArmSymmetryReadSummary => {
    const key = shape === "fold-read" ? "fold_read" : "query_read";
    const reads = trials.map((trial) => trial[key]);
    return {
      read_shape: shape,
      chunk_fanout: countSummary(reads.map((read) => read.chunks_read)),
      objects_read: countSummary(reads.map((read) => read.objects_read)),
      canonical_reencode_artifacts: countSummary(
        reads.map((read) => (isCandidate ? read.objects_read : 0)),
      ),
      hash: summary(reads.map((read) => read.hash_ms)),
      decode: summary(reads.map((read) => read.decode_ms)),
      canonical_reencode: summary(reads.map((read) => read.canonical_reencode_ms)),
      read_total: summary(reads.map((read) => read.read_total_ms)),
      read_delta_vs_control: isCandidate
        ? pairedDelta((trial) => trial[key].read_total_ms)
        : zeroSummary(),
    };
  };

  const summarizeArm = (
    arm: ArmSymmetryArm,
    trials: readonly ArmSymmetryTrial[],
  ): ArmSymmetryRow => {
    const isCandidate = arm === "chunked-candidate";
    const netDeltas = input.candidate.map(
      (trial, index) => trial.invocation_ms - input.control[index]!.invocation_ms,
    );
    const netWhere = (controlFirst: boolean): TimingSummary | null => {
      const deltas = netDeltas.filter(
        (_, index) => controlFirstAt(input.control[index]!.iteration) === controlFirst,
      );
      return deltas.length === 0 ? null : summary(deltas);
    };
    return {
      cell: input.cell,
      locality: input.locality,
      arm,
      actual_snapshot_bytes: input.actualSnapshotBytes,
      total_chunks: isCandidate ? input.totalChunks : 0,
      iterations: trials.length,
      fold_read: summarizeShape("fold-read", trials, isCandidate),
      query_read: summarizeShape("query-read", trials, isCandidate),
      prefetch: summary(trials.map((trial) => trial.prefetch_ms)),
      fold: summary(trials.map((trial) => trial.fold_ms)),
      invocation: summary(trials.map((trial) => trial.invocation_ms)),
      fold_entries_median: median(trials.map((trial) => trial.fold_entries)),
      fold_delta_vs_control: isCandidate ? pairedDelta((trial) => trial.fold_ms) : zeroSummary(),
      net_vs_control_node: isCandidate ? summary(netDeltas) : zeroSummary(),
      net_by_order: isCandidate
        ? { control_first: netWhere(true), control_second: netWhere(false) }
        : null,
      net_vs_control_workerd_converted: isCandidate
        ? summary(netDeltas.map((value) => value * input.workerdFactor))
        : zeroSummary(),
      workerd_conversion_factor: input.workerdFactor,
      trials,
    };
  };

  return [
    summarizeArm("monolithic-control", input.control),
    summarizeArm("chunked-candidate", input.candidate),
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
  const totalIterations = input.warmupIterations + input.measureIterations;

  /**
   * Paired, order-alternating trials with warmup dropped. The fold pass and the
   * query pass run separately so the complete read's allocation — and the
   * major GC it provokes — never lands inside a net-CPU trial.
   */
  const paired = async <T>(
    measure: (arm: ArmSymmetryArm, iteration: number) => Promise<T>,
  ): Promise<{ readonly control: T[]; readonly candidate: T[] }> => {
    const control: T[] = [];
    const candidate: T[] = [];
    for (let iteration = 0; iteration < totalIterations; iteration++) {
      const controlFirst = controlFirstAt(iteration);
      const first = await measure(
        controlFirst ? "monolithic-control" : "chunked-candidate",
        iteration,
      );
      const second = await measure(
        controlFirst ? "chunked-candidate" : "monolithic-control",
        iteration,
      );
      if (iteration < input.warmupIterations) {
        continue;
      }
      control.push(controlFirst ? first : second);
      candidate.push(controlFirst ? second : first);
    }
    return { control, candidate };
  };

  const folds = await paired((arm, iteration) => {
    const seed = WIN_MODEL_SEEDS[iteration % WIN_MODEL_SEEDS.length]! * 7919 + input.rows;
    const entries = entriesOf(
      baseRows,
      WRITE_TICK_FOLD_ENTRIES_PER_PASS,
      input.locality,
      seed,
      input.documentBytes,
    );
    return arm === "monolithic-control"
      ? measureControlFoldTrial(fixture, entries, iteration, seed)
      : measureCandidateFoldTrial(fixture, entries, iteration, seed);
  });
  const queries = await paired((arm) =>
    arm === "monolithic-control"
      ? measureControlQueryRead(fixture)
      : measureCandidateQueryRead(fixture),
  );
  const merge = (fold: readonly FoldTrial[], query: readonly ArmSymmetryReadTrial[]) =>
    fold.map((trial, index): ArmSymmetryTrial => ({ ...trial, query_read: query[index]! }));
  const control = merge(folds.control, queries.control);
  const candidate = merge(folds.candidate, queries.candidate);

  return buildRowsFromTrials({
    cell: input.cell,
    locality: input.locality,
    actualSnapshotBytes: fixture.monolithicBytes.byteLength,
    totalChunks: packed.descriptors.length,
    workerdFactor: input.workerdFactor,
    control,
    candidate,
  });
};

export const runArmSymmetryGrid = async (
  measureIterations: number = ARM_SYMMETRY_MEASURE_ITERATIONS,
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
        measureIterations,
      });
      rows.push(...measured);
      onRows?.(measured);
    }
  }
  return rows;
};

export const deriveArmSymmetryFindings = (): readonly string[] => [
  `Frequency: fold CPU is per write tick, with a ${WRITE_TICK_FOLD_ENTRIES_PER_PASS}-mutation pass as the amortisation unit; the planner can admit fewer, so each row reports actual K. Fold-read is paid once per fold; query-read is paid per complete query and is not a fold cost.`,
  `Read shapes: \`fold-read\` is what each arm's fold must read — the control's one whole-snapshot object, or the candidate's manifest plus the bounded prefetch set \`prefetchChunkedFold\` admits (at most ${ARM_SYMMETRY_FOLD_READ_MAX_CHUNKS} chunks: ${WIN_MODEL_BUDGET.max_touched_chunks} direct plus ${WIN_MODEL_BUDGET.max_neighbor_chunks} neighbor). The set actually loaded and handed to the planner is asserted equal to \`plan.prefetch.chunk_indexes\` and within the bound, so an over-fetch fails the run. \`query-read\` is the candidate's complete materialising read.`,
  "Fan-out: fold-read fan-out depends on the seeded mutation batch, so each row reports its median and range. Where a cell has no more chunks than the prefetch bound, fold-read can legitimately fetch every chunk. Query-read fan-out depends on query shape — point reads touch 1 chunk, bounded ranges up to 8, index-routed up to 32, complete reads every chunk; the measured query-read is the complete shape.",
  "Net: `net` is the paired candidate-minus-control delta of fold-read + metadata phase + fold. Query-read is reported for scale and excluded from the net. The control has one read shape, so its fold-read and query-read are the same whole-snapshot read, sampled once in each pass.",
  "Metadata phase: the candidate's `prefetch` column times the explicit `prefetchChunkedFold` call that bounds its read. `planChunkedFold` re-derives the same prefetch internally, so under today's planner API the metadata phase is paid twice and both are counted.",
  "Passes: fold trials and query-read trials run as separate paired, order-alternating passes over the same fixture, so the complete read's allocation stays out of net-CPU trials. Within the fold pass, the second arm still pays GC for the first arm's garbage, so `net_by_order` splits the net by which arm ran first. Where its strata disagree, the pooled median measures arm order, not arm cost.",
  "Heap regime: forcing a GC before each arm removes the order effect but re-warms the heap and raises both arms' cost, so neither regime is neutral. This probe reports the default heap regime; where the net is small next to the per-trial range, it may reflect heap state rather than fold cost.",
  `Seeds: trials cycle through ${WIN_MODEL_SEEDS.length} seeded mutation batches, so N above ${WIN_MODEL_SEEDS.length} repeats batches rather than sampling new ones; arm order alternates independently of the seed. Batches can admit very different K and fan-out, so a cell median can sit between per-seed modes and move between runs; each trial records its seed for stratifying.`,
  "Breakdown: hash, decode, and canonical re-encode time the production primitives independently over exactly the artifacts each read shape fetches; `read_total` times the read path and additionally includes copies, structural checks, object fetches, and (query-read) materialisation. Component medians are explanatory, not additive.",
  "Integrity: the chunked reader's canonical re-encode and byte comparison remain enabled in both read shapes. The probe measures their cost; it does not propose removing them.",
  "Conversion: workerd net values apply inherited 6.89x / 8.55x / 9.57x / 8.91x factors whose driver is deleted. They are inherited, unverified conversions—not workerd measurements.",
  "No verdict: these measurements expose read penalty per shape, fold delta, and net CPU. The program decision must choose any admission margin; this probe writes none.",
];

export const buildArmSymmetryRecord = (input: {
  readonly rows: readonly ArmSymmetryRow[];
  readonly subject_commit: string;
  readonly measure_iterations: number;
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
  measure_iterations: input.measure_iterations,
  read_shapes: ARM_SYMMETRY_READ_SHAPES,
  net_read_shape: "fold-read",
  fold_read_max_chunks: ARM_SYMMETRY_FOLD_READ_MAX_CHUNKS,
  workerd_conversion: WORKERD_CONVERSION_PROVENANCE,
  rows: input.rows,
  findings: deriveArmSymmetryFindings(),
});

const timingLabel = (value: TimingSummary | null): string =>
  value === null ? "-" : `${value.median_ms.toFixed(2)} [${value.range_ms}]`;

const fanoutLabel = (read: ArmSymmetryReadSummary): string =>
  `${read.chunk_fanout.median} [${read.chunk_fanout.range}] chunks (${read.objects_read.median} objects)`;

export const renderArmSymmetryTables = (rows: readonly ArmSymmetryRow[]): string => {
  const lines: string[] = [
    "sign convention: deltas/net are arm - monolithic-control; negative is candidate CPU saved",
  ];
  for (const locality of ["uniform", "append"] as const) {
    const localityRows = rows.filter((candidate) => candidate.locality === locality);
    const iterations = localityRows[0]?.iterations ?? ARM_SYMMETRY_MEASURE_ITERATIONS;
    lines.push(
      "",
      `locality: ${locality} — fold-read, the net comparison (N=${iterations}, CPU ms)`,
      "cell | arm | fold-read fanout med [range] | hash med [range] | decode med [range] | canonical re-encode med [range] | read total med [range] | prefetch med [range] | fold med [range] | invocation med [range] | read delta | fold delta | net Node | net Node control-first / control-second | net workerd (CONVERTED, inherited/unverified)",
    );
    for (const row of localityRows) {
      lines.push(
        [
          row.cell,
          row.arm,
          `${fanoutLabel(row.fold_read)} of ${row.total_chunks}`,
          timingLabel(row.fold_read.hash),
          timingLabel(row.fold_read.decode),
          timingLabel(row.fold_read.canonical_reencode),
          timingLabel(row.fold_read.read_total),
          timingLabel(row.prefetch),
          `${timingLabel(row.fold)} K=${row.fold_entries_median}`,
          timingLabel(row.invocation),
          timingLabel(row.fold_read.read_delta_vs_control),
          timingLabel(row.fold_delta_vs_control),
          timingLabel(row.net_vs_control_node),
          row.net_by_order === null
            ? "-"
            : `${timingLabel(row.net_by_order.control_first)} / ${timingLabel(row.net_by_order.control_second)}`,
          `${timingLabel(row.net_vs_control_workerd_converted)} @ ${row.workerd_conversion_factor.toFixed(2)}x`,
        ].join(" | "),
      );
    }
    lines.push(
      "",
      `locality: ${locality} — query-read, complete materialise, EXCLUDED from net (N=${iterations}, CPU ms)`,
      "cell | arm | query-read fanout | hash med [range] | decode med [range] | canonical re-encode med [range] | read total med [range] | read delta",
    );
    for (const row of localityRows) {
      lines.push(
        [
          row.cell,
          row.arm,
          fanoutLabel(row.query_read),
          timingLabel(row.query_read.hash),
          timingLabel(row.query_read.decode),
          timingLabel(row.query_read.canonical_reencode),
          timingLabel(row.query_read.read_total),
          timingLabel(row.query_read.read_delta_vs_control),
        ].join(" | "),
      );
    }
  }
  return lines.join("\n");
};
