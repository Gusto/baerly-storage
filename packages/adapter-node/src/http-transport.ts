import {
  BaerlyError,
  RETRY_AFTER_MAX_SECONDS,
  S3_REQUEST_MAX_RETRIES,
  delay,
} from "@baerly/protocol";
import { parseS3Error } from "./xml.ts";

/**
 * Permanent {@link BaerlyError} codes that must short-circuit `retry`.
 * These represent caller- or environment-level faults where retrying
 * cannot succeed: `AccessDenied` (403 — credentials/policy),
 * `InvalidConfig` (bad bucket / unsupported credential type),
 * `InvalidResponse` (server returned unparseable data), and
 * `Conflict` (CAS guard lost — retrying would just re-lose against
 * the same state). `NetworkError` is intentionally absent — it covers
 * transient transport faults and stays retryable.
 *
 * Transport-layer set, distinct from `RETRIABLE_CODES` in `@baerly/protocol`'s
 * `errors.ts` (the default wire `retriable` hint). `Conflict` is "permanent"
 * here (a blind re-PUT re-loses the CAS race) yet retryable for logical CAS
 * callers that can fresh-read + re-apply. Same code, two different questions.
 */
const PERMANENT_ERROR_CODES: ReadonlySet<string> = new Set([
  "AccessDenied",
  "InvalidConfig",
  "InvalidResponse",
  "Conflict",
]);

/**
 * Parse an HTTP `Retry-After` header into a non-negative seconds value,
 * clamped to {@link RETRY_AFTER_MAX_SECONDS}. Returns `undefined` if
 * the header is absent, malformed, or whitespace.
 *
 * RFC 7231 §7.1.3 admits two forms: delta-seconds (non-negative
 * integer) and HTTP-date. Both are accepted; dates in the past return
 * `0`. Fractional seconds, negatives, and arbitrary strings reject.
 *
 * The `now` injection point exists for the unit test; production
 * callers should pass nothing.
 */
export function parseRetryAfter(
  header: string | null,
  now: () => number = Date.now,
): number | undefined {
  if (header === null) {
    return undefined;
  }
  const trimmed = header.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    return Number.isFinite(n) ? Math.min(n, RETRY_AFTER_MAX_SECONDS) : undefined;
  }
  // RFC 7231 §7.1.1.1 HTTP-date formats (IMF-fixdate, RFC 850, asctime)
  // all contain alphabetic month/day-of-week tokens. Gating on a letter
  // avoids V8's lenient `Date.parse` accepting things like "5.5".
  if (!/[a-z]/i.test(trimmed)) {
    return undefined;
  }
  const t = Date.parse(trimmed);
  if (Number.isNaN(t)) {
    return undefined;
  }
  const seconds = Math.max(0, Math.ceil((t - now()) / 1000));
  return Math.min(seconds, RETRY_AFTER_MAX_SECONDS);
}

export const retryAfterCause = (res: Response): { retryAfterSeconds?: number } => {
  const hint = parseRetryAfter(res.headers.get("Retry-After"));
  return hint !== undefined ? { retryAfterSeconds: hint } : {};
};

// Detail suffix for a non-status-mapped XML error response (S3 and GCS's
// native XML API share the same `<Error><Code>…</Error>` body shape). When
// the body is a parseable document, surface the store's own error code (and
// message) instead of concatenating the raw XML blob into the thrown
// message; otherwise fall back to the raw text.
export const xmlErrorDetail = (status: number, body: string): string => {
  const parsed = parseS3Error(body);
  if (parsed !== undefined) {
    const code = parsed.Code ?? "UnknownError";
    return parsed.Message !== undefined
      ? `${status} ${code}: ${parsed.Message}`
      : `${status} ${code}`;
  }
  return `${status} ${body}`;
};

export const retry = async <T>(
  fn: () => Promise<T>,
  { retries = S3_REQUEST_MAX_RETRIES, backoffMs = 100, maxDelayMs = 10_000 } = {},
): Promise<T> => {
  let wait = backoffMs;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof BaerlyError && PERMANENT_ERROR_CODES.has(error.code)) {
        throw error;
      }
      if (attempt === retries) {
        throw error;
      }
      const hintMs = retryAfterHintMs(error, maxDelayMs);
      await delay(hintMs ?? wait);
      if (hintMs === undefined) {
        wait = Math.min(wait * 1.5, maxDelayMs);
      } else {
        // A server-driven pause is new information about server state;
        // reset the exponential ladder so a subsequent non-hinted
        // transient starts fresh from `backoffMs`.
        wait = backoffMs;
      }
    }
  }
  throw new BaerlyError(
    "Internal",
    "http-transport retry loop exited without returning or throwing",
  );
};

const retryAfterHintMs = (e: unknown, maxDelayMs: number): number | undefined => {
  if (!(e instanceof BaerlyError)) {
    return undefined;
  }
  const cause = e.cause as { retryAfterSeconds?: number } | undefined;
  if (cause?.retryAfterSeconds === undefined) {
    return undefined;
  }
  return Math.min(cause.retryAfterSeconds * 1000, maxDelayMs);
};
