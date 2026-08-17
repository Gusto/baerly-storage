import { BaerlyError, type DocumentData, encodeJsonBytes, type LogEntry } from "@baerly/protocol";
import { type ReferenceMutation } from "./chunked-snapshot-reference.ts";
import {
  buildSnapshotChunks,
  deriveOwnerAndNeighbor,
  routeMutationToDescriptor,
  type SnapshotChunkBoundaryPolicy,
  type SnapshotChunkBuildResult,
} from "./snapshot-chunk-builder.ts";
import { assertSnapshotDocId, compareDocIds } from "./snapshot-doc-id.ts";
import {
  firstDescriptorEndingAtOrAfter,
  type SnapshotChunkDescriptor,
} from "./snapshot-manifest.ts";

const utf8 = new TextEncoder();

export interface ChunkedFoldBudget {
  readonly max_log_entries: number;
  readonly max_mutation_bytes: number;
  readonly max_touched_chunks: number;
  readonly max_touched_bytes: number;
  readonly max_split_increments: number;
  readonly max_neighbor_chunks: number;
}

export interface ChunkedFoldPrefetch {
  readonly candidate_log_seq_ends: readonly number[];
  readonly directly_touched_chunk_indexes: readonly number[];
  readonly chunk_indexes: readonly number[];
  readonly touched_bytes: number;
  readonly leftmost_direct_owner_index: number | null;
  readonly selected_neighbor_index: number | null;
}

export interface ChunkedFoldPlan {
  readonly log_seq_end: number;
  readonly prefetch: ChunkedFoldPrefetch;
  readonly touched_chunk_indexes: readonly number[];
  readonly touched_ranges: readonly {
    readonly first_id: string;
    readonly last_id: string;
  }[];
  readonly mutation_bytes: number;
  readonly split_increments: number;
  readonly used_neighbor_chunk_index: number | null;
  readonly mutations: ReadonlyMap<string, ReferenceMutation>;
  readonly build: SnapshotChunkBuildResult;
}

export interface PrefetchChunkedFoldInput {
  readonly entries: readonly LogEntry[];
  readonly descriptors: readonly SnapshotChunkDescriptor[];
  readonly budget: ChunkedFoldBudget;
}

export interface PlanChunkedFoldInput {
  readonly collection: string;
  readonly collectionPrefix: string;
  readonly entries: readonly LogEntry[];
  readonly descriptors: readonly SnapshotChunkDescriptor[];
  readonly loadedChunks: ReadonlyMap<string, readonly DocumentData[]>;
  readonly budget: ChunkedFoldBudget;
  readonly incarnation: string;
  readonly policy: SnapshotChunkBoundaryPolicy;
  readonly baseLogSeq?: number;
}

function invalid(
  code: "InvalidConfig" | "InvalidResponse",
  message: string,
  cause?: unknown,
): never {
  throw new BaerlyError(code, `chunked fold planner: ${message}`, cause);
}

function isRoutedDelete(docId: string, descriptors: readonly SnapshotChunkDescriptor[]): boolean {
  const low = firstDescriptorEndingAtOrAfter(descriptors, docId);
  if (low < descriptors.length) {
    const descriptor = descriptors[low]!;
    return compareDocIds(descriptor.first_id, docId) <= 0;
  }
  return false;
}

function computeMutationContribution(
  mutation: ReferenceMutation,
  descriptors: readonly SnapshotChunkDescriptor[],
): number {
  if (mutation.op === "D") {
    if (isRoutedDelete(mutation.doc_id, descriptors)) {
      return utf8.encode(mutation.doc_id).byteLength;
    }
    return 0;
  }
  const canonicalBytes = encodeJsonBytes(mutation.after);
  return canonicalBytes.byteLength;
}

/**
 * Phase 1: Metadata prefetch phase.
 * Walks log entries in sequence using only authenticated descriptor metadata and post-images.
 * Retains final last-write-wins mutations, locks the (owner, neighbor) pair on first non-null owner,
 * and bounds candidate endpoints by entry count, mutation bytes, direct chunks, and touched bytes.
 */
