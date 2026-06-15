import { BaerlyError, MAX_KEY_BYTES } from "@baerly/protocol";

const utf8 = new TextEncoder();

/**
 * Reject an assembled object key over the S3/R2 full-key ceiling
 * ({@link MAX_KEY_BYTES}) as `InvalidConfig`. Per-segment caps don't
 * bound the sum, and index values skip `assertPathSegment` entirely, so
 * this post-encoding check at the writer's PUT sites is their only
 * overflow guard. @see docs/spec/storage-compatibility.md
 */
export const assertKeyWithinLimit = (key: string): void => {
  const bytes = utf8.encode(key).length;
  if (bytes > MAX_KEY_BYTES) {
    throw new BaerlyError(
      "InvalidConfig",
      `object key exceeds ${MAX_KEY_BYTES} bytes (got ${bytes}): ${JSON.stringify(key.slice(0, 80))}…`,
    );
  }
};
