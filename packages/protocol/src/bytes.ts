/**
 * UTF-8 byte helpers for JSON payloads stored on the bucket.
 *
 * Every content body, log entry, snapshot, current.json, and
 * coordination doc is serialised as UTF-8 JSON bytes. The raw
 * `new TextEncoder().encode(JSON.stringify(x))` /
 * `JSON.parse(new TextDecoder().decode(bytes))` idiom appeared
 * verbatim across the kernel, the maintenance loop, and the CLI;
 * naming the operation makes the call sites read like intent.
 *
 * Each helper allocates a fresh encoder/decoder per call. That
 * matches the existing call-site shape and keeps the helpers
 * stateless — module-level singletons would survive cross-realm
 * boundaries (Workers / Node / Bun) but the per-call allocation
 * is a micro-optimisation we can revisit if it shows up in a
 * bench.
 */

export const encodeJsonBytes = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

export const decodeJsonBytes = <T = unknown>(bytes: Uint8Array): T =>
  JSON.parse(new TextDecoder().decode(bytes)) as T;
