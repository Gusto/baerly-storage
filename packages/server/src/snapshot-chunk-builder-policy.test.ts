import { type DocumentData, encodeJsonBytes } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { WORKLOAD_CEILING_STUDY } from "../../../bench/measurement/workload-ceiling-contract.ts";
import { type ReferenceMutation } from "./chunked-snapshot-reference.ts";
import { buildSnapshotChunks, CHUNK_BOUNDARY_POLICIES } from "./snapshot-chunk-builder.ts";
import { MAX_CHUNK_BYTES, MAX_CHUNK_ROWS } from "./snapshot-codec.ts";
import { encodeSnapshotManifest, MAX_MANIFEST_CHUNKS } from "./snapshot-manifest.ts";

const collection = "tickets";
const collectionPrefix = "app/demo/tenant/acme/manifests/tickets";
const incarnation = "00112233445566778899aabbccddeeff";

const BYTE_DOCUMENT_BYTES = WORKLOAD_CEILING_STUDY.axis_sweeps.byte_axis.document_bytes;
const ROW_DOCUMENT_BYTES = WORKLOAD_CEILING_STUDY.axis_sweeps.row_axis.document_bytes;

interface StudyCell {
  readonly id: string;
  readonly rows: number;
  readonly documentBytes: number;
}

/**
 * Preregistered axis-sweep cells from `WORKLOAD_CEILING_STUDY`. Byte-axis
 * cells above 512 KiB are omitted: the greedy backoff from `target_rows`
 * over 2 KiB documents is too slow for the default suite, and descriptor
 * count at 1 / 2 / 4 MiB is the 512 KiB packing scaled by 2 / 4 / 8.
 */
const STUDY_CELLS: readonly StudyCell[] = [
  ...WORKLOAD_CEILING_STUDY.collection_rows.map((rows) => ({
    id: `row-${rows}`,
    rows,
    documentBytes: ROW_DOCUMENT_BYTES,
  })),
  ...WORKLOAD_CEILING_STUDY.collection_bytes
    .filter((bytes) => bytes / BYTE_DOCUMENT_BYTES <= 256)
    .map((bytes) => ({
      id: `byte-${bytes}`,
      rows: bytes / BYTE_DOCUMENT_BYTES,
      documentBytes: BYTE_DOCUMENT_BYTES,
    })),
];

const studyDocument = (index: number, rowCount: number, documentBytes: number): DocumentData => {
  const width = String(rowCount - 1).length;
  const id = `row-${String(index).padStart(width, "0")}`;
  const bare = encodeJsonBytes({ _id: "row-".padEnd(4 + width, "0"), payload: "" }).byteLength;
  const padLength = Math.max(0, documentBytes - bare);
  return { _id: id, payload: "x".repeat(padLength) };
};

const mutationMap = (
  mutations: readonly ReferenceMutation[],
): ReadonlyMap<string, ReferenceMutation> =>
  new Map(mutations.map((mutation) => [mutation.doc_id, mutation]));

describe("CHUNK_BOUNDARY_POLICIES x study cells", () => {
  test(
    "every pair builds and the manifest encodes within the hard caps",
    { timeout: 30_000 },
    async () => {
      for (const policyName of Object.keys(
        CHUNK_BOUNDARY_POLICIES,
      ) as (keyof typeof CHUNK_BOUNDARY_POLICIES)[]) {
        const policy = CHUNK_BOUNDARY_POLICIES[policyName];
        for (const cell of STUDY_CELLS) {
          const mutations: ReferenceMutation[] = Array.from({ length: cell.rows }, (_, index) => {
            const after = studyDocument(index, cell.rows, cell.documentBytes);
            const docId = after["_id"] as string;
            return { op: "I", doc_id: docId, after };
          });

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

          expect(result.chunks.length).toBeGreaterThan(0);
          expect(result.chunks.length).toBeLessThanOrEqual(MAX_MANIFEST_CHUNKS);
          expect(result.chunks.reduce((sum, chunk) => sum + chunk.row_count, 0)).toBe(cell.rows);

          for (const chunk of result.chunks) {
            expect(chunk.byte_length).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
            expect(chunk.row_count).toBeGreaterThan(0);
            expect(chunk.row_count).toBeLessThanOrEqual(MAX_CHUNK_ROWS);
            expect(chunk.row_count).toBeLessThanOrEqual(policy.target_rows);
            if (chunk.row_count >= 2) {
              expect(chunk.byte_length).toBeLessThanOrEqual(policy.target_chunk_bytes);
            }
          }

          encodeSnapshotManifest({
            schema_version: 2,
            collection,
            log_seq_start: 0,
            incarnation,
            collation: "utf8-scalar-v1",
            chunks: result.chunks,
          });
        }
      }
    },
  );
});
