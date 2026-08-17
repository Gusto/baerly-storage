import { type DocumentData, snapshotHash } from "@baerly/protocol";
import { encodeSnapshotChunk, snapshotChunkKey } from "../../packages/server/src/snapshot-chunk.ts";
import { type SnapshotChunkDescriptor } from "../../packages/server/src/snapshot-manifest.ts";

export interface SnapshotChunkFixtureConfig {
  readonly collection: string;
  readonly collectionPrefix: string;
  readonly incarnation: string;
}

export interface SnapshotChunkFixtures {
  /** Encode `docs` as a schema-version-2 chunk, deriving the range from the doc IDs. */
  readonly createChunkBytes: (
    docs: readonly DocumentData[],
    chunkIncarnation?: string,
  ) => Uint8Array;
  /** Encode `docs` and mint the descriptor that authenticates the resulting chunk. */
  readonly createDescriptor: (
    docs: readonly DocumentData[],
    chunkIncarnation?: string,
  ) => Promise<SnapshotChunkDescriptor>;
}

/**
 * Chunk and descriptor factories for snapshot tests, bound to one collection.
 *
 * `collection`, `collectionPrefix`, and `incarnation` are taken as arguments
 * rather than read from module constants so each test file can supply its own.
 * `chunkIncarnation` overrides the bound incarnation per call, which tests use
 * to build descriptors from a prior incarnation.
 */
export const makeSnapshotChunkFixtures = (
  config: SnapshotChunkFixtureConfig,
): SnapshotChunkFixtures => {
  const { collection, collectionPrefix, incarnation } = config;

  const createChunkBytes = (
    docs: readonly DocumentData[],
    chunkIncarnation = incarnation,
  ): Uint8Array =>
    encodeSnapshotChunk({
      schema_version: 2,
      collection,
      incarnation: chunkIncarnation,
      first_id: docs[0]!["_id"] as string,
      last_id: docs.at(-1)!["_id"] as string,
      docs,
    });

  const createDescriptor = async (
    docs: readonly DocumentData[],
    chunkIncarnation = incarnation,
  ): Promise<SnapshotChunkDescriptor> => {
    const bytes = createChunkBytes(docs, chunkIncarnation);
    const digest = await snapshotHash(bytes);
    return {
      first_id: docs[0]!["_id"] as string,
      last_id: docs.at(-1)!["_id"] as string,
      key: snapshotChunkKey(collectionPrefix, chunkIncarnation, digest),
      byte_length: bytes.byteLength,
      row_count: docs.length,
    };
  };

  return { createChunkBytes, createDescriptor };
};
