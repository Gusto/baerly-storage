/**
 * UTF-8 JSON byte helpers — the common JSON payload encoder/decoder for
 * log entries, snapshots, current.json, and other protocol payloads.
 */

const utf8Encoder = new TextEncoder();
// Default options only: no `fatal`, no `ignoreBOM`, never `stream: true`, so the
// decoder holds no state between calls and strips a leading BOM as before.
const utf8Decoder = new TextDecoder();

export const encodeJsonBytes = (value: unknown): Uint8Array =>
  utf8Encoder.encode(JSON.stringify(value));

export const decodeJsonBytes = <T = unknown>(bytes: Uint8Array): T =>
  JSON.parse(utf8Decoder.decode(bytes)) as T;
