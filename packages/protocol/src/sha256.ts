/**
 * SHA-256 of `bytes` as a 64-char lowercase hex string.
 *
 * Zero-import leaf module on purpose: co-locating this with heavier
 * runtime (snapshot-hash.ts / hashing.ts) would drag that module into
 * every consumer's bundle closure. Callers that want a truncated form
 * (e.g. {@link versionFromContent}'s content keys) slice the return.
 */
export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  // Copy via fresh ArrayBuffer: tsc narrows `Uint8Array` to
  // `Uint8Array<ArrayBufferLike>`, which `crypto.subtle.digest` rejects
  // (wants `ArrayBufferView<ArrayBuffer>`). See microsoft/TypeScript#61375.
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view);
  return new Uint8Array(digest).toHex();
};
