import { BaerlyError } from "@baerly/protocol";
import { assertPathSegment } from "./path-segment.ts";

/**
 * Guard a document ID admitted to the scalar-ordered snapshot layout.
 *
 * The existing path-segment rules protect key and filesystem safety. Snapshot
 * IDs additionally must be Unicode scalar-value strings, so their UTF-8
 * encoding and `utf8-scalar-v1` ordering are unambiguous.
 *
 * The accepted set is the durable document-ID domain of the chunked snapshot
 * format, and `MAX_SEGMENT_BYTES` (`path-segment.ts`) is one of its inputs:
 * the format contract fixes the byte ceiling at 256, so changing that
 * constant is a format change, not a policy tweak.
 */
export const assertSnapshotDocId = (id: string): void => {
  assertPathSegment(id, "_id");
  for (let offset = 0; offset < id.length; offset++) {
    const unit = id.charCodeAt(offset);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = id.charCodeAt(offset + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new BaerlyError("InvalidConfig", "_id may not contain isolated UTF-16 surrogates");
      }
      offset++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new BaerlyError("InvalidConfig", "_id may not contain isolated UTF-16 surrogates");
    }
  }
};

/**
 * Compare scalar-value strings by their UTF-8 lexicographic order
 * (`utf8-scalar-v1`): by code point, a proper prefix first. Returns exactly
 * `-1`, `0`, or `1`, and allocates nothing.
 *
 * This is not UTF-16 code-unit order, which is what JS `<` and a default
 * `Array.prototype.sort` use, nor locale collation (`localeCompare`). Code
 * point and code-unit order disagree exactly when the first difference is a
 * code point in U+E000–U+FFFF against an astral one: `"\uFFFD" < "\u{10000}"` is `false`, but
 * `compareDocIds("\uFFFD", "\u{10000}") === -1`. Order IDs only with this
 * function.
 *
 * Precondition: both arguments passed `assertSnapshotDocId`. On a string
 * with an unpaired surrogate this compares the lone code unit as if it were
 * a code point in U+D800–U+DFFF, whereas every UTF-8 encoder emits U+FFFD
 * for it, so the result would disagree with byte order. The comparator does
 * not check its input, to keep a scan out of every comparison in the
 * planner, builder, and view; callers validate first.
 */
export const compareDocIds = (left: string, right: string): number => {
  let leftOffset = 0;
  let rightOffset = 0;
  while (leftOffset < left.length && rightOffset < right.length) {
    const leftPoint = left.codePointAt(leftOffset)!;
    const rightPoint = right.codePointAt(rightOffset)!;
    if (leftPoint !== rightPoint) {
      return leftPoint < rightPoint ? -1 : 1;
    }
    leftOffset += leftPoint > 0xffff ? 2 : 1;
    rightOffset += rightPoint > 0xffff ? 2 : 1;
  }
  if (leftOffset === left.length && rightOffset === right.length) {
    return 0;
  }
  return leftOffset === left.length ? -1 : 1;
};
