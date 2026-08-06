import { sha256Hex } from "./sha256.ts";
import type { ContentVersionId } from "./types.ts";

/**
 * Width of the {@link ContentVersionId} hex strings produced by
 * {@link versionFromContent}. 32 hex chars = 128 bits, matching the
 * information content of a v4 UUID. Birthday-bound collision probability
 * at N=10⁹ legacy content-object writes is ~1.5 × 10⁻²¹ (≈ N² / 2¹²⁹).
 * Legacy writers did not verify collisions at runtime: two distinct
 * legacy bodies that share a truncated hash alias to the same content key,
 * so a legacy direct-bucket inspector could observe the wrong body. No
 * current kernel reader depends on these objects; readers use
 * `LogEntry.after`. The probability bound quantifies that legacy risk, not
 * a runtime integrity guarantee.
 *
 * @see docs/spec/log-entry-shape.md §"Legacy content side-object layout"
 */
const VERSION_HEX_LENGTH = 32;

/**
 * Legacy content-key {@link ContentVersionId}: SHA-256 of `body`,
 * lowercase hex, truncated to {@link VERSION_HEX_LENGTH}. Same body
 * bytes ⇒ same ContentVersionId. Retained to inspect and protect side
 * objects emitted by v0.6.0 writers, including during mixed-version
 * rollout; a retry of the same encoded body reproduces the legacy key.
 * `body` is non-canonical (`JSON.stringify`, insertion key order — see
 * `encodeJsonBytes`), so this is NOT cross-writer content dedup: different
 * key order ⇒ different key for an equal value.
 *
 * Async because {@link crypto.subtle.digest} returns an `ArrayBuffer`
 * via Promise. Workers and browsers both expose `crypto.subtle`
 * synchronously enough that the await fits naturally in the write
 * pipeline.
 *
 * @see docs/spec/log-entry-shape.md §"Legacy content side-object layout"
 */
export const versionFromContent = async (body: Uint8Array): Promise<ContentVersionId> => {
  const hex = await sha256Hex(body);
  return hex.slice(0, VERSION_HEX_LENGTH) as ContentVersionId;
};
