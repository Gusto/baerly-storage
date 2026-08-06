/**
 * UTF-8 JSON byte helpers — the common JSON payload encoder/decoder for
 * log entries, snapshots, current.json, and other protocol payloads.
 */

export const encodeJsonBytes = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

export const decodeJsonBytes = <T = unknown>(bytes: Uint8Array): T =>
  JSON.parse(new TextDecoder().decode(bytes)) as T;
