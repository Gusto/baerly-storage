/**
 * SHA-256 of `bytes` as a 64-char lowercase hex string.
 *
 * Zero-import leaf module on purpose: co-locating this with heavier
 * runtime (snapshot-hash.ts / hashing.ts) would drag that module into
 * every consumer's bundle closure. Callers that want a truncated form
 * (e.g. {@link versionFromContent}'s content keys) slice the return.
 */
export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  // tsc narrows `Uint8Array` to `Uint8Array<ArrayBufferLike>`, which
  // `crypto.subtle.digest` rejects (wants `ArrayBufferView<ArrayBuffer>`;
  // microsoft/TypeScript#61375). A view over an `ArrayBuffer` is passed
  // through and hashes only its own bytes, even at an offset; digest
  // copies its input synchronously. A `SharedArrayBuffer`-backed view is
  // not a valid `BufferSource`, so copy that case.
  let view: Uint8Array<ArrayBuffer>;
  if (bytes.buffer instanceof ArrayBuffer) {
    // Narrowing `bytes.buffer` does not narrow `bytes`; the check above is the proof.
    view = bytes as Uint8Array<ArrayBuffer>;
  } else {
    view = new Uint8Array(bytes.byteLength);
    view.set(bytes);
  }
  const digest = await crypto.subtle.digest("SHA-256", view);
  return new Uint8Array(digest).toHex();
};
