import {
  BaerlyError,
  decodeJsonBytes,
  type DocumentData,
  type DocumentValue,
  encodeJsonBytes,
  snapshotHash,
} from "@baerly/protocol";
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
import type { SnapshotChunkDescriptor } from "./snapshot-manifest.ts";

const SNAPSHOT_CHUNK_SCHEMA_VERSION = 2;

export interface SnapshotChunk {
  readonly schema_version: typeof SNAPSHOT_CHUNK_SCHEMA_VERSION;
  readonly collection: string;
  readonly incarnation: string;
  readonly first_id: string;
  readonly last_id: string;
  readonly docs: readonly DocumentData[];
}

const failChunk = makeCodecFail("snapshot chunk");
function invalid(code: CodecCode, message: string, cause?: unknown): never {
  return failChunk(code, message, cause);
}

function assertCallerSegment(value: unknown, role: string): asserts value is string {
  if (typeof value !== "string") {
    invalid("InvalidConfig", `${role} must be a string`);
  }
  try {
    assertPathSegment(value, role);
  } catch (error) {
    invalid("InvalidConfig", `${role} is invalid`, error);
  }
}

function isArrayIndex(key: string): boolean {
  const value = Number(key);
  return Number.isInteger(value) && value >= 0 && value < 0xffff_ffff && String(value) === key;
}

