import { fc, test as fcTest } from "@fast-check/vitest";
import {
  type DocumentData,
  type DocumentValue,
  type LogEntry,
  snapshotHash,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import {
  type ChunkedFoldBudget,
  planChunkedFold,
  prefetchChunkedFold,
} from "./chunked-fold-planner.ts";
import {
  CHUNK_BOUNDARY_POLICIES,
  type SnapshotChunkBoundaryPolicy,
} from "./snapshot-chunk-builder.ts";
import { encodeSnapshotChunk, snapshotChunkKey } from "./snapshot-chunk.ts";
import { compareDocIds } from "./snapshot-doc-id.ts";
import type { SnapshotChunkDescriptor } from "./snapshot-manifest.ts";

const collection = "tickets";
const collectionPrefix = "app/demo/tenant/acme/manifests/tickets";
const incarnation = "00112233445566778899aabbccddeeff";

const doc = (id: string, value: DocumentValue = 1): DocumentData => ({ _id: id, value });

const createChunkBytes = (docs: readonly DocumentData[]): Uint8Array =>
  encodeSnapshotChunk({
    schema_version: 2,
    collection,
    incarnation,
    first_id: docs[0]!["_id"] as string,
    last_id: docs.at(-1)!["_id"] as string,
    docs,
  });

const createDescriptor = async (
  docs: readonly DocumentData[],
): Promise<SnapshotChunkDescriptor> => {
  const bytes = createChunkBytes(docs);
  const digest = await snapshotHash(bytes);
  return {
    first_id: docs[0]!["_id"] as string,
    last_id: docs.at(-1)!["_id"] as string,
    key: snapshotChunkKey(collectionPrefix, incarnation, digest),
    byte_length: bytes.byteLength,
    row_count: docs.length,
  };
};

const makeLogEntry = (
  seq: number,
  op: "I" | "U" | "D",
  docId: string,
  after?: DocumentData,
): LogEntry => ({
  lsn: `0000000000_session_${seq.toString(32).padStart(6, "0")}`,
  commit_ts: "2026-08-15T10:00:00.000Z",
  op,
  collection,
  doc_id: docId,
  after,
  session: "session",
  seq,
});

const defaultBudget: ChunkedFoldBudget = {
  max_log_entries: 100,
  max_mutation_bytes: 1024 * 1024,
  max_touched_chunks: 8,
  max_touched_bytes: 2 * 1024 * 1024,
  max_split_increments: 4,
  max_neighbor_chunks: 1,
};

describe("chunked fold planner", () => {
  test("prefetch stops before exceeding max_log_entries", async () => {
    const d0Docs = [doc("a", 1), doc("b", 2)];
    const d0Desc = await createDescriptor(d0Docs);

    const entries: LogEntry[] = [
      makeLogEntry(1, "U", "a", doc("a", 10)),
      makeLogEntry(2, "U", "b", doc("b", 20)),
      makeLogEntry(3, "I", "c", doc("c", 30)),
    ];

    const prefetch = prefetchChunkedFold({
      entries,
      descriptors: [d0Desc],
      budget: { ...defaultBudget, max_log_entries: 2 },
    });

    expect(prefetch.candidate_log_seq_ends).toEqual([1, 2]);
  });

  test("prefetch accounts mutation bytes with subtraction for updated and deleted IDs", async () => {
    const d0Docs = [doc("a", 1), doc("b", 2)];
    const d0Desc = await createDescriptor(d0Docs);

    const docA1 = doc("a", "x".repeat(100));
    const docA2 = doc("a", 10);

    const entries: LogEntry[] = [
      makeLogEntry(1, "U", "a", docA1), // ~150 bytes
      makeLogEntry(2, "U", "a", docA2), // replaces docA1 with small doc ~30 bytes
    ];

    const prefetch = prefetchChunkedFold({
      entries,
      descriptors: [d0Desc],
      budget: { ...defaultBudget, max_mutation_bytes: 50 },
    });

    // Entry 1 alone exceeds 50 bytes -> candidate 1 rejected!
    expect(prefetch.candidate_log_seq_ends).toEqual([]);
  });

  test("prefetch locks the first non-null owner/neighbor pair and stops when ownership changes", async () => {
    const d0Docs = [doc("a", 1), doc("b", 2)];
    const d1Docs = [doc("m", 10), doc("n", 20)];
    const d0Desc = await createDescriptor(d0Docs);
    const d1Desc = await createDescriptor(d1Docs);

    const entries: LogEntry[] = [
      makeLogEntry(1, "D", "z"), // Gap delete: no owner, does not lock
      makeLogEntry(2, "U", "m", doc("m", 99)), // Touches D1 (index 1). Leftmost owner = 1, neighbor = 0. Locks (1, 0)
      makeLogEntry(3, "U", "a", doc("a", 99)), // Touches D0 (index 0). Leftmost owner would become 0 != 1! Must stop before entry 3
    ];

    const prefetch = prefetchChunkedFold({
      entries,
      descriptors: [d0Desc, d1Desc],
      budget: defaultBudget,
    });

    expect(prefetch.candidate_log_seq_ends).toEqual([1, 2]);
    expect(prefetch.leftmost_direct_owner_index).toBe(1);
    expect(prefetch.selected_neighbor_index).toBe(0);
    expect(prefetch.chunk_indexes).toEqual([0, 1]);
  });

  test("regression: D0/D1 gap insert locks (0, 1); subsequent delete collapses to gap delete and stops before delete", async () => {
    // D0: [a, b], D1: [m, n].
    // Entry 1: insert "c" (gap between D0 and D1, assigned to D0). Locks (0, 1).
    // Entry 2: delete "c". Collapses insert+delete to delete "c" (gap delete -> touches no descriptor, owner becomes null).
    // Entry 3: update "m" (D1).
    // Prefetch must stop before Entry 2!
    const d0Docs = [doc("a", 1), doc("b", 2)];
    const d1Docs = [doc("m", 10), doc("n", 20)];
    const d0Desc = await createDescriptor(d0Docs);
    const d1Desc = await createDescriptor(d1Docs);

    const entries: LogEntry[] = [
      makeLogEntry(1, "I", "c", doc("c", 3)),
      makeLogEntry(2, "D", "c"),
      makeLogEntry(3, "U", "m", doc("m", 99)),
    ];

    const prefetch = prefetchChunkedFold({
      entries,
      descriptors: [d0Desc, d1Desc],
      budget: defaultBudget,
    });

    expect(prefetch.candidate_log_seq_ends).toEqual([1]);
    expect(prefetch.leftmost_direct_owner_index).toBe(0);
    expect(prefetch.selected_neighbor_index).toBe(1);
  });

  test("exact selection stops before exceeding split increments budget", async () => {
    const customPolicy: SnapshotChunkBoundaryPolicy = {
      target_chunk_bytes: 1024 * 1024,
      target_rows: 2,
    };
    const d0Docs = [doc("a", 1), doc("b", 2)];
    const d0Desc = await createDescriptor(d0Docs);

    const loadedChunks = new Map<string, readonly DocumentData[]>([[d0Desc.key, d0Docs]]);

    const entries: LogEntry[] = [
      makeLogEntry(1, "I", "c", doc("c", 3)),
      makeLogEntry(2, "I", "d", doc("d", 4)),
      makeLogEntry(3, "I", "e", doc("e", 5)),
    ];

    const plan = await planChunkedFold({
      collection,
      collectionPrefix,
      entries,
      descriptors: [d0Desc],
      loadedChunks,
      budget: { ...defaultBudget, max_split_increments: 1 },
      incarnation,
      policy: customPolicy,
    });

    expect(plan).not.toBeNull();
    expect(plan!.log_seq_end).toBe(2);
    expect(plan!.split_increments).toBe(1);
  });

  test("empty entries plan is a no-op that echoes descriptors and honors baseLogSeq", async () => {
    const d0Docs = [doc("a", 1), doc("b", 2)];
    const d0Desc = await createDescriptor(d0Docs);

    const loadedChunks = new Map<string, readonly DocumentData[]>([[d0Desc.key, d0Docs]]);

    const planChunk = (baseLogSeq?: number) =>
      planChunkedFold({
        collection,
        collectionPrefix,
        entries: [],
        descriptors: [d0Desc],
        loadedChunks,
        budget: defaultBudget,
        incarnation,
        policy: CHUNK_BOUNDARY_POLICIES["c128-r512"],
        baseLogSeq,
      });

    const withBase = await planChunk(41);
    expect(withBase).not.toBeNull();
    expect(withBase!.log_seq_end).toBe(41);
    expect(withBase!.touched_chunk_indexes).toEqual([]);
    expect(withBase!.touched_ranges).toEqual([]);
    expect(withBase!.mutation_bytes).toBe(0);
    expect(withBase!.split_increments).toBe(0);
    expect(withBase!.used_neighbor_chunk_index).toBeNull();
    expect(withBase!.mutations.size).toBe(0);
    expect(withBase!.build.chunks).toEqual([d0Desc]);
    expect(withBase!.build.changed_chunks).toEqual([]);

    const withoutBase = await planChunk();
    expect(withoutBase).not.toBeNull();
    expect(withoutBase!.log_seq_end).toBe(0);
  });

  test("non-empty entries with no admissible candidate returns null", async () => {
    const d0Docs = [doc("a", 1), doc("b", 2)];
    const d0Desc = await createDescriptor(d0Docs);

    const loadedChunks = new Map<string, readonly DocumentData[]>([[d0Desc.key, d0Docs]]);

    const entries: LogEntry[] = [makeLogEntry(1, "U", "a", doc("a", "x".repeat(100)))];

    const plan = await planChunkedFold({
      collection,
      collectionPrefix,
      entries,
      descriptors: [d0Desc],
      loadedChunks,
      budget: { ...defaultBudget, max_mutation_bytes: 10 },
      incarnation,
      policy: CHUNK_BOUNDARY_POLICIES["c128-r512"],
    });

    expect(plan).toBeNull();
  });

  test("suffix non-interference: appending suffix entries after admitted prefix does not alter plan output", async () => {
    const d0Docs = [doc("a", 1), doc("b", 2)];
    const d1Docs = [doc("m", 10), doc("n", 20)];
    const d0Desc = await createDescriptor(d0Docs);
    const d1Desc = await createDescriptor(d1Docs);

    const loadedChunks = new Map<string, readonly DocumentData[]>([
      [d0Desc.key, d0Docs],
      [d1Desc.key, d1Docs],
    ]);

    const baseEntries: LogEntry[] = [makeLogEntry(1, "U", "a", doc("a", 100))];

    const extendedEntries: LogEntry[] = [
      ...baseEntries,
      makeLogEntry(2, "U", "b", doc("b", 200)),
      makeLogEntry(3, "U", "m", doc("m", 300)),
    ];

    const planBase = await planChunkedFold({
      collection,
      collectionPrefix,
      entries: baseEntries,
      descriptors: [d0Desc, d1Desc],
      loadedChunks,
      budget: { ...defaultBudget, max_log_entries: 1 },
      incarnation,
      policy: CHUNK_BOUNDARY_POLICIES["c128-r512"],
    });

    const planExtended = await planChunkedFold({
      collection,
      collectionPrefix,
      entries: extendedEntries,
      descriptors: [d0Desc, d1Desc],
      loadedChunks,
      budget: { ...defaultBudget, max_log_entries: 1 },
      incarnation,
      policy: CHUNK_BOUNDARY_POLICIES["c128-r512"],
    });

    expect(planBase).not.toBeNull();
    expect(planExtended).not.toBeNull();
    expect(planBase!.log_seq_end).toBe(1);
    expect(planExtended!.log_seq_end).toBe(1);
    expect(planBase!.touched_chunk_indexes).toEqual(planExtended!.touched_chunk_indexes);
    expect(planBase!.touched_ranges).toEqual(planExtended!.touched_ranges);
    expect(planBase!.mutation_bytes).toBe(planExtended!.mutation_bytes);
    expect(planBase!.split_increments).toBe(planExtended!.split_increments);
    expect(planBase!.build.chunks).toEqual(planExtended!.build.chunks);
  });

  test("admits a prefix spanning the locked pair and a distant chunk", async () => {
    const policy: SnapshotChunkBoundaryPolicy = {
      target_chunk_bytes: 10_000,
      target_rows: 4,
    };
    const d0Docs = [doc("a", 1), doc("b", 2), doc("c", 3)]; // 3 rows -> not underfull (< 2)
    const d1Docs = [doc("d", 4)];
    const d2Docs = [doc("g", 7), doc("h", 8)];
    const d3Docs = [doc("x", 24), doc("y", 25)];

    const d0Desc = await createDescriptor(d0Docs);
    const d1Desc = await createDescriptor(d1Docs);
    const d2Desc = await createDescriptor(d2Docs);
    const d3Desc = await createDescriptor(d3Docs);

    const loadedChunks = new Map<string, readonly DocumentData[]>([
      [d0Desc.key, d0Docs],
      [d1Desc.key, d1Docs],
      [d2Desc.key, d2Docs],
      [d3Desc.key, d3Docs],
    ]);

    const entries: LogEntry[] = [
      makeLogEntry(1, "U", "a", doc("a", 100)), // Touches D0 -> locks (0, 1)
      makeLogEntry(2, "D", "y"), // Touches D3
    ];

    const plan = await planChunkedFold({
      collection,
      collectionPrefix,
      entries,
      descriptors: [d0Desc, d1Desc, d2Desc, d3Desc],
      loadedChunks,
      budget: defaultBudget,
      incarnation,
      policy,
    });

    // Planner-level contract only: both entries are admitted into one plan
    // whose touched set spans the locked pair (D0/D1) and the distant D3.
    // The builder-internal merge non-interference for this exact layout is
    // covered by snapshot-chunk-builder.test.ts ("regression: D0 locks D1,
    // ... D1 and D3 must NOT merge").
    expect(plan).not.toBeNull();
    expect(plan!.log_seq_end).toBe(2);
    expect(plan!.touched_chunk_indexes).toEqual([0, 3]);
  });
});

const idArb = fc.oneof(
  fc.stringMatching(/^[a-z][a-z0-9]{0,4}$/),
  fc.constantFrom("é", "e\u0301", "\u{10000}", "\u{1f4a9}"),
);

fcTest.prop({
  allIds: fc.uniqueArray(idArb, { minLength: 2, maxLength: 16 }),
  initialFraction: fc.double({ min: 0.2, max: 0.8, noNaN: true }),
  chunkPartitionSizes: fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 4 }),
  logOps: fc.array(
    fc.record({
      op: fc.constantFrom<"I" | "U" | "D">("I", "U", "D"),
      idIndex: fc.nat(),
      value: fc.integer(),
    }),
    { minLength: 1, maxLength: 15 },
  ),
  floor: fc.integer({ min: 10, max: 500 }),
  budgetCap: fc.integer({ min: 1, max: 10 }),
})(
  "planner determinism and monotone progress as budgets increase",
  async ({ allIds, initialFraction, chunkPartitionSizes, logOps, floor, budgetCap }) => {
    const sortedIds = [...allIds].toSorted(compareDocIds);
    const initialCount = Math.floor(sortedIds.length * initialFraction);
    const initialIds = sortedIds.slice(0, initialCount);

    const initialChunksDocs: DocumentData[][] = [];
    let idPointer = 0;
    for (const size of chunkPartitionSizes) {
      if (idPointer >= initialIds.length) {
        break;
      }
      const chunkDocs = initialIds
        .slice(idPointer, idPointer + size)
        .map((id, index) => doc(id, index));
      if (chunkDocs.length > 0) {
        initialChunksDocs.push(chunkDocs);
        idPointer += size;
      }
    }
    if (idPointer < initialIds.length) {
      initialChunksDocs.push(initialIds.slice(idPointer).map((id, index) => doc(id, index)));
    }

    const descriptors: SnapshotChunkDescriptor[] = [];
    const loadedChunks = new Map<string, readonly DocumentData[]>();

    for (let i = 0; i < initialChunksDocs.length; i++) {
      const chunkDocs = initialChunksDocs[i]!;
      const descriptor = await createDescriptor(chunkDocs);
      descriptors.push(descriptor);
      loadedChunks.set(descriptor.key, chunkDocs);
    }

    const entries: LogEntry[] = logOps.map(({ op, idIndex, value }, index) => {
      const id = sortedIds[idIndex % sortedIds.length]!;
      const seq = floor + index;
      return makeLogEntry(seq, op, id, op === "D" ? undefined : doc(id, value));
    });

    const smallBudget: ChunkedFoldBudget = {
      ...defaultBudget,
      max_log_entries: budgetCap,
    };
    const largerBudget: ChunkedFoldBudget = {
      ...defaultBudget,
      max_log_entries: budgetCap + 5,
    };

    const planSmall1 = await planChunkedFold({
      collection,
      collectionPrefix,
      entries,
      descriptors,
      loadedChunks,
      budget: smallBudget,
      incarnation,
      policy: CHUNK_BOUNDARY_POLICIES["c128-r512"],
      baseLogSeq: floor - 1,
    });

    const planSmall2 = await planChunkedFold({
      collection,
      collectionPrefix,
      entries,
      descriptors,
      loadedChunks,
      budget: smallBudget,
      incarnation,
      policy: CHUNK_BOUNDARY_POLICIES["c128-r512"],
      baseLogSeq: floor - 1,
    });

    // Determinism
    expect(planSmall1).toEqual(planSmall2);

    const planLarger = await planChunkedFold({
      collection,
      collectionPrefix,
      entries,
      descriptors,
      loadedChunks,
      budget: largerBudget,
      incarnation,
      policy: CHUNK_BOUNDARY_POLICIES["c128-r512"],
      baseLogSeq: floor - 1,
    });

    // Monotonicity: larger budget yields log_seq_end >= smaller budget
    if (planSmall1 !== null && planLarger !== null) {
      expect(planLarger.log_seq_end).toBeGreaterThanOrEqual(planSmall1.log_seq_end);
    }

    // Invariant: no reads outside prefetch
    if (planSmall1 !== null) {
      for (const idx of planSmall1.touched_chunk_indexes) {
        expect(planSmall1.prefetch.chunk_indexes).toContain(idx);
      }
    }
  },
);
