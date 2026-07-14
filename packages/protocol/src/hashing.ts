import { sha256Hex } from "./sha256.ts";
import type { ContentVersionId } from "./types.ts";

/**
 * Width of the {@link ContentVersionId} hex strings produced by
 * {@link versionFromContent}. 32 hex chars = 128 bits, matching the
 * information content of a v4 UUID. Birthday-bound collision probability
 * at N=10⁹ writes is ~1.5 × 10⁻²¹ (≈ N² / 2¹²⁹); ample for a
 * content-addressed version id. A collision is not detected at runtime —
 * two distinct bodies that share a truncated hash would alias to the same
 * content key, so a reader could observe the wrong body. The bound above
 * is the sole guard, and it sits far below any plausible write volume.
 *
 * @see docs/spec/log-entry-shape.md §"Content body layout"
 */
const VERSION_HEX_LENGTH = 32;

/**
 * Content-addressed {@link ContentVersionId}: SHA-256 of `body`,
 * lowercase hex, truncated to {@link VERSION_HEX_LENGTH}. Same body
 * bytes ⇒ same ContentVersionId — scoped to **single-writer idempotent
 * replay** (a crash-recovery rewrite of the same in-memory value by the
 * same writer reproduces the content key the manifest already
 * referenced). `body` is non-canonical (`JSON.stringify`, insertion
 * key order — see `encodeJsonBytes`), so this is NOT cross-writer
 * content dedup: different key order ⇒ different key for an equal value.
 *
 * Async because {@link crypto.subtle.digest} returns an `ArrayBuffer`
 * via Promise. Workers and browsers both expose `crypto.subtle`
 * synchronously enough that the await fits naturally in the write
 * pipeline.
 *
 * @see docs/spec/log-entry-shape.md §"Content body layout"
 */
export const versionFromContent = async (body: Uint8Array): Promise<ContentVersionId> => {
  const hex = await sha256Hex(body);
  return hex.slice(0, VERSION_HEX_LENGTH) as ContentVersionId;
};
