/**
 * UTF-8 JSON byte helpers — names the encode/decode idiom used by
 * every content body, log entry, snapshot, and current.json payload.
 */

export const encodeJsonBytes = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

export const decodeJsonBytes = <T = unknown>(bytes: Uint8Array): T =>
  JSON.parse(new TextDecoder().decode(bytes)) as T;