function canonicalKeyOrder(left: string, right: string): number {
  const leftIndex = isArrayIndex(left);
  const rightIndex = isArrayIndex(right);
  if (leftIndex && rightIndex) {
    return Number(left) - Number(right);
  }
  if (leftIndex !== rightIndex) {
    return leftIndex ? -1 : 1;
  }
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function canonicalizeDocumentValue(
  value: unknown,
  code: "InvalidConfig" | "InvalidResponse",
  where: string,
  ancestors: Set<object>,
): DocumentValue {
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      invalid(code, `${where} must contain only finite numbers`);
    }
    return value;
  }
  if (value === null || typeof value !== "object") {
    invalid(code, `${where} contains a value outside DocumentData`);
  }
  if (ancestors.has(value)) {
    invalid(code, `${where} contains a cycle`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (
        Object.getOwnPropertySymbols(value).length !== 0 ||
        keys.length !== value.length ||
        keys.some((key, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          return (
            key !== String(index) ||
            descriptor === undefined ||
            !descriptor.enumerable ||
            !("value" in descriptor)
          );
        })
      ) {
        invalid(code, `${where} must be a dense array without extra properties`);
      }
      return value.map((entry, index) =>
        canonicalizeDocumentValue(entry, code, `${where}[${index}]`, ancestors),
      );
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalid(code, `${where} must contain only plain objects`);
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      invalid(code, `${where} must not contain symbol keys`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: DocumentData = {};
    for (const key of Object.keys(descriptors).toSorted(canonicalKeyOrder)) {
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable || !("value" in descriptor)) {
        invalid(code, `${where}.${key} must be an enumerable data property`);
      }
      Object.defineProperty(output, key, {
        value: canonicalizeDocumentValue(descriptor.value, code, `${where}.${key}`, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalizeDocument(
  value: unknown,
  code: "InvalidConfig" | "InvalidResponse",
  where: string,
): DocumentData {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(code, `${where} must be a document object`);
  }
  const canonical = canonicalizeDocumentValue(
    value,
    code,
    where,
    new Set<object>(),
  ) as DocumentData;
  const id = Object.getOwnPropertyDescriptor(canonical, "_id")?.value;
  assertCodecDocId(id, `${where}._id`, code, invalid);
  return canonical;
}

function canonicalizeChunk(
  value: unknown,
  code: "InvalidConfig" | "InvalidResponse",
): SnapshotChunk {
  assertExactFields(
    value,
    ["schema_version", "collection", "incarnation", "first_id", "last_id", "docs"],
    "body",
    code,
    invalid,
  );
  if (value["schema_version"] !== SNAPSHOT_CHUNK_SCHEMA_VERSION) {
    invalid(code, "unsupported schema_version");
  }
  if (typeof value["collection"] !== "string") {
    invalid(code, "collection must be a string");
  }
  if (code === "InvalidConfig") {
    assertCallerSegment(value["collection"], "collection");
  }
  if (typeof value["incarnation"] !== "string" || !INCARNATION_PATTERN.test(value["incarnation"])) {
    invalid(code, "incarnation must be 32 lowercase hex characters");
  }
  if (!Array.isArray(value["docs"])) {
    invalid(code, "docs must be an array");
  }
  if (value["docs"].length === 0 || value["docs"].length > MAX_CHUNK_ROWS) {
    invalid(code, `docs must contain 1 through ${MAX_CHUNK_ROWS} documents`);
  }

  const docs = value["docs"].map((document, index) =>
    canonicalizeDocument(document, code, `docs[${index}]`),
  );
  for (let index = 1; index < docs.length; index++) {
    if (compareDocIds(docs[index - 1]!["_id"] as string, docs[index]!["_id"] as string) >= 0) {
      invalid(code, "document IDs must be strictly increasing");
    }
  }
  const firstId = docs[0]!["_id"] as string;
  const lastId = docs.at(-1)!["_id"] as string;
  if (value["first_id"] !== firstId || value["last_id"] !== lastId) {
    invalid(code, "first_id and last_id must match the document range");
  }

  return {
    schema_version: SNAPSHOT_CHUNK_SCHEMA_VERSION,
    collection: value["collection"],
    incarnation: value["incarnation"],
    first_id: firstId,
    last_id: lastId,
    docs,
  };
}

const CHUNK_OVERSIZE_MESSAGE = `canonical body exceeds ${MAX_CHUNK_BYTES} bytes`;

export const encodeSnapshotChunk = (chunk: SnapshotChunk): Uint8Array => {
  return normalizeCodecFailure(
    invalid,
    "InvalidConfig",
    "body exceeds supported JSON validation depth",
    () => {
      const canonical = canonicalizeChunk(chunk, "InvalidConfig");
      const bytes = encodeJsonBytes(canonical);
      if (bytes.byteLength > MAX_CHUNK_BYTES) {
        invalid("InvalidConfig", CHUNK_OVERSIZE_MESSAGE);
      }
      return bytes;
    },
  );
};

/**
 * True when `error` is the specific failure `encodeSnapshotChunk` throws for
 * a canonical body over `MAX_CHUNK_BYTES` — as opposed to any other encoding
 * or validation failure (bad doc-id ordering, excessive JSON depth, etc.),
 * which callers must not treat as a shrink-and-retry signal.
 */
export function isChunkOversizeError(error: unknown): error is BaerlyError {
  return error instanceof BaerlyError && error.message.endsWith(CHUNK_OVERSIZE_MESSAGE);
}

export const snapshotChunkKey = (
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
  const key = `${collectionPrefix}/_v2/snapshot/chunks/${incarnation}/sha256/${digest}.json`;
  assertKeyWithinLimit(key);
  return key;
};

export const decodeSnapshotChunk = async (
  bytes: Uint8Array,
  key: string,
  expectedCollection: string,
  descriptor: SnapshotChunkDescriptor,
): Promise<SnapshotChunk> => {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CHUNK_BYTES) {
    invalid("InvalidResponse", "body length is outside the chunk ceiling");
  }
  const bodyBytes = bytes.slice();
  const parsedKey = parseArtifactKey(key, "chunk", "InvalidResponse", invalid);
  if (descriptor.key !== key || descriptor.byte_length !== bodyBytes.byteLength) {
    invalid("InvalidResponse", "body does not match its descriptor key or byte length");
  }
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
      const value = canonicalizeChunk(parsed, "InvalidResponse");
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
  if (canonical.incarnation !== parsedKey.incarnation) {
    invalid("InvalidResponse", "body incarnation does not match its key");
  }
  if (
    canonical.first_id !== descriptor.first_id ||
    canonical.last_id !== descriptor.last_id ||
    canonical.docs.length !== descriptor.row_count
  ) {
    invalid("InvalidResponse", "body range or row count does not match its descriptor");
  }
  return canonical;
};
