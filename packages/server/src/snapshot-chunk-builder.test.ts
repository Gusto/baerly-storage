import { fc, test as fcTest } from "@fast-check/vitest";
import { type DocumentData, type DocumentValue } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import {
  foldChunkedSnapshotReference,
  type ReferenceMutation,
  type ReferenceRow,
} from "./chunked-snapshot-reference.ts";
import { decodeSnapshotChunk } from "./snapshot-chunk.ts";
import { compareDocIds } from "./snapshot-doc-id.ts";
import {
  buildSnapshotChunks,
  CHUNK_BOUNDARY_POLICIES,
  deriveOwnerAndNeighbor,
  routeMutationToDescriptor,
  type SnapshotChunkBoundaryPolicy,
} from "./snapshot-chunk-builder.ts";
import type { SnapshotChunkDescriptor } from "./snapshot-manifest.ts";
import { makeSnapshotChunkFixtures } from "../../../tests/fixtures/snapshot-chunks.ts";

const collection = "tickets";
const collectionPrefix = "app/demo/tenant/acme/manifests/tickets";
const incarnation = "00112233445566778899aabbccddeeff";

const doc = (id: string, value: DocumentValue = 1): DocumentData => ({ _id: id, value });

const mutationMap = (
  mutations: readonly ReferenceMutation[],
): ReadonlyMap<string, ReferenceMutation> =>
  new Map(mutations.map((mutation) => [mutation.doc_id, mutation]));

const { createDescriptor } = makeSnapshotChunkFixtures({
  collection,
  collectionPrefix,
  incarnation,
});

