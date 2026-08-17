import { BaerlyError, type DocumentData, encodeJsonBytes, snapshotHash } from "@baerly/protocol";
import { type ReferenceMutation } from "./chunked-snapshot-reference.ts";
import { encodeSnapshotChunk, snapshotChunkKey, type SnapshotChunk } from "./snapshot-chunk.ts";
import { assertSnapshotDocId, compareDocIds } from "./snapshot-doc-id.ts";
import {
  firstDescriptorEndingAtOrAfter,
  type SnapshotChunkDescriptor,
} from "./snapshot-manifest.ts";

const MAX_CHUNK_BYTES = 1024 * 1024;
const INCARNATION_PATTERN = /^[0-9a-f]{32}$/;

export interface SnapshotChunkBoundaryPolicy {
  readonly target_chunk_bytes: number;
  readonly target_rows: number;
}

export const CHUNK_BOUNDARY_POLICIES = {
  "c128-r512": { target_chunk_bytes: 128 * 1024, target_rows: 512 },
  "c512-r2048": { target_chunk_bytes: 512 * 1024, target_rows: 2048 },
  "c1024-r4096": { target_chunk_bytes: 1024 * 1024, target_rows: 4096 },
} as const satisfies Record<string, SnapshotChunkBoundaryPolicy>;

export interface EncodedChunkOutput {
  readonly descriptor: SnapshotChunkDescriptor;
  readonly bytes: Uint8Array;
}

export interface SnapshotChunkBuildResult {
  readonly chunks: readonly SnapshotChunkDescriptor[];
  readonly changed_chunks: readonly EncodedChunkOutput[];
  readonly split_increments: number;
  readonly used_neighbor_chunk_index: number | null;
}

export interface BuildSnapshotChunksInput {
  readonly collection: string;
  readonly collectionPrefix: string;
  readonly descriptors: readonly SnapshotChunkDescriptor[];
  readonly loadedChunks: ReadonlyMap<string, readonly DocumentData[]>;
  readonly mutations: ReadonlyMap<string, ReferenceMutation> | readonly ReferenceMutation[];
  readonly incarnation: string;
  readonly policy: SnapshotChunkBoundaryPolicy;
  readonly lockedDirectOwnerIndex: number | null;
  readonly selectedNeighborIndex: number | null;
}

function invalid(
  code: "InvalidConfig" | "InvalidResponse",
  message: string,
  cause?: unknown,
): never {
  throw new BaerlyError(code, `snapshot chunk builder: ${message}`, cause);
}

function encodeBuilderChunk(chunk: SnapshotChunk): Uint8Array {
  try {
    return encodeSnapshotChunk(chunk);
  } catch (error) {
    if (error instanceof BaerlyError) {
      invalid("InvalidResponse", error.message, error.cause);
    }
    invalid("InvalidResponse", "failed to encode snapshot chunk", error);
  }
}

/**
 * Route a document ID and operation to its containing descriptor index in `descriptors`.
 * Follows Rule 1 of the chunk boundary policy:
 * - Inside descriptor range -> that descriptor
 * - In gap -> immediate predecessor, or immediate successor if no predecessor
 * - Delete in gap -> no-op (returns null)
 * - Empty descriptors -> null
 */
export function routeMutationToDescriptor(
  docId: string,
  op: "I" | "U" | "D",
  descriptors: readonly SnapshotChunkDescriptor[],
): number | null {
  if (descriptors.length === 0) {
    return null;
  }

  const low = firstDescriptorEndingAtOrAfter(descriptors, docId);

  if (low < descriptors.length) {
    const descriptor = descriptors[low]!;
    if (compareDocIds(descriptor.first_id, docId) <= 0) {
      return low;
    }
    if (op === "D") {
      return null;
    }
    if (low === 0) {
      return 0;
    }
    return low - 1;
  }

  if (op === "D") {
    return null;
  }
  return descriptors.length - 1;
}

/**
 * Derive the leftmost direct owner descriptor index and its selected neighbor index
 * from the set of directly touched descriptor indexes.
 */
export function deriveOwnerAndNeighbor(
  directIndexes: ReadonlySet<number>,
  descriptorCount: number,
): { leftmostOwnerIndex: number | null; selectedNeighborIndex: number | null } {
  if (directIndexes.size === 0 || descriptorCount === 0) {
    return { leftmostOwnerIndex: null, selectedNeighborIndex: null };
  }
  let minIndex = Infinity;
  for (const index of directIndexes) {
    if (index < minIndex) {
      minIndex = index;
    }
  }
  const leftmostOwnerIndex = minIndex;
  let selectedNeighborIndex: number | null = null;
  if (leftmostOwnerIndex + 1 < descriptorCount) {
    selectedNeighborIndex = leftmostOwnerIndex + 1;
  } else if (leftmostOwnerIndex - 1 >= 0) {
    selectedNeighborIndex = leftmostOwnerIndex - 1;
  }
  return { leftmostOwnerIndex, selectedNeighborIndex };
}