export const prefetchChunkedFold = (input: PrefetchChunkedFoldInput): ChunkedFoldPrefetch => {
  const { entries, descriptors, budget } = input;

  const candidate_log_seq_ends: number[] = [];
  const allDirectIndexes = new Set<number>();
  let lockedOwner: number | null = null;
  let lockedNeighbor: number | null = null;
  let lockedPairEstablished = false;

  const runningMutations = new Map<string, ReferenceMutation>();
  let runningMutationBytes = 0;
  // Routing is a pure function of (doc_id, op) against the fixed descriptor
  // array, so each doc's target is computed once and maintained incrementally
  // (with refcounts over touched descriptor indexes) instead of re-routing
  // every accumulated mutation on each entry.
  const docTargetIndexes = new Map<string, number | null>();
  const targetRefCount = new Map<number, number>();

  for (let m = 0; m < entries.length; m++) {
    const entry = entries[m]!;

    if (m + 1 > budget.max_log_entries) {
      break;
    }

    assertSnapshotDocId(entry.doc_id);
    let mutation: ReferenceMutation;
    if (entry.op === "D") {
      mutation = { op: "D", doc_id: entry.doc_id };
    } else {
      if (entry.after === undefined) {
        invalid("InvalidResponse", "insert or update log entry missing after post-image");
      }
      mutation = { op: entry.op, doc_id: entry.doc_id, after: entry.after };
    }

    const previousMutation = runningMutations.get(entry.doc_id);
    if (previousMutation !== undefined) {
      runningMutationBytes -= computeMutationContribution(previousMutation, descriptors);
    }
    const newContribution = computeMutationContribution(mutation, descriptors);
    runningMutationBytes += newContribution;
    runningMutations.set(entry.doc_id, mutation);

    if (runningMutationBytes > budget.max_mutation_bytes) {
      break;
    }

    const previousTarget = docTargetIndexes.get(entry.doc_id);
    const nextTarget =
      previousMutation !== undefined && previousMutation.op === mutation.op
        ? previousTarget!
        : routeMutationToDescriptor(entry.doc_id, mutation.op, descriptors);
    if (previousTarget !== undefined && previousTarget !== nextTarget && previousTarget !== null) {
      const remaining = (targetRefCount.get(previousTarget) ?? 1) - 1;
      if (remaining > 0) {
        targetRefCount.set(previousTarget, remaining);
      } else {
        targetRefCount.delete(previousTarget);
      }
    }
    if (nextTarget !== null && nextTarget !== previousTarget) {
      targetRefCount.set(nextTarget, (targetRefCount.get(nextTarget) ?? 0) + 1);
    }
    docTargetIndexes.set(entry.doc_id, nextTarget);

    const currentDirectIndexes = new Set(targetRefCount.keys());

    if (currentDirectIndexes.size > budget.max_touched_chunks) {
      break;
    }

    const { leftmostOwnerIndex, selectedNeighborIndex } = deriveOwnerAndNeighbor(
      currentDirectIndexes,
      descriptors.length,
    );

    if (!lockedPairEstablished) {
      if (leftmostOwnerIndex !== null) {
        lockedOwner = leftmostOwnerIndex;
        lockedNeighbor = selectedNeighborIndex;
        lockedPairEstablished = true;
      }
    } else {
      if (leftmostOwnerIndex !== lockedOwner || selectedNeighborIndex !== lockedNeighbor) {
        break;
      }
    }

    const endpointChunks = new Set(currentDirectIndexes);
    if (selectedNeighborIndex !== null) {
      endpointChunks.add(selectedNeighborIndex);
    }
    let endpointTouchedBytes = 0;
    for (const chunkIndex of endpointChunks) {
      endpointTouchedBytes += descriptors[chunkIndex]!.byte_length;
    }

    if (endpointTouchedBytes > budget.max_touched_bytes) {
      break;
    }

    candidate_log_seq_ends.push(entry.seq);
    for (const index of currentDirectIndexes) {
      allDirectIndexes.add(index);
    }
  }

  const directly_touched_chunk_indexes = [...allDirectIndexes].toSorted((a, b) => a - b);
  const prefetchChunks = new Set(allDirectIndexes);
  if (lockedNeighbor !== null) {
    prefetchChunks.add(lockedNeighbor);
  }
  const chunk_indexes = [...prefetchChunks].toSorted((a, b) => a - b);

  let totalTouchedBytes = 0;
  for (const chunkIndex of chunk_indexes) {
    totalTouchedBytes += descriptors[chunkIndex]!.byte_length;
  }

  return {
    candidate_log_seq_ends,
    directly_touched_chunk_indexes,
    chunk_indexes,
    touched_bytes: totalTouchedBytes,
    leftmost_direct_owner_index: lockedOwner,
    selected_neighbor_index: lockedNeighbor,
  };
};

