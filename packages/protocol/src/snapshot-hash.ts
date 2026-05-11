/**
 * SHA-256 of `bytes` as a 64-char lowercase hex string. Used to seal
 * snapshot filenames so a crashed mid-PUT can't produce a body that
 * readers consume as truth: the filename embeds the hash; readers
 * recompute on load and reject any mismatch as "file missing."
 *
 * Distinct from {@link versionFromContent} (truncated to 32 chars for
 * content keys) — snapshot bodies are larger and longer-lived;
 * 256-bit collision resistance matters here.
 */
export const snapshotHash = async (bytes: Uint8Array): Promise<string> => {
  // Copy via fresh ArrayBuffer: tsgo narrows `Uint8Array` to
  // `Uint8Array<ArrayBufferLike>`, which `crypto.subtle.digest` rejects
  // (wants `ArrayBufferView<ArrayBuffer>`). See microsoft/TypeScript#61375
  // and `versionFromContent` in ./hashing.ts for the same workaround.
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view);
  const out = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < out.length; i++) {
    hex += out[i]!.toString(16).padStart(2, "0");
  }
  return hex;
};
