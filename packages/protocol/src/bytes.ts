/**
 * UTF-8 JSON byte helpers — the common JSON payload encoder/decoder for
 * log entries, snapshots, current.json, and other protocol payloads.
 */

import { BaerlyError } from "./errors.ts";

const utf8Encoder = new TextEncoder();
// Default options only: no `fatal`, no `ignoreBOM`, never `stream: true`, so the
// decoder holds no state between calls and strips a leading BOM as before.
const utf8Decoder = new TextDecoder();

export const encodeJsonBytes = (value: unknown): Uint8Array =>
  utf8Encoder.encode(JSON.stringify(value));

export const decodeJsonBytes = <T = unknown>(bytes: Uint8Array): T =>
  JSON.parse(utf8Decoder.decode(bytes)) as T;

/**
 * The `InvalidResponse` to throw when stored bytes are not valid JSON.
 *
 * A `JSON.parse` `SyntaxError` is deliberately dropped, not attached as
 * `cause`: V8's "Unexpected token" message quotes a window of the source
 * text, which would carry stored values into logs. The message reports
 * only the body length and, when V8 states one, the failing character
 * position.
 *
 * @param what Caller's description, e.g. `current.json at ${key}: body is not valid JSON`.
 */
export const storedJsonParseError = (
  what: string,
  byteLength: number,
  error: unknown,
): BaerlyError => {
  const position =
    error instanceof Error ? /\bat position (\d+)/.exec(error.message)?.[1] : undefined;
  const where = position === undefined ? "" : `, error at position ${position}`;
  return new BaerlyError("InvalidResponse", `${what} (${byteLength} bytes${where})`);
};
