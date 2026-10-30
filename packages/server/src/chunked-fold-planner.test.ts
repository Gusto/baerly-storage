import { fc, test as fcTest } from "@fast-check/vitest";
import {
  BaerlyError,
  type DocumentData,
  type DocumentValue,
  type LogEntry,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import {
  type ChunkedFoldBudget,
  type ChunkedFoldPlan,
  planChunkedFold,
  prefetchChunkedFold,
} from "./chunked-fold-planner.ts";
import {
  foldChunkedSnapshotReference,
  type ReferenceMutation,
  type ReferenceRow,
} from "./chunked-snapshot-reference.ts";
import { decodeSnapshotChunk } from "./snapshot-chunk.ts";
import {
  buildSnapshotChunks,
  CHUNK_BOUNDARY_POLICIES,
  type SnapshotChunkBoundaryPolicy,
} from "./snapshot-chunk-builder.ts";
import { compareDocIds } from "./snapshot-doc-id.ts";
import type { SnapshotChunkDescriptor } from "./snapshot-manifest.ts";
import { makeSnapshotChunkFixtures } from "../../../tests/fixtures/snapshot-chunks.ts";
import { postImageIdentityViolations } from "../../../tests/fixtures/post-image-identity-violations.ts";
import {
  makeValidDocIdArb,
  validDocIdArb,
} from "../../../tests/fixtures/scalar-doc-id-arbitraries.ts";

const collection = "tickets";
const collectionPrefix = "app/demo/tenant/acme/manifests/tickets";
const incarnation = "00112233445566778899aabbccddeeff";

const doc = (id: string, value: DocumentValue = 1): DocumentData => ({ _id: id, value });

const { createDescriptor } = makeSnapshotChunkFixtures({
  collection,
  collectionPrefix,
  incarnation,
});

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

  test("prefetch stops before exceeding max_touched_chunks", async () => {
    const d0Docs = [doc("a", 1), doc("b", 2)];
    const d1Docs = [doc("m", 10), doc("n", 20)];
    const d0Desc = await createDescriptor(d0Docs);
    const d1Desc = await createDescriptor(d1Docs);

    const entries: LogEntry[] = [
      makeLogEntry(1, "U", "a", doc("a", 10)), // direct = {0}; locks (0, 1)
      makeLogEntry(2, "U", "m", doc("m", 99)), // direct = {0, 1} -> size 2 > 1
    ];

    const prefetch = prefetchChunkedFold({
      entries,
      descriptors: [d0Desc, d1Desc],
      budget: { ...defaultBudget, max_touched_chunks: 1 },
    });

    // The size check breaks before entry 2 is admitted.
    expect(prefetch.candidate_log_seq_ends).toEqual([1]);
    expect(prefetch.directly_touched_chunk_indexes).toEqual([0]);
  });

  test("regression: cumulative touched-chunk count stops the walk when the union across endpoints crosses the ceiling", async () => {
    // D0: [a, b], D1: [m], D2: [p]. Entry 1 updates a D0 doc and locks
    // (owner 0, neighbor 1). The insert/delete pair for "n" (gap between
    // D1 and D2) adds D1's direct touch and then collapses it away (gap
    // delete -> null target, D1 refcount drops to 0), so every endpoint's
    // live direct set stays within 2 — but the union across accepted
    // endpoints keeps D1, and the final "z" insert (gap right of D2,
    // direct {0, 2}) would push the union to {0, 1, 2} > 2. Only the
    // cumulative count check stops it: the locked pair (0, 1) is
    // re-derived unchanged at every endpoint, so the pair lock never fires.
    const d0Docs = [doc("a", 1), doc("b", 2)];
    const d1Docs = [doc("m", 10)];
    const d2Docs = [doc("p", 20)];
    const d0Desc = await createDescriptor(d0Docs);
    const d1Desc = await createDescriptor(d1Docs);
    const d2Desc = await createDescriptor(d2Docs);

    const entries: LogEntry[] = [
      makeLogEntry(1, "U", "a", doc("a", 10)), // direct {0}; locks (0, 1)
      makeLogEntry(2, "I", "n", doc("n", 3)), // gap right of D1 -> direct {0, 1}
      makeLogEntry(3, "D", "n"), // gap delete -> direct {0}; union keeps {0, 1}
      makeLogEntry(4, "I", "z", doc("z", 4)), // direct {0, 2}; union {0, 1, 2} -> 3 > 2
    ];

    const prefetch = prefetchChunkedFold({
      entries,
      descriptors: [d0Desc, d1Desc, d2Desc],
      budget: { ...defaultBudget, max_touched_chunks: 2 },
    });

    expect(prefetch.candidate_log_seq_ends).toEqual([1, 2, 3]);
    expect(prefetch.directly_touched_chunk_indexes).toEqual([0, 1]);
    // The pair stayed locked — the count check is what fired, not the pair lock.
    expect(prefetch.leftmost_direct_owner_index).toBe(0);
    expect(prefetch.selected_neighbor_index).toBe(1);
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

  test("regression: cumulative touched-byte bound stops the walk when the union across endpoints crosses the ceiling", async () => {
    // Four byte-identical descriptors D0..D3. Entry 1 updates a D0 doc and
    // locks (owner 0, neighbor 1). Each [I, D] pair inserts into the gap
    // right of D_k (direct {0, k}) and deletes it again (collapses to a gap
    // delete, direct {0}) — the locked pair never changes, so the pair lock
    // cannot stop the walk. Every endpoint's per-endpoint direct ∪ neighbor
    // set stays within 3 descriptors, but the union across accepted
    // endpoints grows to {0, 1, 2, 3}; only the cumulative bound stops it.
    const pad = "x".repeat(700);
    const d0Docs = [doc("a", pad), doc("b", pad)];
    const d1Docs = [doc("m", pad), doc("n", pad)];
    const d2Docs = [doc("q", pad), doc("r", pad)];
    const d3Docs = [doc("u", pad), doc("v", pad)];
    const d0Desc = await createDescriptor(d0Docs);
    const d1Desc = await createDescriptor(d1Docs);
    const d2Desc = await createDescriptor(d2Docs);
    const d3Desc = await createDescriptor(d3Docs);
    const perDescriptorBytes = d0Desc.byte_length;
    expect(d1Desc.byte_length).toBe(perDescriptorBytes);
    expect(d2Desc.byte_length).toBe(perDescriptorBytes);
    expect(d3Desc.byte_length).toBe(perDescriptorBytes);

    const descriptors = [d0Desc, d1Desc, d2Desc, d3Desc];
    const budget: ChunkedFoldBudget = {
      ...defaultBudget,
      // Union {0, 1, 2} plus the locked neighbor {1} reaches exactly the
      // ceiling; {0, 1, 2, 3} crosses it. Under per-endpoint accounting the
      // 6th endpoint ({0, 3} plus neighbor {1} = 3 descriptors) would pass.
      max_touched_bytes: 3 * perDescriptorBytes,
    };

    const entries: LogEntry[] = [
      makeLogEntry(1, "U", "a", doc("a", 99)), // direct {0}; locks (0, 1)
      makeLogEntry(2, "I", "p", doc("p", 5)), // gap right of D1 -> direct {0, 1}
      makeLogEntry(3, "D", "p"), // gap delete -> direct {0}
      makeLogEntry(4, "I", "s", doc("s", 5)), // gap right of D2 -> direct {0, 2}; union hits the ceiling
      makeLogEntry(5, "D", "s"), // gap delete -> direct {0}
      makeLogEntry(6, "I", "z", doc("z", 5)), // union would cross the ceiling -> stop
      makeLogEntry(7, "D", "z"), // never reached
    ];

    const prefetch = prefetchChunkedFold({ entries, descriptors, budget });

    expect(prefetch.candidate_log_seq_ends).toEqual([1, 2, 3, 4, 5]);
    expect(prefetch.directly_touched_chunk_indexes).toEqual([0, 1, 2]);
    expect(prefetch.chunk_indexes).toEqual([0, 1, 2]);
    expect(prefetch.touched_bytes).toBe(3 * perDescriptorBytes);

    const loadedChunks = new Map<string, readonly DocumentData[]>([
      [d0Desc.key, d0Docs],
      [d1Desc.key, d1Docs],
      [d2Desc.key, d2Docs],
      [d3Desc.key, d3Docs],
    ]);
    const plan = await planChunkedFold({
      collection,
      collectionPrefix,
      entries,
      descriptors,
      loadedChunks,
      budget,
      incarnation,
      policy: { target_chunk_bytes: 10_000, target_rows: 4 },
    });
    expect(plan!.log_seq_end).toBe(5);
    expect(plan!.touched_chunk_indexes).toEqual([0]);
  });

  test("stored log entry with non-scalar doc_id fails with InvalidResponse", async () => {
    const d0Docs = [doc("a", 1), doc("b", 2)];
    const d0Desc = await createDescriptor(d0Docs);

    const entries: LogEntry[] = [
      makeLogEntry(1, "U", "a", doc("a", 10)),
      makeLogEntry(2, "I", "bad\ud800id", doc("bad\ud800id", 5)),
    ];

    // A stored doc_id that is not scalar-orderable is a stored-data failure
    // (ADR-007: InvalidResponse), even though assertSnapshotDocId itself
    // throws InvalidConfig for caller ingress.
    try {
      prefetchChunkedFold({ entries, descriptors: [d0Desc], budget: defaultBudget });
      expect.unreachable("prefetchChunkedFold must throw on a non-scalar stored doc_id");
    } catch (error) {
      expect((error as BaerlyError).code).toBe("InvalidResponse");
    }

    await expect(
      planChunkedFold({
        collection,
        collectionPrefix,
        entries,
        descriptors: [d0Desc],
        loadedChunks: new Map<string, readonly DocumentData[]>([[d0Desc.key, d0Docs]]),
        budget: defaultBudget,
        incarnation,
        policy: CHUNK_BOUNDARY_POLICIES["c128-r512"],
      }),
    ).rejects.toMatchObject({ code: "InvalidResponse" });
  });

  test("stored insert/update entry missing its after post-image fails with InvalidResponse", async () => {
    const d0Docs = [doc("a", 1), doc("b", 2)];
    const d0Desc = await createDescriptor(d0Docs);

    // An I/U entry without a post-image is a stored-data failure
    // (ADR-007: InvalidResponse), raised by entryToMutation.
    const entries: LogEntry[] = [makeLogEntry(1, "U", "a")]; // no after

    try {
      prefetchChunkedFold({ entries, descriptors: [d0Desc], budget: defaultBudget });
      expect.unreachable("prefetchChunkedFold must throw on a missing post-image");
    } catch (error) {
      expect((error as BaerlyError).code).toBe("InvalidResponse");
    }

    await expect(
      planChunkedFold({
        collection,
        collectionPrefix,
        entries,
        descriptors: [d0Desc],
        loadedChunks: new Map<string, readonly DocumentData[]>([[d0Desc.key, d0Docs]]),
        budget: defaultBudget,
        incarnation,
        policy: CHUNK_BOUNDARY_POLICIES["c128-r512"],
      }),
    ).rejects.toMatchObject({ code: "InvalidResponse" });
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
    expect(plan!.build.split_increments).toBe(1);
  });

  test("returned build equals one builder run at the admitted prefix", async () => {
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
    const input = {
      collection,
      collectionPrefix,
      entries,
      descriptors: [d0Desc],
      loadedChunks,
      budget: { ...defaultBudget, max_split_increments: 1 },
      incarnation,
      policy: customPolicy,
    };

    const plan = await planChunkedFold(input);
    expect(plan).not.toBeNull();
    expect(plan!.log_seq_end).toBe(2);

    const rebuilt = await buildSnapshotChunks({
      collection,
      collectionPrefix,
      descriptors: [d0Desc],
      loadedChunks,
      mutations: plan!.mutations,
      incarnation,
      policy: customPolicy,
      lockedDirectOwnerIndex: plan!.prefetch.leftmost_direct_owner_index,
      selectedNeighborIndex: plan!.prefetch.selected_neighbor_index,
    });
    expect(plan!.build).toEqual(rebuilt);
  });

  test("exact selection stops before exceeding the neighbor budget", async () => {
    // Underfull is strict on both axes: with target_rows 4, a D0 group of 2
    // rows is not underfull, 1 row is. Endpoint 1 (update a) leaves D0 at 2
    // rows -> no merge; endpoint 2 (delete b) drops D0 to 1 row -> the
    // facing merge consumes the locked neighbor D1.
    const policy: SnapshotChunkBoundaryPolicy = { target_chunk_bytes: 10_000, target_rows: 4 };
    const d0Docs = [doc("a", 1), doc("b", 2)];
    const d1Docs = [doc("m", 10)];
    const d0Desc = await createDescriptor(d0Docs);
    const d1Desc = await createDescriptor(d1Docs);

    const loadedChunks = new Map<string, readonly DocumentData[]>([
      [d0Desc.key, d0Docs],
      [d1Desc.key, d1Docs],
    ]);

    const entries: LogEntry[] = [
      makeLogEntry(1, "U", "a", doc("a", 100)), // D0 keeps 2 rows -> not underfull -> no merge
      makeLogEntry(2, "D", "b"), // D0 -> 1 row -> underfull -> facing merge with D1
    ];

    const input = (budget: ChunkedFoldBudget) => ({
      collection,
      collectionPrefix,
      entries,
      descriptors: [d0Desc, d1Desc],
      loadedChunks,
      budget,
      incarnation,
      policy,
    });

    const admitted = await planChunkedFold(input(defaultBudget));
    expect(admitted!.log_seq_end).toBe(2);
    expect(admitted!.build.used_neighbor_chunk_index).toBe(1);
    expect(admitted!.build.split_increments).toBe(0);

    const stopped = await planChunkedFold(input({ ...defaultBudget, max_neighbor_chunks: 0 }));
    expect(stopped!.log_seq_end).toBe(1);
    expect(stopped!.build.used_neighbor_chunk_index).toBeNull();
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
    expect(withBase!.build.split_increments).toBe(0);
    expect(withBase!.build.used_neighbor_chunk_index).toBeNull();
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
    expect(planBase!.build.split_increments).toBe(planExtended!.build.split_increments);
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

describe("chunked fold planner: stored post-image identity", () => {
  const policy = CHUNK_BOUNDARY_POLICIES["c128-r512"];

  // D0 [a, b] and D1 [m, n]: every violation's doc_id routes into one of
  // them, so an unguarded planner would build a plan from it.
  const setup = async () => {
    const d0Docs = [doc("a", 1), doc("b", 2)];
    const d1Docs = [doc("m", 3), doc("n", 4)];
    const d0Desc = await createDescriptor(d0Docs);
    const d1Desc = await createDescriptor(d1Docs);
    return {
      descriptors: [d0Desc, d1Desc],
      loadedChunks: new Map<string, readonly DocumentData[]>([
        [d0Desc.key, d0Docs],
        [d1Desc.key, d1Docs],
      ]),
    };
  };

  const offending = (seq: number, docId: string, after: unknown): LogEntry =>
    makeLogEntry(seq, "U", docId, after as DocumentData);

  const expectBothPhasesReject = async (
    entries: readonly LogEntry[],
    budget: ChunkedFoldBudget = defaultBudget,
  ): Promise<void> => {
    const { descriptors, loadedChunks } = await setup();
    let prefetchCode: string | undefined;
    try {
      prefetchChunkedFold({ entries, descriptors, budget });
    } catch (error) {
      expect(error).toBeInstanceOf(BaerlyError);
      prefetchCode = (error as BaerlyError).code;
    }
    expect(prefetchCode).toBe("InvalidResponse");
    await expect(
      planChunkedFold({
        collection,
        collectionPrefix,
        entries,
        descriptors,
        loadedChunks,
        budget,
        incarnation,
        policy,
      }),
    ).rejects.toMatchObject({ code: "InvalidResponse" });
  };

  describe.each(postImageIdentityViolations)("$name", ({ docId, after }) => {
    test("rejects as the only entry", async () => {
      await expectBothPhasesReject([offending(1, docId, after())]);
    });

    test("rejects after an admissible prefix instead of shortening it", async () => {
      await expectBothPhasesReject([
        makeLogEntry(1, "U", "a", doc("a", 10)),
        makeLogEntry(2, "U", "b", doc("b", 20)),
        offending(3, docId, after()),
        makeLogEntry(4, "U", "n", doc("n", 40)),
      ]);
    });

    test("rejects even when a later entry rewrites the same doc_id correctly", async () => {
      await expectBothPhasesReject([
        makeLogEntry(1, "U", "a", doc("a", 10)),
        offending(2, docId, after()),
        makeLogEntry(3, "U", docId, doc(docId, 30)),
      ]);
    });
  });

  test("an offending entry that also busts the mutation-byte cap fails the call", async () => {
    // The walk converts each entry before testing the byte cap, so the
    // identity gate fires first. A shorter prefix would only defer the same
    // wedge by one fold.
    const big = "x".repeat(4096);
    const budget = { ...defaultBudget, max_mutation_bytes: 1024 };
    const { descriptors } = await setup();
    const control = prefetchChunkedFold({
      entries: [makeLogEntry(1, "U", "a", doc("a", 1)), makeLogEntry(2, "U", "m", doc("m", big))],
      descriptors,
      budget,
    });
    // The same oversized entry with a matching _id only shortens the prefix.
    expect(control.candidate_log_seq_ends).toEqual([1]);

    await expectBothPhasesReject(
      [makeLogEntry(1, "U", "a", doc("a", 1)), offending(2, "m", { _id: "zz", value: big })],
      budget,
    );
  });

  test("an offending entry past max_log_entries is outside the walk", async () => {
    const { descriptors, loadedChunks } = await setup();
    const entries = [makeLogEntry(1, "U", "a", doc("a", 10)), offending(2, "m", { _id: "zz" })];
    const budget = { ...defaultBudget, max_log_entries: 1 };
    expect(prefetchChunkedFold({ entries, descriptors, budget }).candidate_log_seq_ends).toEqual([
      1,
    ]);
    const plan = await planChunkedFold({
      collection,
      collectionPrefix,
      entries,
      descriptors,
      loadedChunks,
      budget,
      incarnation,
      policy,
    });
    expect(plan?.log_seq_end).toBe(1);
  });
});

const idArb = makeValidDocIdArb({ maxCodePoints: 5, longBand: false });

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

type IdentityViolationKind =
  | "other-id"
  | "missing"
  | "number"
  | "accessor"
  | "inherited"
  | "suffix";

/** Rebuild the logical rows a plan publishes: rewritten chunks plus untouched loaded ones. */
const planRows = async (
  plan: ChunkedFoldPlan,
  loadedChunks: ReadonlyMap<string, readonly DocumentData[]>,
): Promise<ReferenceRow[]> => {
  const changedByKey = new Map(
    plan.build.changed_chunks.map((item) => [item.descriptor.key, item]),
  );
  const rows: ReferenceRow[] = [];
  for (const descriptor of plan.build.chunks) {
    const changed = changedByKey.get(descriptor.key);
    let docs = loadedChunks.get(descriptor.key)!;
    if (changed !== undefined) {
      const decoded = await decodeSnapshotChunk(
        changed.bytes,
        descriptor.key,
        collection,
        descriptor,
      );
      docs = decoded.docs;
    }
    for (const d of docs) {
      rows.push({ _id: d["_id"] as string, body: d });
    }
  }
  return rows;
};

const toReferenceMutation = (entry: LogEntry): ReferenceMutation =>
  entry.op === "D"
    ? { op: "D", doc_id: entry.doc_id }
    : ({ op: entry.op, doc_id: entry.doc_id, after: entry.after } as ReferenceMutation);

fcTest.prop({
  allIds: fc.uniqueArray(validDocIdArb, { minLength: 2, maxLength: 12 }),
  initialFraction: fc.double({ min: 0.2, max: 0.8, noNaN: true }),
  chunkPartitionSizes: fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 4 }),
  logOps: fc.array(
    fc.record({
      op: fc.constantFrom<"I" | "U" | "D">("I", "U", "D"),
      idIndex: fc.nat(),
      value: fc.integer(),
      violation: fc.option(
        fc.record({
          kind: fc.constantFrom<IdentityViolationKind>(
            "other-id",
            "missing",
            "number",
            "accessor",
            "inherited",
            "suffix",
          ),
          otherOffset: fc.nat(),
        }),
        { freq: 4, nil: undefined },
      ),
    }),
    { minLength: 1, maxLength: 12 },
  ),
})(
  "planner and reference fold agree on stored post-image identity",
  async ({ allIds, initialFraction, chunkPartitionSizes, logOps }) => {
    const sortedIds = [...allIds].toSorted(compareDocIds);
    const initialIds = sortedIds.slice(0, Math.floor(sortedIds.length * initialFraction));

    const initialChunksDocs: DocumentData[][] = [];
    let idPointer = 0;
    for (const size of chunkPartitionSizes) {
      if (idPointer >= initialIds.length) {
        break;
      }
      initialChunksDocs.push(initialIds.slice(idPointer, idPointer + size).map((id) => doc(id, 0)));
      idPointer += size;
    }
    if (idPointer < initialIds.length) {
      initialChunksDocs.push(initialIds.slice(idPointer).map((id) => doc(id, 0)));
    }

    const descriptors: SnapshotChunkDescriptor[] = [];
    const loadedChunks = new Map<string, readonly DocumentData[]>();
    for (const chunkDocs of initialChunksDocs) {
      const descriptor = await createDescriptor(chunkDocs);
      descriptors.push(descriptor);
      loadedChunks.set(descriptor.key, chunkDocs);
    }
    const initialRows: ReferenceRow[] = initialChunksDocs.flat().map((d) => ({
      _id: d["_id"] as string,
      body: d,
    }));

    const entries: LogEntry[] = logOps.map(({ op, idIndex, value, violation }, index) => {
      const slot = idIndex % sortedIds.length;
      const id = sortedIds[slot]!;
      if (op === "D") {
        return makeLogEntry(index + 1, op, id);
      }
      if (violation === undefined) {
        return makeLogEntry(index + 1, op, id, doc(id, value));
      }
      const other =
        sortedIds[
          (slot + 1 + (violation.otherOffset % (sortedIds.length - 1))) % sortedIds.length
        ]!;
      const after: Record<IdentityViolationKind, () => unknown> = {
        "other-id": () => doc(other, value),
        missing: () => ({ value }),
        number: () => ({ _id: value, value }),
        accessor: () =>
          Object.defineProperty({ value }, "_id", { get: () => id, enumerable: true }),
        inherited: () => Object.assign(Object.create({ _id: id }), { value }),
        suffix: () => doc(`${id}x`, value),
      };
      return makeLogEntry(index + 1, op, id, after[violation.kind]() as DocumentData);
    });

    const fold = (prefix: readonly LogEntry[]) =>
      foldChunkedSnapshotReference(initialRows, prefix.map(toReferenceMutation));

    let plan: ChunkedFoldPlan | null;
    try {
      plan = await planChunkedFold({
        collection,
        collectionPrefix,
        entries,
        descriptors,
        loadedChunks,
        budget: { ...defaultBudget, max_split_increments: Number.MAX_SAFE_INTEGER },
        incarnation,
        policy: CHUNK_BOUNDARY_POLICIES["c128-r512"],
      });
    } catch (error) {
      // Both reject: the planner fails closed, and so does the reference.
      expect(error).toMatchObject({ code: "InvalidResponse" });
      expect(() => fold(entries)).toThrow(expect.objectContaining({ code: "InvalidResponse" }));
      return;
    }

    // Both accept: the reference admits the planner's prefix and publishes
    // the same logical rows.
    expect(plan).not.toBeNull();
    const prefix = entries.filter((entry) => entry.seq <= plan!.log_seq_end);
    await expect(planRows(plan!, loadedChunks)).resolves.toEqual(fold(prefix));
  },
);