/**
 * A changed chunk is underfull only when both its exact bytes and rows
 * are strictly below half of the selected target.
 */
export function isUnderfull(
  byteLength: number,
  rowCount: number,
  policy: SnapshotChunkBoundaryPolicy,
): boolean {
  return byteLength < policy.target_chunk_bytes / 2 && rowCount < policy.target_rows / 2;
}

function getLoadedDocs(
  loadedChunks: ReadonlyMap<string, readonly DocumentData[]>,
  descriptor: SnapshotChunkDescriptor,
): readonly DocumentData[] {
  const docs = loadedChunks.get(descriptor.key);
  if (docs !== undefined) {
    return docs;
  }
  invalid("InvalidResponse", `missing loaded chunk for descriptor ${descriptor.key}`);
}

function areDocListsEqual(left: readonly DocumentData[], right: readonly DocumentData[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i++) {
    const leftBytes = encodeJsonBytes(left[i]!);
    const rightBytes = encodeJsonBytes(right[i]!);
    if (leftBytes.byteLength !== rightBytes.byteLength) {
      return false;
    }
    for (let b = 0; b < leftBytes.byteLength; b++) {
      if (leftBytes[b] !== rightBytes[b]) {
        return false;
      }
    }
  }
  return true;
}

interface SplitChunkItem {
  docs: readonly DocumentData[];
  bytes: Uint8Array;
}

interface FacingMergeInput {
  readonly descriptors: readonly SnapshotChunkDescriptor[];
  readonly loadedChunks: ReadonlyMap<string, readonly DocumentData[]>;
  readonly collection: string;
  readonly incarnation: string;
  readonly policy: SnapshotChunkBoundaryPolicy;
  readonly lockedDirectOwnerIndex: number;
  readonly selectedNeighborIndex: number;
  readonly directTouchedIndexes: ReadonlySet<number>;
  readonly unchangedGroupIndexes: ReadonlySet<number>;
  readonly ownerSplitChunks: SplitChunkItem[] | undefined;
}

/**
 * ADR-007 facing-boundary merge. Eligibility, as guard clauses:
 * - the owner produced at least one rewrite output;
 * - both locked indices are in range;
 * - the owner is directly touched and NOT byte-identical after rewrite
 *   (an unchanged owner has no underfull facing output to merge);
 * - the neighbor is NOT directly touched (only untouched neighbors merge);
 * - the neighbor sits on the owner's facing boundary: the immediate right
 *   neighbor, or the immediate left neighbor when the owner has no right
 *   neighbor (i.e. the owner is the rightmost descriptor);
 * - the owner's facing output is underfull and the neighbor's docs fit
 *   alongside it within the target.
 *
 * When eligible, the neighbor's docs fold into the facing output in place.
 * Returns the consumed neighbor index, or null when not merge-eligible.
 */
function applyFacingMerge(input: FacingMergeInput): number | null {
  const {
    descriptors,
    loadedChunks,
    collection,
    incarnation,
    policy,
    lockedDirectOwnerIndex: ownerIndex,
    selectedNeighborIndex: neighborIndex,
    directTouchedIndexes,
    unchangedGroupIndexes,
    ownerSplitChunks,
  } = input;

  if (ownerSplitChunks === undefined || ownerSplitChunks.length === 0) {
    return null;
  }
  if (ownerIndex < 0 || ownerIndex >= descriptors.length) {
    return null;
  }
  if (neighborIndex < 0 || neighborIndex >= descriptors.length) {
    return null;
  }
  if (
    !directTouchedIndexes.has(ownerIndex) ||
    unchangedGroupIndexes.has(ownerIndex) ||
    directTouchedIndexes.has(neighborIndex)
  ) {
    return null;
  }

  let facingChunkIndex: number;
  let isFacingRight: boolean;
  if (neighborIndex === ownerIndex + 1) {
    // Right neighbor: facing output is rightmost.
    facingChunkIndex = ownerSplitChunks.length - 1;
    isFacingRight = true;
  } else if (neighborIndex === ownerIndex - 1 && ownerIndex === descriptors.length - 1) {
    // Left neighbor (only when the owner has no right neighbor): facing output is leftmost.
    facingChunkIndex = 0;
    isFacingRight = false;
  } else {
    return null;
  }

  const facingChunk = ownerSplitChunks[facingChunkIndex]!;
  if (!isUnderfull(facingChunk.bytes.byteLength, facingChunk.docs.length, policy)) {
    return null;
  }

  const neighborDesc = descriptors[neighborIndex]!;
  const neighborDocs = getLoadedDocs(loadedChunks, neighborDesc);
  const combinedDocs = isFacingRight
    ? [...facingChunk.docs, ...neighborDocs]
    : [...neighborDocs, ...facingChunk.docs];
  const candidateChunk: SnapshotChunk = {
    schema_version: 2,
    collection,
    incarnation,
    first_id: combinedDocs[0]!["_id"] as string,
    last_id: combinedDocs.at(-1)!["_id"] as string,
    docs: combinedDocs,
  };
  const combinedBytes = encodeBuilderChunk(candidateChunk);
  if (
    combinedBytes.byteLength > policy.target_chunk_bytes ||
    combinedDocs.length > policy.target_rows
  ) {
    return null;
  }

  ownerSplitChunks[facingChunkIndex] = { docs: combinedDocs, bytes: combinedBytes };
  return neighborIndex;
}

