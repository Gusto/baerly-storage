import {
  BaerlyError,
  decodeJsonBytes,
  encodeJsonBytes,
  MAX_KEY_BYTES,
  snapshotHash,
} from "@baerly/protocol";
import { assertKeyWithinLimit } from "./key-limit.ts";
import { assertPathSegment } from "./path-segment.ts";
import { assertSnapshotDocId, compareDocIds } from "./snapshot-doc-id.ts";

const SNAPSHOT_MANIFEST_SCHEMA_VERSION = 2;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_MANIFEST_CHUNKS = 32;
const MAX_CHUNK_BYTES = 1024 * 1024;
const MAX_CHUNK_ROWS = 4096;
const INCARNATION_PATTERN = /^[0-9a-f]{32}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MANIFEST_KEY_PATTERN =
  /^(.+)\/_v2\/snapshot\/manifests\/([0-9a-f]{32})\/sha256\/([0-9a-f]{64})\.json$/;
const CHUNK_KEY_PATTERN =
  /^(.+)\/_v2\/snapshot\/chunks\/([0-9a-f]{32})\/sha256\/([0-9a-f]{64})\.json$/;
const utf8 = new TextEncoder();

export interface SnapshotChunkDescriptor {
  readonly first_id: string;
  readonly last_id: string;
  readonly key: string;
  readonly byte_length: number;
  readonly row_count: number;
}

export interface SnapshotManifest {
  readonly schema_version: number;
  readonly collection: string;
  readonly log_seq_start: number;
  readonly incarnation: string;
  readonly collation: "utf8-scalar-v1";
  readonly chunks: readonly SnapshotChunkDescriptor[];
}

interface ParsedArtifactKey {
  readonly prefix: string;
  readonly incarnation: string;
  readonly digest: string;
}

function invalid(
  code: "InvalidConfig" | "InvalidResponse",
  message: string,
  cause?: unknown,
): never {
  throw new BaerlyError(code, `snapshot manifest: ${message}`, cause);
}

function normalizeCodecFailure<T>(
  code: "InvalidConfig" | "InvalidResponse",
  operation: () => T,
): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof BaerlyError) {
      throw error;
    }
    invalid(code, "body exceeds supported JSON validation depth", error);
  }
}

function assertExactFields(
  value: unknown,
  expected: readonly string[],
  where: string,
  code: "InvalidConfig" | "InvalidResponse",
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(code, `${where} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    keys.length !== expected.length ||
    expected.some((key) => {
      const descriptor = descriptors[key];
      return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
    })
  ) {
    invalid(code, `${where} must contain exactly the required fields`);
  }
}

function assertStoredDocId(value: unknown, where: string): asserts value is string {
  if (typeof value !== "string") {
    invalid("InvalidResponse", `${where} must be a string`);
  }
  try {
    assertSnapshotDocId(value);
  } catch (error) {
    invalid("InvalidResponse", `${where} is invalid`, error);
  }
}

function assertCallerDocId(value: unknown, where: string): asserts value is string {
  if (typeof value !== "string") {
    invalid("InvalidConfig", `${where} must be a string`);
  }
  try {
    assertSnapshotDocId(value);
  } catch (error) {
    invalid("InvalidConfig", `${where} is invalid`, error);
  }
}

function parseArtifactKey(
  key: unknown,
  kind: "manifest" | "chunk",
  code: "InvalidConfig" | "InvalidResponse",
): ParsedArtifactKey {
  if (typeof key !== "string" || utf8.encode(key).byteLength > MAX_KEY_BYTES) {
    invalid(code, `${kind} key is invalid or exceeds ${MAX_KEY_BYTES} bytes`);
  }
  const match = (kind === "manifest" ? MANIFEST_KEY_PATTERN : CHUNK_KEY_PATTERN).exec(key);
  if (match === null) {
    invalid(code, `${kind} key does not match the schema-v2 grammar`);
  }
  if (match[1]!.endsWith("/")) {
    invalid(code, `${kind} key collection prefix contains an empty trailing segment`);
  }
  return { prefix: match[1]!, incarnation: match[2]!, digest: match[3]! };
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
  const chunks = value["chunks"].map((candidate, index): SnapshotChunkDescriptor => {
    const where = `chunks[${index}]`;
    assertExactFields(
      candidate,
      ["first_id", "last_id", "key", "byte_length", "row_count"],
      where,
      code,
    );
    if (code === "InvalidConfig") {
      assertCallerDocId(candidate["first_id"], `${where}.first_id`);
      assertCallerDocId(candidate["last_id"], `${where}.last_id`);
    } else {
      assertStoredDocId(candidate["first_id"], `${where}.first_id`);
      assertStoredDocId(candidate["last_id"], `${where}.last_id`);
    }
    if (compareDocIds(candidate["first_id"], candidate["last_id"]) > 0) {
      invalid(code, `${where} range is reversed`);
    }
    const descriptorKey = candidate["key"];
    if (typeof descriptorKey !== "string") {
      invalid(code, `${where}.key must be a string`);
    }
    const parsedKey = parseArtifactKey(descriptorKey, "chunk", code);
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

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

export const encodeSnapshotManifest = (manifest: SnapshotManifest): Uint8Array => {
  return normalizeCodecFailure("InvalidConfig", () => {
    const canonical = canonicalizeManifest(manifest, "InvalidConfig");
    const bytes = encodeJsonBytes(canonical);
    if (bytes.byteLength > MAX_MANIFEST_BYTES) {
      invalid("InvalidConfig", `canonical body exceeds ${MAX_MANIFEST_BYTES} bytes`);
    }
    return bytes;
  });
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
  const parsedKey = parseArtifactKey(key, "manifest", "InvalidResponse");
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
  const canonical = normalizeCodecFailure("InvalidResponse", () => {
    const value = canonicalizeManifest(parsed, "InvalidResponse", parsedKey.prefix);
    const canonicalBytes = encodeJsonBytes(value);
    if (!equalBytes(bodyBytes, canonicalBytes)) {
      invalid("InvalidResponse", "body is not canonical JSON");
    }
    return value;
  });
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
