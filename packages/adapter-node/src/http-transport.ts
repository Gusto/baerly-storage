import {
  BaerlyError,
  RETRY_AFTER_MAX_SECONDS,
  S3_REQUEST_MAX_RETRIES,
  delay,
  type BaerlyErrorCode,
} from "@baerly/protocol";
import { parseS3Error } from "./xml.ts";

/**
 * Permanent {@link BaerlyError} codes that must short-circuit `retry`.
 * These represent caller- or environment-level faults where retrying
 * cannot succeed: `AccessDenied` (403 — credentials/policy),
 * `InvalidConfig` (bad bucket / unsupported credential type),
 * `InvalidResponse` (server returned unparseable data), and
 * `WriteConflict` (a precondition was rejected). `NetworkError` is
 * intentionally absent — it covers transient transport faults and stays
 * retryable.
 *
 * Transport-layer set, distinct from `RETRIABLE_CODES` in `@baerly/protocol`'s
 * `errors.ts`. A blind re-PUT of the same request re-loses a rejected
 * precondition, so this layer never resends it. `WriteConflict` is still
 * retriable for the logical caller: it re-reads and issues a new request,
 * which is what `retriable` means.
 */
const PERMANENT_ERROR_CODES: ReadonlySet<BaerlyErrorCode> = new Set<BaerlyErrorCode>([
  "AccessDenied",
  "InvalidConfig",
  "InvalidResponse",
  "WriteConflict",
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

/**
 * Shared status→{@link BaerlyError} mapping for the S3/GCS XML adapters, so
 * the retryable set (`429`/`≥500`) can't drift between them. Store-specific
 * statuses (GCS `412`; S3 `409`/`404`-with-`If-Match`) are handled inline
 * first; the rest route here: `403`→AccessDenied (permanent), `429`/`≥500`→
 * retryable NetworkError carrying `{status, retryAfterSeconds?}`, else
 * InvalidResponse. Callers `throw` the result; consumes `res.text()` on the
 * non-`403` paths. A throttle (`429`, or S3's `503 SlowDown`) also carries
 * `throttled: true`: the store refused the request without applying it.
 */
export const mapStorageError = async (
  res: Response,
  verb: string,
  key: string,
): Promise<BaerlyError> => {
  if (res.status === 403) {
    return new BaerlyError("AccessDenied", `${verb} ${key}: 403`);
  }
  if (res.status === 429 || res.status >= 500) {
    const body = await res.text();
    return new BaerlyError("NetworkError", `${verb} ${key}: ${res.status} ${body}`, {
      status: res.status,
      ...retryAfterCause(res),
      ...(isThrottle(res.status, body) && { throttled: true }),
    });
  }
  return new BaerlyError(
    "InvalidResponse",
    `${verb} ${key}: ${xmlErrorDetail(res.status, await res.text())}`,
  );
};

const isThrottle = (status: number, body: string): boolean =>
  status === 429 || (status === 503 && parseS3Error(body)?.Code === "SlowDown");

/** `true` when an attempt's rejection proves that attempt was not applied. */
const isThrottled = (e: unknown): boolean =>
  e instanceof BaerlyError && (e.cause as { throttled?: boolean } | undefined)?.throttled === true;

/**
 * Retry `fn` on non-permanent failures with exponential backoff.
 *
 * Set `conditionalCreate` for an `If-None-Match: "*"` PUT. An attempt that
 * failed transiently may still have landed, so a later permanent rejection
 * other than `WriteConflict` (for example a 403) cannot prove the create is not
 * durable. That rejection is reported as `NetworkError` carrying the
 * original error as its cause, per the `Storage.put` contract. When every
 * attempt was throttled, nothing was applied, so the final `NetworkError`'s
 * cause carries `notApplied: true`.
 */
export const retry = async <T>(
  fn: () => Promise<T>,
  {
    retries = S3_REQUEST_MAX_RETRIES,
    backoffMs = 100,
    maxDelayMs = 10_000,
    conditionalCreate = false,
  } = {},
): Promise<T> => {
  let wait = backoffMs;
  // Set once an attempt of a conditional create ends with an unknown outcome.
  let uncertain = false;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof BaerlyError && PERMANENT_ERROR_CODES.has(error.code)) {
        if (conditionalCreate && uncertain && error.code !== "WriteConflict") {
          throw new BaerlyError(
            "NetworkError",
            `${error.message} (an earlier attempt of this conditional create may have landed)`,
            error,
          );
        }
        throw error;
      }
      if (!isThrottled(error)) {
        uncertain = true;
      }
      if (attempt === retries) {
        if (conditionalCreate && !uncertain && error instanceof BaerlyError) {
          throw new BaerlyError(error.code, error.message, {
            ...(error.cause as object),
            notApplied: true,
          });
        }
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
