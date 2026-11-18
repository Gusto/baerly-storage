import { MAX_REQUEST_ID_LENGTH } from "@baerly/protocol";

/**
 * Characters an inbound request id may use: letters, digits, and the
 * punctuation found in common id formats (UUID, ULID, W3C `traceparent`,
 * X-Ray `Root=1-…`, base64). No whitespace, quotes, or control
 * characters, so a caller cannot forge log structure through it.
 */
const REQUEST_ID_PATTERN = /^[\w.:/+=@-]+$/;

/**
 * The request id for a unit of work: the caller's `x-request-id` when it
 * is at most {@link MAX_REQUEST_ID_LENGTH} characters of
 * {@link REQUEST_ID_PATTERN}, otherwise a fresh UUID. An invalid header
 * is replaced, not truncated, so a log line never carries part of a
 * forged value.
 */
export const requestIdFrom = (headers: Headers): string => {
  const supplied = headers.get("x-request-id");
  return supplied !== null &&
    supplied.length <= MAX_REQUEST_ID_LENGTH &&
    REQUEST_ID_PATTERN.test(supplied)
    ? supplied
    : crypto.randomUUID();
};
