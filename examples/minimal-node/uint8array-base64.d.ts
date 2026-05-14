/**
 * Ambient shim for `Uint8Array.{toBase64,fromBase64}` — TC39 Stage-4 methods
 * shipped in Node 22+, Bun, and Workerd. TypeScript 5.7's `lib.*.d.ts` does
 * not yet declare them, so this declaration exists purely to keep
 * `tsc --noEmit` quiet against the workspace's `@baerly/protocol` source.
 *
 * In a scaffolded standalone project the npm-installed `@baerly/protocol`
 * ships its own `.d.ts` (compiled by `tsgo`) which declares the methods,
 * so this file is harmless redundancy there. When TS proper ships these
 * declarations (likely in `lib.esnext.typedarrays.d.ts`), delete this file.
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