/**
 * Mint the descriptor and changed-chunk output for one encoded split output.
 */
const appendChunkOutput = async (
  chunkItem: SplitChunkItem,
  collectionPrefix: string,
  incarnation: string,
  finalDescriptors: SnapshotChunkDescriptor[],
  changedChunks: EncodedChunkOutput[],
): Promise<void> => {
  const digest = await snapshotHash(chunkItem.bytes);
  const key = snapshotChunkKey(collectionPrefix, incarnation, digest);
  const descriptor: SnapshotChunkDescriptor = {
    first_id: chunkItem.docs[0]!["_id"] as string,
    last_id: chunkItem.docs.at(-1)!["_id"] as string,
    key,
    byte_length: chunkItem.bytes.byteLength,
    row_count: chunkItem.docs.length,
  };
  finalDescriptors.push(descriptor);
  changedChunks.push({ descriptor, bytes: chunkItem.bytes });
};

/**
 * Pure builder/evaluator for snapshot chunks.
 */
export const buildSnapshotChunks = async (
  input: BuildSnapshotChunksInput,
): Promise<SnapshotChunkBuildResult> => {
  const {
    collection,
    collectionPrefix,
    descriptors,
    loadedChunks,
    mutations,
    incarnation,
    policy,
    lockedDirectOwnerIndex,
    selectedNeighborIndex,
  } = input;

  if (collection.length === 0) {
    invalid("InvalidConfig", "collection must be non-empty");
  }
  if (collectionPrefix.length === 0 || collectionPrefix.endsWith("/")) {
    invalid("InvalidConfig", "collectionPrefix must be non-empty without a trailing slash");
  }
  if (!INCARNATION_PATTERN.test(incarnation)) {
    invalid("InvalidConfig", "incarnation must be 32 lowercase hex characters");
  }

  // Collapse mutations to last-write-wins per doc_id
  const collapsedMutations = new Map<string, ReferenceMutation>();
  if (Array.isArray(mutations)) {
    for (const mutation of mutations) {
      assertSnapshotDocId(mutation.doc_id);
      collapsedMutations.set(mutation.doc_id, mutation);
    }
  } else if (mutations instanceof Map) {
    for (const [docId, mutation] of mutations) {
      assertSnapshotDocId(docId);
      collapsedMutations.set(docId, mutation);
    }
  }

  // Group mutations by target descriptor index (or group 0 for empty collection)
  const groupMutations = new Map<number, ReferenceMutation[]>();
  const isInitialEmpty = descriptors.length === 0;

  for (const [docId, mutation] of collapsedMutations) {
    if (isInitialEmpty) {
      if (mutation.op !== "D") {
        let groupList = groupMutations.get(0);
        if (groupList === undefined) {
          groupList = [];
          groupMutations.set(0, groupList);
        }
        groupList.push(mutation);
      }
    } else {
      const targetIndex = routeMutationToDescriptor(docId, mutation.op, descriptors);
      if (targetIndex !== null) {
        let groupList = groupMutations.get(targetIndex);
        if (groupList === undefined) {
          groupList = [];
          groupMutations.set(targetIndex, groupList);
        }
        groupList.push(mutation);
      }
    }
  }

  const directTouchedIndexes = new Set<number>(groupMutations.keys());

  // Track rewritten groups
  const rewrittenGroupSplitChunks = new Map<number, SplitChunkItem[]>();
  const unchangedGroupIndexes = new Set<number>();

  let totalSplitIncrements = 0;

  if (isInitialEmpty) {
    const emptyGroupMutations = groupMutations.get(0) ?? [];
    if (emptyGroupMutations.length > 0) {
      const docMap = new Map<string, DocumentData>();
      for (const mut of emptyGroupMutations) {
        if (mut.op === "D") {
          docMap.delete(mut.doc_id);
        } else {
          docMap.set(mut.doc_id, mut.after);
        }
      }
      const updatedDocs = [...docMap.values()].toSorted((a, b) =>
        compareDocIds(a["_id"] as string, b["_id"] as string),
      );

      if (updatedDocs.length > 0) {
        const splitChunks = splitGroupDocsGreedily(updatedDocs, collection, incarnation, policy);
        rewrittenGroupSplitChunks.set(0, splitChunks);
        totalSplitIncrements += Math.max(0, splitChunks.length - 1);
      }
    }
  } else {
    for (const groupIndex of directTouchedIndexes) {
      const descriptor = descriptors[groupIndex]!;
      const initialDocs = getLoadedDocs(loadedChunks, descriptor);
      const mutationsForGroup = groupMutations.get(groupIndex)!;

      const docMap = new Map<string, DocumentData>();
      for (const d of initialDocs) {
        docMap.set(d["_id"] as string, d);
      }
      for (const mut of mutationsForGroup) {
        if (mut.op === "D") {
          docMap.delete(mut.doc_id);
        } else {
          docMap.set(mut.doc_id, mut.after);
        }
      }

      const updatedDocs = [...docMap.values()].toSorted((a, b) =>
        compareDocIds(a["_id"] as string, b["_id"] as string),
      );

      if (areDocListsEqual(initialDocs, updatedDocs)) {
        unchangedGroupIndexes.add(groupIndex);
      } else if (updatedDocs.length === 0) {
        rewrittenGroupSplitChunks.set(groupIndex, []);
        // Deleted group contributes max(0, 0 - 1) = 0 split increments
      } else {
        const splitChunks = splitGroupDocsGreedily(updatedDocs, collection, incarnation, policy);
        rewrittenGroupSplitChunks.set(groupIndex, splitChunks);
        totalSplitIncrements += Math.max(0, splitChunks.length - 1);
      }
    }
  }

  // Facing-boundary merge evaluation
  const usedNeighborChunkIndex =
    isInitialEmpty || lockedDirectOwnerIndex === null || selectedNeighborIndex === null
      ? null
      : applyFacingMerge({
          descriptors,
          loadedChunks,
          collection,
          incarnation,
          policy,
          lockedDirectOwnerIndex,
          selectedNeighborIndex,
          directTouchedIndexes,
          unchangedGroupIndexes,
          ownerSplitChunks: rewrittenGroupSplitChunks.get(lockedDirectOwnerIndex),
        });

  // Assemble final descriptor array and changed chunks
  const finalDescriptors: SnapshotChunkDescriptor[] = [];
  const changedChunks: EncodedChunkOutput[] = [];

  if (isInitialEmpty) {
    const splitChunks = rewrittenGroupSplitChunks.get(0) ?? [];
    for (const chunkItem of splitChunks) {
      await appendChunkOutput(
        chunkItem,
        collectionPrefix,
        incarnation,
        finalDescriptors,
        changedChunks,
      );
    }
  } else {
    for (let i = 0; i < descriptors.length; i++) {
      if (i === usedNeighborChunkIndex) {
        continue;
      }
      if (!directTouchedIndexes.has(i) || unchangedGroupIndexes.has(i)) {
        finalDescriptors.push(descriptors[i]!);
        continue;
      }
      const splitChunks = rewrittenGroupSplitChunks.get(i) ?? [];
      for (const chunkItem of splitChunks) {
        await appendChunkOutput(
          chunkItem,
          collectionPrefix,
          incarnation,
          finalDescriptors,
          changedChunks,
        );
      }
    }
  }

  return {
    chunks: finalDescriptors,
    changed_chunks: changedChunks,
    split_increments: totalSplitIncrements,
    used_neighbor_chunk_index: usedNeighborChunkIndex,
  };
};

function splitGroupDocsGreedily(
  docs: readonly DocumentData[],
  collection: string,
  incarnation: string,
  policy: SnapshotChunkBoundaryPolicy,
): SplitChunkItem[] {
  const result: SplitChunkItem[] = [];
  let start = 0;

  while (start < docs.length) {
    let end = Math.min(start + policy.target_rows, docs.length);
    while (end > start) {
      const candidateDocs = docs.slice(start, end);
      const candidateChunk: SnapshotChunk = {
        schema_version: 2,
        collection,
        incarnation,
        first_id: candidateDocs[0]!["_id"] as string,
        last_id: candidateDocs.at(-1)!["_id"] as string,
        docs: candidateDocs,
      };
      const candidateBytes = encodeBuilderChunk(candidateChunk);

      if (candidateBytes.byteLength <= policy.target_chunk_bytes || end === start + 1) {
        if (candidateBytes.byteLength > MAX_CHUNK_BYTES) {
          invalid("InvalidResponse", "document exceeds hard chunk byte maximum");
        }
        result.push({ docs: candidateDocs, bytes: candidateBytes });
        start = end;
        break;
      }
      end--;
    }
  }

  return result;
}
