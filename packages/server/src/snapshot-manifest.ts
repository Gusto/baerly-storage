import { decodeJsonBytes, encodeJsonBytes, snapshotHash } from "@baerly/protocol";
import { assertKeyWithinLimit } from "./key-limit.ts";
import { assertPathSegment } from "./path-segment.ts";
import {
  assertCodecDocId,
  assertExactFields,
  type CodecCode,
  DIGEST_PATTERN,
  equalBytes,
  INCARNATION_PATTERN,
  makeCodecFail,
  MAX_CHUNK_BYTES,
  MAX_CHUNK_ROWS,
  normalizeCodecFailure,
  parseArtifactKey,
} from "./snapshot-codec.ts";
import { compareDocIds } from "./snapshot-doc-id.ts";

const SNAPSHOT_MANIFEST_SCHEMA_VERSION = 2;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_MANIFEST_CHUNKS = 32;

export interface SnapshotChunkDescriptor {
  readonly first_id: string;
  readonly last_id: string;
  readonly key: string;
  readonly byte_length: number;
  readonly row_count: number;
}

export interface SnapshotManifest {
  readonly schema_version: typeof SNAPSHOT_MANIFEST_SCHEMA_VERSION;
  readonly collection: string;
  readonly log_seq_start: number;
  readonly incarnation: string;
  readonly collation: "utf8-scalar-v1";
  readonly chunks: readonly SnapshotChunkDescriptor[];
}

const failManifest = makeCodecFail("snapshot manifest");
function invalid(code: CodecCode, message: string, cause?: unknown): never {
  return failManifest(code, message, cause);
}

function positiveSafeInteger(
  value: unknown,
  maximum: number,
  where: string,
  code: "InvalidConfig" | "InvalidResponse",
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    invalid(code, `${where} must be a positive safe integer at most ${maximum}`);
  }
}

function canonicalizeManifest(
  value: unknown,
  code: "InvalidConfig" | "InvalidResponse",
  expectedPrefix?: string,
): SnapshotManifest {
  assertExactFields(
    value,
    ["schema_version", "collection", "log_seq_start", "incarnation", "collation", "chunks"],
    "body",
    code,
    invalid,
  );
  if (value["schema_version"] !== SNAPSHOT_MANIFEST_SCHEMA_VERSION) {
    invalid(code, "unsupported schema_version");
  }
  if (typeof value["collection"] !== "string") {
    invalid(code, "collection must be a string");
  }
  if (code === "InvalidConfig") {
    try {
      assertPathSegment(value["collection"], "collection");
    } catch (error) {
      invalid(code, "collection is invalid", error);
    }
  }
  if (!Number.isSafeInteger(value["log_seq_start"]) || (value["log_seq_start"] as number) < 0) {
    invalid(code, "log_seq_start must be a non-negative safe integer");
  }
  if (typeof value["incarnation"] !== "string" || !INCARNATION_PATTERN.test(value["incarnation"])) {
    invalid(code, "incarnation must be 32 lowercase hex characters");
  }
  if (value["collation"] !== "utf8-scalar-v1") {
    invalid(code, "unsupported collation");
  }
  if (!Array.isArray(value["chunks"]) || value["chunks"].length > MAX_MANIFEST_CHUNKS) {
    invalid(code, `chunks must be an array of at most ${MAX_MANIFEST_CHUNKS} descriptors`);
  }

  const seenKeys = new Set<string>();
  let chunkPrefix: string | undefined;
  const chunks = value["chunks"].map((candidate, index): SnapshotChunkDescriptor => {
    const where = `chunks[${index}]`;
    assertExactFields(
      candidate,
      ["first_id", "last_id", "key", "byte_length", "row_count"],
      where,
      code,
      invalid,
    );
    assertCodecDocId(candidate["first_id"], `${where}.first_id`, code, invalid);
    assertCodecDocId(candidate["last_id"], `${where}.last_id`, code, invalid);
    if (compareDocIds(candidate["first_id"], candidate["last_id"]) > 0) {
      invalid(code, `${where} range is reversed`);
    }
    const descriptorKey = candidate["key"];
    if (typeof descriptorKey !== "string") {
      invalid(code, `${where}.key must be a string`);
    }
    const parsedKey = parseArtifactKey(descriptorKey, "chunk", code, invalid);
    // Internal consistency: every descriptor key must share one collection
    // prefix, so an encodable manifest is always decodable under a manifest
    // key built from that same prefix. `expectedPrefix` (decode only) then
    // pins the shared prefix to the manifest key's own prefix.
    if (chunkPrefix === undefined) {
      chunkPrefix = parsedKey.prefix;
    } else if (parsedKey.prefix !== chunkPrefix) {
      invalid(code, "chunk descriptor keys must share one collection prefix");
    }
    if (expectedPrefix !== undefined && parsedKey.prefix !== expectedPrefix) {
      invalid(code, `${where}.key belongs to another collection prefix`);
    }
    positiveSafeInteger(candidate["byte_length"], MAX_CHUNK_BYTES, `${where}.byte_length`, code);
    positiveSafeInteger(candidate["row_count"], MAX_CHUNK_ROWS, `${where}.row_count`, code);
    if (seenKeys.has(descriptorKey)) {
      invalid(code, "descriptor keys must be unique");
    }
    seenKeys.add(descriptorKey);
    return {
      first_id: candidate["first_id"],
      last_id: candidate["last_id"],
      key: descriptorKey,
      byte_length: candidate["byte_length"],
      row_count: candidate["row_count"],
    };
  });

  for (let index = 1; index < chunks.length; index++) {
    const previous = chunks[index - 1]!;
    const current = chunks[index]!;
    if (
      compareDocIds(previous.first_id, current.first_id) >= 0 ||
      compareDocIds(previous.last_id, current.first_id) >= 0
    ) {
      invalid(code, "descriptor ranges must be strictly increasing and non-overlapping");
    }
  }

  return {
    schema_version: SNAPSHOT_MANIFEST_SCHEMA_VERSION,
    collection: value["collection"],
    log_seq_start: value["log_seq_start"] as number,
    incarnation: value["incarnation"],
    collation: "utf8-scalar-v1",
    chunks,
  };
}

