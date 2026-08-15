import { BaerlyError } from "@baerly/protocol";
import { assertPathSegment } from "./path-segment.ts";

/**
 * Guard a document ID admitted to the scalar-ordered snapshot layout.
 *
 * The existing path-segment rules protect key and filesystem safety. Snapshot
 * IDs additionally must be Unicode scalar-value strings, so their UTF-8
 * encoding and `utf8-scalar-v1` ordering are unambiguous.
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

/** Compare scalar-value strings by their UTF-8 lexicographic order. */
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
