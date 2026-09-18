/**
 * Encode-counter load hook for the workload-ceiling win model.
 *
 * Wraps the three encode bottlenecks plus `snapshotHash` with global
 * byte/call counters. Each wrap asserts the target's source shape, so a
 * silent miss after a refactor throws `HOOK MISS` instead of undercounting.
 *
 * The wraps only increment when `globalThis.__enc` is present. The
 * registrar (`workload-ceiling-win-model-hooks.mjs`) seeds it in the
 * application realm; this module's own globalThis is a different context.
 *
 * Wired through `workload-ceiling-win-model-hooks.mjs`, which also chains
 * `bench/resolve-ts.mjs`. Do not register this file alone: `@baerly/protocol`
 * internals are extensionless.
 */
function wrap(src, url, needle, replacement, tail) {
  if (!src.includes(needle)) {
    throw new Error(`HOOK MISS in ${url}: ${needle}`);
  }
  return src.replace(needle, replacement) + tail;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (result.source === undefined || result.source === null) {
    return result;
  }
  let src =
    typeof result.source === "string" ? result.source : Buffer.from(result.source).toString("utf8");

  if (url.endsWith("/packages/protocol/src/bytes.ts")) {
    src = wrap(
      src,
      url,
      "export const encodeJsonBytes = (value: unknown): Uint8Array =>",
      "const __realEncodeJsonBytes = (value: unknown): Uint8Array =>",
      `
export const encodeJsonBytes = (value: unknown): Uint8Array => {
  const out = __realEncodeJsonBytes(value);
  const g = globalThis;
  if (g.__enc) { g.__enc.jsonCalls++; g.__enc.jsonBytes += out.byteLength; }
  return out;
};
`,
    );
  }

  if (url.endsWith("/packages/server/src/snapshot-chunk.ts")) {
    src = wrap(
      src,
      url,
      "export const encodeSnapshotChunk = (chunk: SnapshotChunk): Uint8Array => {",
      "const __realEncodeSnapshotChunk = (chunk: SnapshotChunk): Uint8Array => {",
      `
export const encodeSnapshotChunk = (chunk: SnapshotChunk): Uint8Array => {
  const out = __realEncodeSnapshotChunk(chunk);
  const g = globalThis;
  if (g.__enc) { g.__enc.chunkCalls++; g.__enc.chunkBytes += out.byteLength; g.__enc.chunkDocs += chunk.docs.length; }
  return out;
};
`,
    );
  }

  if (url.endsWith("/packages/server/src/snapshot.ts")) {
    src = wrap(
      src,
      url,
      "export const encodeSnapshotBody = (s: SnapshotBody): Uint8Array => encodeJsonBytes(s);",
      "const __realEncodeSnapshotBody = (s: SnapshotBody): Uint8Array => encodeJsonBytes(s);",
      `
export const encodeSnapshotBody = (s: SnapshotBody): Uint8Array => {
  const out = __realEncodeSnapshotBody(s);
  const g = globalThis;
  if (g.__enc) { g.__enc.bodyCalls++; g.__enc.bodyBytes += out.byteLength; }
  return out;
};
`,
    );
  }

  if (url.endsWith("/packages/protocol/src/snapshot-hash.ts")) {
    src = wrap(
      src,
      url,
      "export const snapshotHash = (bytes: Uint8Array): Promise<string> => sha256Hex(bytes);",
      "const __realSnapshotHash = (bytes: Uint8Array): Promise<string> => sha256Hex(bytes);",
      `
export const snapshotHash = (bytes: Uint8Array): Promise<string> => {
  const g = globalThis;
  if (g.__enc) { g.__enc.hashCalls++; g.__enc.hashBytes += bytes.byteLength; }
  return __realSnapshotHash(bytes);
};
`,
    );
  }

  return { ...result, source: src };
}