export const encodeSnapshotManifest = (manifest: SnapshotManifest): Uint8Array => {
  return normalizeCodecFailure(
    invalid,
    "InvalidConfig",
    "body exceeds supported JSON validation depth",
    () => {
      const canonical = canonicalizeManifest(manifest, "InvalidConfig");
      const bytes = encodeJsonBytes(canonical);
      if (bytes.byteLength > MAX_MANIFEST_BYTES) {
        invalid("InvalidConfig", `canonical body exceeds ${MAX_MANIFEST_BYTES} bytes`);
      }
      return bytes;
    },
  );
};

export const snapshotManifestKey = (
  collectionPrefix: string,
  incarnation: string,
  digest: string,
): string => {
  if (collectionPrefix.length === 0 || collectionPrefix.endsWith("/")) {
    invalid("InvalidConfig", "collection prefix must be non-empty without a trailing slash");
  }
  if (!INCARNATION_PATTERN.test(incarnation)) {
    invalid("InvalidConfig", "incarnation must be 32 lowercase hex characters");
  }
  if (!DIGEST_PATTERN.test(digest)) {
    invalid("InvalidConfig", "digest must be 64 lowercase hex characters");
  }
  const key = `${collectionPrefix}/_v2/snapshot/manifests/${incarnation}/sha256/${digest}.json`;
  assertKeyWithinLimit(key);
  return key;
};

/**
 * Lower-bound search over strictly ordered, gap-tolerant descriptors: the
 * index of the first descriptor whose `last_id` sorts at or after `id` — the
 * candidate owner for `id` in descriptor routing. Returns
 * `descriptors.length` when `id` sorts after every descriptor.
 */
export function firstDescriptorEndingAtOrAfter(
  descriptors: readonly SnapshotChunkDescriptor[],
  id: string,
): number {
  let low = 0;
  let high = descriptors.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (compareDocIds(descriptors[middle]!.last_id, id) < 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

export const decodeSnapshotManifest = async (
  bytes: Uint8Array,
  key: string,
  expectedCollection: string,
  expectedLogSeqStart: number,
): Promise<SnapshotManifest> => {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MANIFEST_BYTES) {
    invalid("InvalidResponse", "body length is outside the manifest ceiling");
  }
  const bodyBytes = bytes.slice();
  const parsedKey = parseArtifactKey(key, "manifest", "InvalidResponse", invalid);
  const digest = await snapshotHash(bodyBytes);
  if (digest !== parsedKey.digest) {
    invalid("InvalidResponse", "body digest does not match its key");
  }

  let parsed: unknown;
  try {
    parsed = decodeJsonBytes(bodyBytes);
  } catch (error) {
    invalid("InvalidResponse", "body is not valid JSON", error);
  }
  const canonical = normalizeCodecFailure(
    invalid,
    "InvalidResponse",
    "body exceeds supported JSON validation depth",
    () => {
      const value = canonicalizeManifest(parsed, "InvalidResponse", parsedKey.prefix);
      const canonicalBytes = encodeJsonBytes(value);
      if (!equalBytes(bodyBytes, canonicalBytes)) {
        invalid("InvalidResponse", "body is not canonical JSON");
      }
      return value;
    },
  );
  if (canonical.collection !== expectedCollection) {
    invalid("InvalidResponse", "body collection does not match the expected collection");
  }
  if (canonical.log_seq_start !== expectedLogSeqStart) {
    invalid("InvalidResponse", "body log_seq_start does not match the expected floor");
  }
  if (canonical.incarnation !== parsedKey.incarnation) {
    invalid("InvalidResponse", "body incarnation does not match its key");
  }
  return canonical;
};
