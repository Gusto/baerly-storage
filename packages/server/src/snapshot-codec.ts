import { BaerlyError, MAX_KEY_BYTES } from "@baerly/protocol";
import { assertSnapshotDocId } from "./snapshot-doc-id.ts";

/**
 * Machinery shared by the strict chunked-snapshot artifact codecs
 * (`snapshot-chunk.ts`, `snapshot-manifest.ts`) and the reference fold
 * (`chunked-snapshot-reference.ts`).
 *
 * Every helper reports failures through the caller's `fail` function so each
 * codec keeps its own artifact-scoped message prefix (`snapshot chunk: …`,
 * `snapshot manifest: …`, `chunked snapshot reference: …`) and error code,
 * while the validation logic itself exists exactly once. Layout invariants
 * come from ADR-007 (docs/adr/007-chunked-snapshot-layout.md).
 */

/** Failure polarity of a codec check: caller ingress vs. stored data. */
export type CodecCode = "InvalidConfig" | "InvalidResponse";

/** Artifact-scoped failure constructor bound by each codec. */
export type CodecFail = (code: CodecCode, message: string, cause?: unknown) => never;

/**
 * Build a `CodecFail` that prefixes every message with the codec's artifact
 * name. Callers must wrap this in a `function` declaration annotated
 * `: never` (`function invalid(...): never { return makeCodecFail(...)(...); }`)
 * rather than binding it directly to a `const` — TS control-flow narrowing
 * after an `invalid(...)` call only recognizes a `function` declaration's own
 * annotated `never` return, not a variable holding a `never`-returning value.
 */
export function makeCodecFail(prefix: string): CodecFail {
  return (code, message, cause) => {
    throw new BaerlyError(code, `${prefix}: ${message}`, cause);
  };
}

/** Chunk bodies encode to at most 1 MiB of canonical bytes (ADR-007). */
export const MAX_CHUNK_BYTES = 1024 * 1024;

/** A chunk is never empty and carries at most 4,096 rows (ADR-007). */
export const MAX_CHUNK_ROWS = 4096;

/** `incarnation` is 32 lowercase hex characters (ADR-007). */
export const INCARNATION_PATTERN = /^[0-9a-f]{32}$/;

/** Artifact digests are 64 lowercase hex characters (ADR-007). */
export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** The only chunk key grammar under a collection prefix (ADR-007). */
const CHUNK_KEY_PATTERN =
  /^(.+)\/_v2\/snapshot\/chunks\/([0-9a-f]{32})\/sha256\/([0-9a-f]{64})\.json$/;

/** The only manifest key grammar under a collection prefix (ADR-007). */
const MANIFEST_KEY_PATTERN =
  /^(.+)\/_v2\/snapshot\/manifests\/([0-9a-f]{32})\/sha256\/([0-9a-f]{64})\.json$/;

const utf8 = new TextEncoder();

/**
 * Convert a non-`BaerlyError` escape from a validation closure — in practice
 * the `RangeError` from recursing over pathologically nested data — into the
 * codec's typed failure.
 */
export function normalizeCodecFailure<T>(
  fail: CodecFail,
  code: CodecCode,
  message: string,
  operation: () => T,
): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof BaerlyError) {
      throw error;
    }
    fail(code, message, error);
  }
}

/** Require an object with exactly `expected` enumerable data fields. */
export function assertExactFields(
  value: unknown,
  expected: readonly string[],
  where: string,
  code: CodecCode,
  fail: CodecFail,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${where} must be an object`);
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
    fail(code, `${where} must contain exactly the required fields`);
  }
}

/** Validate a document ID and report rejection through the codec's `fail`. */
export function assertCodecDocId(
  value: unknown,
  where: string,
  code: CodecCode,
  fail: CodecFail,
): asserts value is string {
  if (typeof value !== "string") {
    fail(code, `${where} must be a string`);
  }
  try {
    assertSnapshotDocId(value);
  } catch (error) {
    fail(code, `${where} is invalid`, error);
  }
}

export interface ParsedArtifactKey {
  readonly prefix: string;
  readonly incarnation: string;
  readonly digest: string;
}

/** Parse and validate an artifact key under its schema-v2 grammar. */
export function parseArtifactKey(
  key: unknown,
  kind: "manifest" | "chunk",
  code: CodecCode,
  fail: CodecFail,
): ParsedArtifactKey {
  if (typeof key !== "string" || utf8.encode(key).byteLength > MAX_KEY_BYTES) {
    fail(code, `${kind} key is invalid or exceeds ${MAX_KEY_BYTES} bytes`);
  }
  const match = (kind === "manifest" ? MANIFEST_KEY_PATTERN : CHUNK_KEY_PATTERN).exec(key);
  if (match === null) {
    fail(code, `${kind} key does not match the schema-v2 grammar`);
  }
  if (match[1]!.endsWith("/")) {
    fail(code, `${kind} key collection prefix contains an empty trailing segment`);
  }
  return { prefix: match[1]!, incarnation: match[2]!, digest: match[3]! };
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

/** Patterns matching a validated field *value* leaking into a codec error message, as opposed to just the field name or a constraint description. */
export const LEAK_PATTERNS: readonly RegExp[] = [
  /incarnation:\s*["']?[0-9a-f]{32}["']?/i,
  /digest:\s*["']?[0-9a-f]{64}["']?/i,
  /first_id:\s*["'][^"']{1,256}["']/,
  /last_id:\s*["'][^"']{1,256}["']/,
  /byte_length:\s*\d{4,}/,
  /row_count:\s*\d{3,}/,
];

/**
 * Assert that a codec operation rejects with `expectedCode` and fails
 * closed: no validated field value leaked into the thrown message.
 *
 * Re-throws the original `BaerlyError` on failure so it can still be
 * asserted on by the caller (e.g. `expect(...).rejects.toMatchObject(...)`).
 * Always async and always awaits `operation()`, so it works uniformly for
 * codecs like `decodeSnapshotChunk` that only throw after their first
 * `await` — a sync wrapper would see those as "succeeded" (a pending
 * promise, not yet rejected) rather than catching the eventual rejection.
 */
export async function assertFailClosed(
  operation: () => unknown,
  expectedCode: CodecCode,
): Promise<never> {
  let result: unknown;
  try {
    result = await operation();
  } catch (error) {
    if (!(error instanceof BaerlyError)) {
      throw new Error(
        `assertFailClosed: expected BaerlyError with code ${expectedCode} but got ${String(error)}`,
        { cause: error },
      );
    }
    if (error.code !== expectedCode) {
      throw new Error(`assertFailClosed: expected code ${expectedCode} but got ${error.code}`, {
        cause: error,
      });
    }
    for (const pattern of LEAK_PATTERNS) {
      if (pattern.test(error.message)) {
        throw new Error(
          `assertFailClosed: error message may leak authoritative data: ${error.message}`,
          { cause: error },
        );
      }
    }
    throw error;
  }
  throw new Error(
    `assertFailClosed: expected ${expectedCode} but operation succeeded with ${JSON.stringify(result)}`,
  );
}
