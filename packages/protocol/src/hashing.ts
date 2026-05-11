import type { Branded, ContentVersionId } from "./types";

export type b64 = Branded<string, "b64">;

export const toB64 = (a: Uint8Array): b64 => a.toBase64() as b64;

export const fromB64 = (a: b64): Uint8Array => Uint8Array.fromBase64(a);

export const or = (a: b64, b: b64): b64 => {
  const bi = fromB64(b);
  return toB64(fromB64(a).map((byte, i) => byte | bi[i]!));
};

/**
 * Test if the 1s in bitstring A are all present in B
 */
export const inside = (a: b64, b: b64): boolean => {
  // Every bit set in A must also be set in B: (A & B) === A.
  const bi = fromB64(b);
  return fromB64(a).reduce((acc, ai, i) => acc && (ai & bi[i]!) === ai, true);
};

/**
 * Width of the {@link ContentVersionId} hex strings produced by
 * {@link versionFromContent}. 32 hex chars = 128 bits, matching the
 * information content of the v4 UUID that previously seeded
 * `versionFromUuid`. Collision probability with N=10⁹ writes is
 * ~3 × 10⁻²⁰; ample for a content-addressed version id.
 */
const VERSION_HEX_LENGTH = 32;

/**
 * Content-addressed {@link ContentVersionId}: SHA-256 of `body`,
 * lowercase hex, truncated to {@link VERSION_HEX_LENGTH}. Same body
 * bytes ⇒ same ContentVersionId — the property `mps3.putAllResolved` relies
 * on for idempotent replay (a crash-recovery rewrite of the same
 * logical value produces the same content key the manifest already
 * referenced).
 *
 * Async because {@link crypto.subtle.digest} returns an `ArrayBuffer`
 * via Promise. Workers and browsers both expose `crypto.subtle`
 * synchronously enough that the await fits naturally in the write
 * pipeline.
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
