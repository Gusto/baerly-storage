import type { ContentVersionId } from "./types.ts";

/**
 * Width of the {@link ContentVersionId} hex strings produced by
 * {@link versionFromContent}. 32 hex chars = 128 bits, matching the
 * information content of the v4 UUID that previously seeded
 * `versionFromUuid`. Collision probability with N=10⁹ writes is
 * ~3 × 10⁻²⁰; ample for a content-addressed version id.
 *
 * @see docs/spec/log-entry-shape.md §"Content body layout"
 */
const VERSION_HEX_LENGTH = 32;

/**
 * Content-addressed {@link ContentVersionId}: SHA-256 of `body`,
 * lowercase hex, truncated to {@link VERSION_HEX_LENGTH}. Same body
 * bytes ⇒ same ContentVersionId — the property `ServerWriter.commit`
 * relies on for idempotent replay (a crash-recovery rewrite of the
 * same logical value produces the same content key the manifest
 * already referenced).
 *
 * Async because {@link crypto.subtle.digest} returns an `ArrayBuffer`
 * via Promise. Workers and browsers both expose `crypto.subtle`
 * synchronously enough that the await fits naturally in the write
 * pipeline.
 *
 * @see docs/spec/log-entry-shape.md §"Content body layout"
 */
export const versionFromContent = async (body: Uint8Array): Promise<ContentVersionId> => {
  // Copy via fresh ArrayBuffer: tsgo narrows `Uint8Array` to
  // `Uint8Array<ArrayBufferLike>`, which `crypto.subtle.digest` rejects
  // (wants `ArrayBufferView<ArrayBuffer>`). See microsoft/TypeScript#61375.
  const view = new Uint8Array(body.byteLength);
  view.set(body);
  const digest = await crypto.subtle.digest("SHA-256", view);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex.slice(0, VERSION_HEX_LENGTH) as ContentVersionId;
};