describe("snapshot chunk builder", () => {
  test("creates a new chunk for an empty collection and accounts 0 split increments", async () => {
    const policy = CHUNK_BOUNDARY_POLICIES["c128-r512"];
    const mutations: ReferenceMutation[] = [
      { op: "I", doc_id: "a", after: doc("a", 10) },
      { op: "I", doc_id: "b", after: doc("b", 20) },
    ];

    const result = await buildSnapshotChunks({
      collection,
      collectionPrefix,
      descriptors: [],
      loadedChunks: new Map(),
      mutations: mutationMap(mutations),
      incarnation,
      policy,
      lockedDirectOwnerIndex: null,
      selectedNeighborIndex: null,
    });

    expect(result.chunks.length).toBe(1);
    expect(result.changed_chunks.length).toBe(1);
    expect(result.split_increments).toBe(0);
    expect(result.used_neighbor_chunk_index).toBeNull();
    expect(result.chunks[0]!.first_id).toBe("a");
    expect(result.chunks[0]!.last_id).toBe("b");
    expect(result.chunks[0]!.row_count).toBe(2);
  });

  test("rewrites a directly touched chunk and reuses untouched descriptors", async () => {
    const policy = CHUNK_BOUNDARY_POLICIES["c128-r512"];
    const d0Docs = [doc("a", 1), doc("b", 2)];
    const d1Docs = [doc("m", 10), doc("n", 20)];
    const d0Desc = await createDescriptor(d0Docs);
    const d1Desc = await createDescriptor(d1Docs);

    const loadedChunks = new Map<string, readonly DocumentData[]>([
      [d0Desc.key, d0Docs],
      [d1Desc.key, d1Docs],
    ]);

    const mutations: ReferenceMutation[] = [{ op: "U", doc_id: "b", after: doc("b", 99) }];

    const result = await buildSnapshotChunks({
      collection,
      collectionPrefix,
      descriptors: [d0Desc, d1Desc],
      loadedChunks,
      mutations: mutationMap(mutations),
      incarnation,
      policy,
      lockedDirectOwnerIndex: 0,
      selectedNeighborIndex: null, // No neighbor selected
    });

    expect(result.chunks.length).toBe(2);
    expect(result.changed_chunks.length).toBe(1);
    expect(result.split_increments).toBe(0);
    expect(result.used_neighbor_chunk_index).toBeNull();
    expect(result.chunks[0]!.first_id).toBe("a");
    expect(result.chunks[0]!.last_id).toBe("b");
    expect(result.chunks[1]).toBe(d1Desc); // Reused verbatim
  });

  test("treats gap delete as a no-op and preserves unchanged descriptors", async () => {
    const policy = CHUNK_BOUNDARY_POLICIES["c128-r512"];
    const d0Docs = [doc("b", 1), doc("c", 2)];
    const d0Desc = await createDescriptor(d0Docs);

    const loadedChunks = new Map<string, readonly DocumentData[]>([[d0Desc.key, d0Docs]]);

    const mutations: ReferenceMutation[] = [
      { op: "D", doc_id: "a" }, // Before d0 -> gap delete
      { op: "D", doc_id: "z" }, // After d0 -> gap delete
    ];

    const result = await buildSnapshotChunks({
      collection,
      collectionPrefix,
      descriptors: [d0Desc],
      loadedChunks,
      mutations: mutationMap(mutations),
      incarnation,
      policy,
      lockedDirectOwnerIndex: null,
      selectedNeighborIndex: null,
    });

    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0]).toBe(d0Desc); // Unchanged reuse
    expect(result.changed_chunks.length).toBe(0);
    expect(result.split_increments).toBe(0);
  });

  test("splits a changed group greedily and counts split increments", async () => {
    const customPolicy: SnapshotChunkBoundaryPolicy = {
      target_chunk_bytes: 1024 * 1024,
      target_rows: 2, // Force split at 2 rows
    };
    const d0Docs = [doc("a", 1), doc("b", 2)];
    const d0Desc = await createDescriptor(d0Docs);

    const loadedChunks = new Map<string, readonly DocumentData[]>([[d0Desc.key, d0Docs]]);

    const mutations: ReferenceMutation[] = [
      { op: "I", doc_id: "c", after: doc("c", 3) },
      { op: "I", doc_id: "d", after: doc("d", 4) },
      { op: "I", doc_id: "e", after: doc("e", 5) },
    ];

    const result = await buildSnapshotChunks({
      collection,
      collectionPrefix,
      descriptors: [d0Desc],
      loadedChunks,
      mutations: mutationMap(mutations),
      incarnation,
      policy: customPolicy,
      lockedDirectOwnerIndex: 0,
      selectedNeighborIndex: null,
    });

    // 5 docs with target_rows: 2 -> [a, b], [c, d], [e] = 3 chunks
    expect(result.chunks.length).toBe(3);
    expect(result.changed_chunks.length).toBe(3);
    expect(result.split_increments).toBe(2); // max(0, 3 - 1) = 2
    expect(result.chunks[0]!.first_id).toBe("a");
    expect(result.chunks[0]!.last_id).toBe("b");
    expect(result.chunks[1]!.first_id).toBe("c");
    expect(result.chunks[1]!.last_id).toBe("d");
    expect(result.chunks[2]!.first_id).toBe("e");
    expect(result.chunks[2]!.last_id).toBe("e");
  });

  test("emits oversized document as singleton under 1 MiB hard ceiling", async () => {
    const customPolicy: SnapshotChunkBoundaryPolicy = {
      target_chunk_bytes: 100, // Small target
      target_rows: 100,
    };
    const largeDoc = doc("a", "x".repeat(200)); // ~250 bytes > 100 target

    const result = await buildSnapshotChunks({
      collection,
      collectionPrefix,
      descriptors: [],
      loadedChunks: new Map(),
      mutations: mutationMap([{ op: "I", doc_id: "a", after: largeDoc }]),
      incarnation,
      policy: customPolicy,
      lockedDirectOwnerIndex: null,
      selectedNeighborIndex: null,
    });

    expect(result.chunks.length).toBe(1);
    expect(result.changed_chunks.length).toBe(1);
  });

  test("backs off the row boundary until the byte target admits the chunk", async () => {
    // target_rows is high enough that the row axis provably cannot split, so
    // every emitted boundary is the work of the byte-driven `end--` backoff.
    const customPolicy: SnapshotChunkBoundaryPolicy = {
      target_chunk_bytes: 300,
      target_rows: 100,
    };
    // Individually well under 300 bytes; collectively over it once the chunk
    // envelope (schema_version + collection + incarnation + first_id + last_id)
    // is counted.
    const mutations: ReferenceMutation[] = ["a", "b", "c", "d", "e"].map((id) => ({
      op: "I",
      doc_id: id,
      after: doc(id, "x".repeat(60)),
    }));

    const result = await buildSnapshotChunks({
      collection,
      collectionPrefix,
      descriptors: [],
      loadedChunks: new Map(),
      mutations: mutationMap(mutations),
      incarnation,
      policy: customPolicy,
      lockedDirectOwnerIndex: null,
      selectedNeighborIndex: null,
    });

    // Envelope size varies with each chunk's first_id/last_id, so assert on
    // properties rather than exact counts.
    expect(result.chunks.length).toBeGreaterThanOrEqual(2);
    // The crux: the `end === start + 1` singleton escape can only ever emit
    // 1-row chunks, so a multi-row chunk inside a multi-chunk result can only
    // come from the backoff finding a boundary.
    expect(result.chunks.some((chunk) => chunk.row_count >= 2)).toBe(true);
    for (const chunk of result.chunks) {
      expect(chunk.row_count).toBeLessThan(customPolicy.target_rows);
      if (chunk.row_count >= 2) {
        expect(chunk.byte_length).toBeLessThanOrEqual(customPolicy.target_chunk_bytes);
      }
    }
    expect(result.split_increments).toBe(result.chunks.length - 1);
  });

  test("rejects document exceeding 1 MiB hard maximum with InvalidResponse", async () => {
    const hugeDoc = doc("a", "x".repeat(1024 * 1024 + 50));
    await expect(
      buildSnapshotChunks({
        collection,
        collectionPrefix,
        descriptors: [],
        loadedChunks: new Map(),
        mutations: mutationMap([{ op: "I", doc_id: "a", after: hugeDoc }]),
        incarnation,
        policy: CHUNK_BOUNDARY_POLICIES["c128-r512"],
        lockedDirectOwnerIndex: null,
        selectedNeighborIndex: null,
      }),
    ).rejects.toMatchObject({ code: "InvalidResponse" });
  });

  test("merges underfull facing output with immediate right neighbor", async () => {
    const policy: SnapshotChunkBoundaryPolicy = {
      target_chunk_bytes: 10_000,
      target_rows: 10,
    };
    // D0 has 1 doc (1 < 10/2 and bytes < 5000 -> underfull)
    // D1 has 1 doc
    // Combined = 2 docs <= 10 -> fits!
    const d0Docs = [doc("a", 1), doc("b", 2)];
    const d1Docs = [doc("m", 10)];
    const d0Desc = await createDescriptor(d0Docs);
    const d1Desc = await createDescriptor(d1Docs);

    const loadedChunks = new Map<string, readonly DocumentData[]>([
      [d0Desc.key, d0Docs],
      [d1Desc.key, d1Docs],
    ]);

    // Delete "b", leaving D0 with just "a" (underfull)
    const mutations: ReferenceMutation[] = [{ op: "D", doc_id: "b" }];

    const result = await buildSnapshotChunks({
      collection,
      collectionPrefix,
      descriptors: [d0Desc, d1Desc],
      loadedChunks,
      mutations: mutationMap(mutations),
      incarnation,
      policy,
      lockedDirectOwnerIndex: 0,
      selectedNeighborIndex: 1,
    });

    expect(result.chunks.length).toBe(1); // D0 and D1 merged into 1 chunk
    expect(result.used_neighbor_chunk_index).toBe(1);
    expect(result.chunks[0]!.first_id).toBe("a");
    expect(result.chunks[0]!.last_id).toBe("m");
    expect(result.chunks[0]!.row_count).toBe(2);
  });

  test("merges underfull facing output with fallback left neighbor when owner has no right neighbor", async () => {
    const policy: SnapshotChunkBoundaryPolicy = {
      target_chunk_bytes: 10_000,
      target_rows: 10,
    };
    const d0Docs = [doc("a", 1)];
    const d1Docs = [doc("m", 10), doc("n", 20)];
    const d0Desc = await createDescriptor(d0Docs);
    const d1Desc = await createDescriptor(d1Docs);

    const loadedChunks = new Map<string, readonly DocumentData[]>([
      [d0Desc.key, d0Docs],
      [d1Desc.key, d1Docs],
    ]);

    // Owner is D1 (index 1, rightmost). Delete "n", leaving "m" (underfull).
    // Neighbor is D0 (index 0, immediate left fallback).
    const mutations: ReferenceMutation[] = [{ op: "D", doc_id: "n" }];

    const result = await buildSnapshotChunks({
      collection,
      collectionPrefix,
      descriptors: [d0Desc, d1Desc],
      loadedChunks,
      mutations: mutationMap(mutations),
      incarnation,
      policy,
      lockedDirectOwnerIndex: 1,
      selectedNeighborIndex: 0,
    });

    expect(result.chunks.length).toBe(1);
    expect(result.used_neighbor_chunk_index).toBe(0);
    expect(result.chunks[0]!.first_id).toBe("a");
    expect(result.chunks[0]!.last_id).toBe("m");
    expect(result.chunks[0]!.row_count).toBe(2);
  });

  test("regression: D0 locks D1, D0 facing output is not underfull, D3 is underfull with D2 intervening -> D1 and D3 must NOT merge", async () => {
    const policy: SnapshotChunkBoundaryPolicy = {
      target_chunk_bytes: 10_000,
      target_rows: 4, // underfull threshold is < 2 rows
    };
    const d0Docs = [doc("a", 1), doc("b", 2), doc("c", 3)]; // 3 rows -> NOT underfull (< 2)
    const d1Docs = [doc("d", 4)];
    const d2Docs = [doc("g", 7), doc("h", 8)];
    const d3Docs = [doc("x", 24), doc("y", 25)]; // we'll delete "y", leaving 1 row -> underfull

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

    const mutations: ReferenceMutation[] = [
      { op: "U", doc_id: "a", after: doc("a", 100) }, // touches D0 (stays 3 rows)
      { op: "D", doc_id: "y" }, // touches D3 (becomes 1 row -> underfull)
    ];

    const result = await buildSnapshotChunks({
      collection,
      collectionPrefix,
      descriptors: [d0Desc, d1Desc, d2Desc, d3Desc],
      loadedChunks,
      mutations: mutationMap(mutations),
      incarnation,
      policy,
      lockedDirectOwnerIndex: 0,
      selectedNeighborIndex: 1,
    });

    // D1 must NOT be used!
    expect(result.used_neighbor_chunk_index).toBeNull();
    expect(result.chunks.length).toBe(4);
    expect(result.chunks[1]).toBe(d1Desc); // D1 untouched reuse
    expect(result.chunks[2]).toBe(d2Desc); // D2 untouched reuse
  });

  test("regression: owner group deleted to no output -> neighbor stays unused", async () => {
    const policy: SnapshotChunkBoundaryPolicy = {
      target_chunk_bytes: 10_000,
      target_rows: 10,
    };
    const d0Docs = [doc("a", 1)];
    const d1Docs = [doc("m", 10)];
    const d0Desc = await createDescriptor(d0Docs);
    const d1Desc = await createDescriptor(d1Docs);

    const loadedChunks = new Map<string, readonly DocumentData[]>([
      [d0Desc.key, d0Docs],
      [d1Desc.key, d1Docs],
    ]);

    const mutations: ReferenceMutation[] = [{ op: "D", doc_id: "a" }]; // D0 deleted to 0 docs

    const result = await buildSnapshotChunks({
      collection,
      collectionPrefix,
      descriptors: [d0Desc, d1Desc],
      loadedChunks,
      mutations: mutationMap(mutations),
      incarnation,
      policy,
      lockedDirectOwnerIndex: 0,
      selectedNeighborIndex: 1,
    });

    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0]).toBe(d1Desc); // D1 unchanged
    expect(result.used_neighbor_chunk_index).toBeNull();
  });

  test("regression: owner splits -> only rightmost output may face right neighbor", async () => {
    const policy: SnapshotChunkBoundaryPolicy = {
      target_chunk_bytes: 10_000,
      target_rows: 4, // underfull threshold < 2 rows (1 row is underfull, 4 rows is not)
    };
    // D0 initially has "a", "b", "c", "d". We insert "e", making D0 docs = [a, b, c, d, e] (5 docs).
    // With target_rows: 4, D0 splits into C1: [a, b, c, d] (4 rows, not underfull) and C2: [e] (1 row, underfull).
    // Facing right neighbor D1: [f] (1 row).
    // C2 (1 row) + D1 (1 row) = 2 rows <= target_rows 4 -> fits!
    const d0Docs = [doc("a", 1), doc("b", 2), doc("c", 3), doc("d", 4)];
    const d1Docs = [doc("f", 6)];
    const d0Desc = await createDescriptor(d0Docs);
    const d1Desc = await createDescriptor(d1Docs);

    const loadedChunks = new Map<string, readonly DocumentData[]>([
      [d0Desc.key, d0Docs],
      [d1Desc.key, d1Docs],
    ]);

    const mutations: ReferenceMutation[] = [{ op: "I", doc_id: "e", after: doc("e", 5) }];

    const result = await buildSnapshotChunks({
      collection,
      collectionPrefix,
      descriptors: [d0Desc, d1Desc],
      loadedChunks,
      mutations: mutationMap(mutations),
      incarnation,
      policy,
      lockedDirectOwnerIndex: 0,
      selectedNeighborIndex: 1,
    });

    // C1: [a, b, c, d] + C2 merged with D1: [e, f] = 2 chunks total
    expect(result.chunks.length).toBe(2);
    expect(result.used_neighbor_chunk_index).toBe(1);
    expect(result.chunks[0]!.first_id).toBe("a");
    expect(result.chunks[0]!.last_id).toBe("d");
    expect(result.chunks[1]!.first_id).toBe("e");
    expect(result.chunks[1]!.last_id).toBe("f");
    expect(result.split_increments).toBe(1); // split increments computed before merge
  });

  test("neighbor directly touched -> neighbor is unused", async () => {
    const policy: SnapshotChunkBoundaryPolicy = {
      target_chunk_bytes: 10_000,
      target_rows: 10,
    };
    const d0Docs = [doc("a", 1), doc("b", 2)];
    const d1Docs = [doc("m", 10)];
    const d0Desc = await createDescriptor(d0Docs);
    const d1Desc = await createDescriptor(d1Docs);

    const loadedChunks = new Map<string, readonly DocumentData[]>([
      [d0Desc.key, d0Docs],
      [d1Desc.key, d1Docs],
    ]);

    // Touch both D0 and D1
    const mutations: ReferenceMutation[] = [
      { op: "D", doc_id: "b" }, // D0 becomes [a] (underfull)
      { op: "U", doc_id: "m", after: doc("m", 99) }, // D1 touched
    ];

    const result = await buildSnapshotChunks({
      collection,
      collectionPrefix,
      descriptors: [d0Desc, d1Desc],
      loadedChunks,
      mutations: mutationMap(mutations),
      incarnation,
      policy,
      lockedDirectOwnerIndex: 0,
      selectedNeighborIndex: 1,
    });

    expect(result.used_neighbor_chunk_index).toBeNull();
    expect(result.chunks.length).toBe(2);
  });
});

