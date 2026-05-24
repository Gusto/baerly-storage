/**
 * TC39 Stage-4 base64 codec methods — Node 22+, Bun, Workerd. Delete
 * when TypeScript accepts `esnext.typedarrays` in `--lib`.
 */
interface Uint8Array<TArrayBuffer extends ArrayBufferLike = ArrayBufferLike> {
  toBase64(options?: { alphabet?: "base64" | "base64url"; omitPadding?: boolean }): string;
}
interface Uint8ArrayConstructor {
  fromBase64(
    input: string,
    options?: {
      alphabet?: "base64" | "base64url";
      lastChunkHandling?: "loose" | "strict" | "stop-before-partial";
    },
  ): Uint8Array;
}
