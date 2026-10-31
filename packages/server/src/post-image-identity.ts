import { BaerlyError, type DocumentData } from "@baerly/protocol";
import type { CodecCode, CodecFail } from "./snapshot-codec.ts";

const throwBaerlyError: CodecFail = (code, message, cause) => {
  throw new BaerlyError(code, `post-image: ${message}`, cause);
};

/**
 * Assert that an insert/update post-image names the document it is stored
 * under: `after` is a plain object (prototype `Object.prototype` or `null`,
 * not an array) whose own enumerable data property `_id` is a string
 * `=== docId`.
 *
 * This checks identity only. It does not validate `docId` against the
 * `utf8-scalar-v1` domain, and it does not validate any other field of the
 * document. Callers that need the scalar domain call `assertCodecDocId` or
 * `assertSnapshotDocId` first.
 *
 * `code` selects the failure polarity: `InvalidConfig` for caller input,
 * `InvalidResponse` for stored input. Failures go through `fail` when given,
 * so a codec keeps its own message prefix; otherwise this throws a
 * `BaerlyError` with `code`.
 */
export function assertPostImageIdentity(
  docId: string,
  after: unknown,
  code: CodecCode,
  fail: CodecFail = throwBaerlyError,
): asserts after is DocumentData {
  if (after === null || typeof after !== "object" || Array.isArray(after)) {
    fail(code, "after must be a document object");
  }
  const prototype = Object.getPrototypeOf(after);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(code, "after must be a plain object");
  }
  const descriptor = Object.getOwnPropertyDescriptor(after, "_id");
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
    fail(code, "after._id must be an own enumerable data property");
  }
  if (typeof descriptor.value !== "string" || descriptor.value !== docId) {
    fail(code, "after._id must equal doc_id");
  }
}