/**
 * Phase 2: Exact prefix selection through the builder.
 * Dry-runs candidate endpoints in sequence and selects the longest sequentially admitted prefix.
 */
export const planChunkedFold = async (
  input: PlanChunkedFoldInput,
): Promise<ChunkedFoldPlan | null> => {
  const {
    collection,
    collectionPrefix,
    entries,
    descriptors,
    loadedChunks,
    budget,
    incarnation,
    policy,
    baseLogSeq,
  } = input;

  const prefetch = prefetchChunkedFold({ entries, descriptors, budget });

  if (prefetch.candidate_log_seq_ends.length === 0) {
    if (entries.length === 0) {
      const emptyBuildResult: SnapshotChunkBuildResult = {
        chunks: descriptors,
        changed_chunks: [],
        split_increments: 0,
        used_neighbor_chunk_index: null,
      };
      return {
        log_seq_end: baseLogSeq ?? 0,
        prefetch,
        touched_chunk_indexes: [],
        touched_ranges: [],
        mutation_bytes: 0,
        split_increments: 0,
        used_neighbor_chunk_index: null,
        mutations: new Map(),
        build: emptyBuildResult,
      };
    }
    return null;
  }

  let lastAdmittedPlan: ChunkedFoldPlan | null = null;

  // Candidates are pushed in entry order during prefetch, so their indexes
  // advance monotonically — walk a pointer instead of re-scanning entries.
  let endpointSearchFrom = 0;
  for (const endpointSeq of prefetch.candidate_log_seq_ends) {
    let endpointIndex = endpointSearchFrom;
    while (entries[endpointIndex]!.seq !== endpointSeq) {
      endpointIndex++;
    }
    endpointSearchFrom = endpointIndex;
    const prefixEntries = entries.slice(0, endpointIndex + 1);

    const mutationMap = new Map<string, ReferenceMutation>();
    for (const entry of prefixEntries) {
      assertSnapshotDocId(entry.doc_id);
      if (entry.op === "D") {
        mutationMap.set(entry.doc_id, { op: "D", doc_id: entry.doc_id });
      } else {
        if (entry.after === undefined) {
          invalid("InvalidResponse", "insert or update missing after post-image");
        }
        mutationMap.set(entry.doc_id, {
          op: entry.op,
          doc_id: entry.doc_id,
          after: entry.after,
        });
      }
    }

    const directIndexes = new Set<number>();
    let mutationBytes = 0;
    for (const [docId, mut] of mutationMap) {
      const target = routeMutationToDescriptor(docId, mut.op, descriptors);
      if (target !== null) {
        directIndexes.add(target);
      }
      mutationBytes += computeMutationContribution(mut, descriptors);
    }

    const touched_chunk_indexes = [...directIndexes].toSorted((a, b) => a - b);
    const touched_ranges = touched_chunk_indexes.map((idx) => ({
      first_id: descriptors[idx]!.first_id,
      last_id: descriptors[idx]!.last_id,
    }));

    // The prefetch locks (owner, neighbor) once and breaks the walk the moment
    // the pair would change, so every candidate from the locking entry onward
    // re-derives exactly this pair. Earlier candidates (gap-only prefixes)
    // touch no descriptor, and the builder gates the merge on the owner being
    // directly touched, so passing the locked pair for them is inert. Preserve
    // this contract if the builder ever consults the pair outside that guard.
    const buildResult = await buildSnapshotChunks({
      collection,
      collectionPrefix,
      descriptors,
      loadedChunks,
      mutations: mutationMap,
      incarnation,
      policy,
      lockedDirectOwnerIndex: prefetch.leftmost_direct_owner_index,
      selectedNeighborIndex: prefetch.selected_neighbor_index,
    });

    const neighborUsedCount = buildResult.used_neighbor_chunk_index === null ? 0 : 1;

    if (
      buildResult.split_increments > budget.max_split_increments ||
      neighborUsedCount > budget.max_neighbor_chunks
    ) {
      break;
    }

    lastAdmittedPlan = {
      log_seq_end: endpointSeq,
      prefetch,
      touched_chunk_indexes,
      touched_ranges,
      mutation_bytes: mutationBytes,
      split_increments: buildResult.split_increments,
      used_neighbor_chunk_index: buildResult.used_neighbor_chunk_index,
      mutations: mutationMap,
      build: buildResult,
    };
  }

  return lastAdmittedPlan;
};
