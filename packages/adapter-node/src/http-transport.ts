import { BaerlyError, RETRY_AFTER_MAX_SECONDS } from "@baerly/protocol";
import { parseS3Error } from "./xml.ts";

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
      cause: {
        status: res.status,
        ...retryAfterCause(res),
        ...(isThrottle(res.status, body) && { throttled: true }),
      },
    });
  }
  return new BaerlyError(
    "InvalidResponse",
    `${verb} ${key}: ${xmlErrorDetail(res.status, await res.text())}`,
  );
};

const isThrottle = (status: number, body: string): boolean =>
  status === 429 || (status === 503 && parseS3Error(body)?.Code === "SlowDown");

/**
 * S3 error codes for an expired STS session token. S3 answers these with
 * HTTP 400, not 403; AWS SDKs treat them as a signal to refresh credentials.
 */
const EXPIRED_TOKEN_CODES: ReadonlySet<string> = new Set(["ExpiredToken", "TokenRefreshRequired"]);

/**
 * Read the S3 expired-token code from a `400` response, or `undefined` for
 * any other response. Reads a clone, so `res` stays readable for
 * {@link mapS3StorageError}.
 */
export const s3ExpiredTokenCode = async (res: Response): Promise<string | undefined> => {
  if (res.status !== 400) {
    return undefined;
  }
  const code = parseS3Error(await res.clone().text())?.Code;
  return code !== undefined && EXPIRED_TOKEN_CODES.has(code) ? code : undefined;
};

/**
 * {@link mapStorageError} for the S3 adapter: a `400` carrying an
 * expired-token code is a credentials failure, so it maps to the permanent
 * `AccessDenied` whose message carries the S3 code, the state and the remedy;
 * every other response maps as {@link mapStorageError} does.
 */
export const mapS3StorageError = async (
  res: Response,
  verb: string,
  key: string,
): Promise<BaerlyError> => {
  if ((await s3ExpiredTokenCode(res)) !== undefined) {
    return new BaerlyError(
      "AccessDenied",
      `${verb} ${key}: ${xmlErrorDetail(400, await res.text())} — the credentials provider returned expired credentials even after a refresh; it should return fresh credentials with an accurate \`expiration\`.`,
      {
        resolution:
          "Return fresh credentials with an accurate `expiration` from the credentials provider; static session credentials must be replaced.",
      },
    );
  }
  return mapStorageError(res, verb, key);
};