const idArb = fc.oneof(
  fc.stringMatching(/^[a-z][a-z0-9]{0,4}$/),
  fc.constantFrom("é", "e\u0301", "\u{10000}", "\u{1f4a9}"),
);

fcTest.prop({
  allIds: fc.uniqueArray(idArb, { minLength: 2, maxLength: 20 }),
  initialFraction: fc.double({ min: 0, max: 0.8, noNaN: true }),
  chunkPartitionSizes: fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 6 }),
  mutationOps: fc.array(
    fc.record({
      op: fc.constantFrom<"I" | "U" | "D">("I", "U", "D"),
      idIndex: fc.nat(),
      value: fc.integer(),
    }),
    { minLength: 1, maxLength: 25 },
  ),
  targetRows: fc.integer({ min: 2, max: 8 }),
})(
  "logical equivalence: emitted snapshot chunks match independent reference fold",
  async ({ allIds, initialFraction, chunkPartitionSizes, mutationOps, targetRows }) => {
    // Sort all IDs in utf8-scalar-v1 order
    const sortedIds = [...allIds].toSorted(compareDocIds);
    const initialCount = Math.floor(sortedIds.length * initialFraction);
    const initialIds = sortedIds.slice(0, initialCount);

    // Partition initial IDs into chunks
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
      const descriptor = await createDescriptor(chunkDocs, "11111111111111111111111111111111");
      descriptors.push(descriptor);
      loadedChunks.set(descriptor.key, chunkDocs);
    }

    const mutations: ReferenceMutation[] = mutationOps.map(({ op, idIndex, value }) => {
      const id = sortedIds[idIndex % sortedIds.length]!;
      if (op === "D") {
        return { op: "D", doc_id: id };
      }
      return { op, doc_id: id, after: doc(id, value) };
    });

    const policy: SnapshotChunkBoundaryPolicy = {
      target_chunk_bytes: 1024 * 1024,
      target_rows: targetRows,
    };

    // Calculate directly touched descriptor indexes to derive owner & neighbor
    const directIndexes = new Set<number>();
    for (const mutation of mutations) {
      const target = routeMutationToDescriptor(mutation.doc_id, mutation.op, descriptors);
      if (target !== null) {
        directIndexes.add(target);
      }
    }

    const { leftmostOwnerIndex, selectedNeighborIndex } = deriveOwnerAndNeighbor(
      directIndexes,
      descriptors.length,
    );

    const result = await buildSnapshotChunks({
      collection,
      collectionPrefix,
      descriptors,
      loadedChunks,
      mutations: mutationMap(mutations),
      incarnation,
      policy,
      lockedDirectOwnerIndex: leftmostOwnerIndex,
      selectedNeighborIndex,
    });

    // Invariant: Descriptors are strictly increasing and non-overlapping
    for (let i = 0; i < result.chunks.length; i++) {
      const desc = result.chunks[i]!;
      expect(compareDocIds(desc.first_id, desc.last_id)).toBeLessThanOrEqual(0);
      if (i > 0) {
        const prev = result.chunks[i - 1]!;
        expect(compareDocIds(prev.last_id, desc.first_id)).toBeLessThan(0);
      }
    }

    // Materialize all emitted documents from result.chunks
    const changedChunksByKey = new Map(
      result.changed_chunks.map((item) => [item.descriptor.key, item]),
    );

    const emittedRows: ReferenceRow[] = [];
    for (const descriptor of result.chunks) {
      const changed = changedChunksByKey.get(descriptor.key);
      let docs: readonly DocumentData[];
      if (changed !== undefined) {
        const decoded = await decodeSnapshotChunk(
          changed.bytes,
          descriptor.key,
          collection,
          descriptor,
        );
        docs = decoded.docs;
      } else {
        docs = loadedChunks.get(descriptor.key)!;
      }
      for (const d of docs) {
        emittedRows.push({ _id: d["_id"] as string, body: d });
      }
    }

    // Reference model calculation
    const initialReferenceRows: ReferenceRow[] = initialChunksDocs.flatMap((chunkDocs) =>
      chunkDocs.map((d) => ({ _id: d["_id"] as string, body: d })),
    );
    const expectedRows = foldChunkedSnapshotReference(initialReferenceRows, mutations);

    expect(emittedRows).toEqual(expectedRows);
  },
);
