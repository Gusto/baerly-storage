import {
  BaerlyError,
  LIST_OBJECT_MAX_RETRIES,
  RATE_LIMIT_BACKOFF_MILLIS,
  RETRY_AFTER_MAX_SECONDS,
  S3_REQUEST_MAX_RETRIES,
  delay,
  type Storage,
  type StorageGetOptions,
  type StorageGetResult,
  type StorageListEntry,
  type StoragePutOptions,
  type StoragePutResult,
} from "@baerly/protocol";
import { parseListObjectsV2CommandOutput, parseS3Error } from "./xml.ts";

/**
 * Permanent {@link BaerlyError} codes that must short-circuit `retry`.
 * These represent caller- or environment-level faults where retrying
 * cannot succeed: `AccessDenied` (403 — credentials/policy),
 * `InvalidConfig` (bad bucket / unsupported credential type),
 * `InvalidResponse` (server returned unparseable data), and
 * `Conflict` (CAS guard lost — retrying would just re-lose against
 * the same state). `NetworkError` is intentionally absent — it covers
 * transient transport faults and stays retryable.
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
function parseRetryAfter(header: string | null, now: () => number = Date.now): number | undefined {
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

const retryAfterCause = (res: Response): { retryAfterSeconds?: number } => {
  const hint = parseRetryAfter(res.headers.get("Retry-After"));
  return hint !== undefined ? { retryAfterSeconds: hint } : {};
};

// Detail suffix for a non-status-mapped S3 error response. When the
// body is a parseable `<Error><Code>…</Error>` document, surface S3's
// own error code (and message) instead of concatenating the raw XML
// blob into the thrown message; otherwise fall back to the raw text.
const s3ErrorDetail = (status: number, body: string): string => {
  const parsed = parseS3Error(body);
  if (parsed !== undefined) {
    const code = parsed.Code ?? "UnknownError";
    return parsed.Message !== undefined
      ? `${status} ${code}: ${parsed.Message}`
      : `${status} ${code}`;
  }
  return `${status} ${body}`;
};

const retry = async <T>(
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
  throw new BaerlyError("Internal", "s3-http retry loop exited without returning or throwing");
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

/**
 * Construction-time options for {@link S3HttpStorage}. Everything is
 * optional except `endpoint` and `bucket`; the consumer chooses how
 * to satisfy `fetch` (browser/Node global vs. injected) and `sign`
 * (anonymous Minio vs. SigV4-signed via aws4fetch).
 */
export interface S3HttpStorageOptions {
  /**
   * S3 endpoint URL, e.g. `https://s3.us-east-1.amazonaws.com` or
   * `http://127.0.0.1:9102` (Minio). Trailing slashes are trimmed.
   */
  endpoint: string;
  /** S3 bucket name. */
  bucket: string;
  /**
   * `fetch` implementation. Defaults to `globalThis.fetch.bind(globalThis)`.
   * Tests pass a `vi.fn()` stub.
   */
  fetch?: typeof fetch;
  /**
   * Signs requests before send. Pass `undefined` for anonymous
   * (Minio without creds). The seam is `(req) => Promise<req>` so
   * SigV4 implementations like `aws4fetch.AwsClient.sign` plug in
   * directly.
   */
  sign?: (req: Request) => Promise<Request>;
  /** Max retries for transient (non-permanent) failures. */
  retries?: number;
  /** Initial backoff in ms. */
  backoffMs?: number;
}

/**
 * `Storage` impl that speaks the S3 REST API directly. Works against
 * any S3-compatible endpoint — AWS S3, R2 (S3-compat), GCS (S3-compat),
 * Minio. Does not depend on any AWS SDK.
 *
 * Authentication is plugged in via the `sign` callback; this class
 * itself does no SigV4. For Cloudflare Workers, the R2 binding fast
 * path lives in `@baerly/adapter-cloudflare`.
 */
export class S3HttpStorage implements Storage {
  readonly #endpoint: string;
  readonly #bucket: string;
  readonly #fetch: typeof fetch;
  readonly #sign?: (req: Request) => Promise<Request>;
  readonly #retries: number;
  readonly #backoffMs: number;

  constructor(options: S3HttpStorageOptions) {
    this.#endpoint = options.endpoint.replace(/\/+$/, "");
    this.#bucket = options.bucket;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#sign = options.sign;
    this.#retries = options.retries ?? S3_REQUEST_MAX_RETRIES;
    this.#backoffMs = options.backoffMs ?? 100;
  }

  #objectUrl(key: string, versionId?: string): string {
    const base = `${this.#endpoint}/${this.#bucket}/${encodeURIComponent(key)}`;
    return versionId !== undefined ? `${base}?versionId=${encodeURIComponent(versionId)}` : base;
  }

  async #dispatch(req: Request): Promise<Response> {
    const signed = this.#sign ? await this.#sign(req) : req;
    try {
      return await this.#fetch(signed);
    } catch (error) {
      if (error instanceof BaerlyError) {
        throw error;
      }
      const msg = error instanceof Error ? error.message : String(error);
      throw new BaerlyError("NetworkError", msg, error);
    }
  }

  #retry<T>(fn: () => Promise<T>): Promise<T> {
    return retry(fn, { retries: this.#retries, backoffMs: this.#backoffMs });
  }

  async get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> {
    opts?.signal?.throwIfAborted();
    const url = this.#objectUrl(key, opts?.versionId);
    const headers = new Headers();
    if (opts?.ifNoneMatch !== undefined) {
      headers.set("If-None-Match", opts.ifNoneMatch);
    }
    return this.#retry(async () => {
      const res = await this.#dispatch(
        new Request(url, { method: "GET", headers, signal: opts?.signal ?? null }),
      );
      switch (res.status) {
        case 200: {
          const etag = res.headers.get("ETag");
          if (etag === null) {
            throw new BaerlyError("InvalidResponse", `GET ${key}: missing ETag`);
          }
          const body = new Uint8Array(await res.arrayBuffer());
          const versionId = res.headers.get("x-amz-version-id") ?? undefined;
          return versionId !== undefined ? { body, etag, versionId } : { body, etag };
        }
        case 304:
        case 404: {
          return null;
        }
        case 403: {
          throw new BaerlyError("AccessDenied", `GET ${key}: 403`);
        }
        default: {
          if (res.status === 429 || res.status >= 500) {
            throw new BaerlyError("NetworkError", `GET ${key}: ${res.status} ${await res.text()}`, {
              status: res.status,
              ...retryAfterCause(res),
            });
          }
          throw new BaerlyError(
            "InvalidResponse",
            `GET ${key}: ${s3ErrorDetail(res.status, await res.text())}`,
          );
        }
      }
    });
  }

  async put(key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult> {
    opts?.signal?.throwIfAborted();
    const url = this.#objectUrl(key);
    const headers = new Headers();
    headers.set("Content-Type", opts?.contentType ?? "application/octet-stream");
    if (opts?.ifMatch !== undefined) {
      headers.set("If-Match", opts.ifMatch);
    }
    if (opts?.ifNoneMatch === "*") {
      headers.set("If-None-Match", "*");
    }
    return this.#retry(async () => {
      const res = await this.#dispatch(
        new Request(url, {
          method: "PUT",
          headers,
          // TS lib.dom narrows BodyInit and a generic `Uint8Array<ArrayBufferLike>`
          // is not assignable; the runtime accepts it.
          body: body as BodyInit,
          signal: opts?.signal ?? null,
        }),
      );
      if (res.status === 412) {
        throw new BaerlyError("Conflict", `PUT ${key}: precondition failed`);
      }
      // S3-compatible servers diverge on `If-Match` against a missing
      // key: AWS S3 returns 412, Minio returns 404 (NoSuchKey). Map
      // 404-with-ifMatch to the same `Conflict` semantic so consumers
      // don't have to special-case the wire reply.
      if (res.status === 404 && opts?.ifMatch !== undefined) {
        throw new BaerlyError(
          "Conflict",
          `PUT ${key}: precondition failed (ifMatch=${opts.ifMatch} but key does not exist)`,
        );
      }
      if (res.status === 403) {
        throw new BaerlyError("AccessDenied", `PUT ${key}: 403`);
      }
      if (res.status === 429 || res.status >= 500) {
        throw new BaerlyError("NetworkError", `PUT ${key}: ${res.status} ${await res.text()}`, {
          status: res.status,
          ...retryAfterCause(res),
        });
      }
      if (res.status !== 200 && res.status !== 204) {
        throw new BaerlyError(
          "InvalidResponse",
          `PUT ${key}: ${s3ErrorDetail(res.status, await res.text())}`,
        );
      }
      const etag = res.headers.get("ETag");
      if (etag === null) {
        throw new BaerlyError("InvalidResponse", `PUT ${key}: missing ETag`);
      }
      const dateStr = res.headers.get("Date");
      const versionId = res.headers.get("x-amz-version-id") ?? undefined;
      const result: { etag: string; serverDate?: Date; versionId?: string } = { etag };
      if (dateStr !== null) {
        result.serverDate = new Date(dateStr);
      }
      if (versionId !== undefined) {
        result.versionId = versionId;
      }
      return result;
    });
  }

  async delete(key: string, opts?: { signal?: AbortSignal }): Promise<void> {
    opts?.signal?.throwIfAborted();
    const url = this.#objectUrl(key);
    await this.#retry(async () => {
      const res = await this.#dispatch(
        new Request(url, { method: "DELETE", signal: opts?.signal ?? null }),
      );
      if (res.status === 403) {
        throw new BaerlyError("AccessDenied", `DELETE ${key}: 403`);
      }
      if (res.status === 429 || res.status >= 500) {
        throw new BaerlyError("NetworkError", `DELETE ${key}: ${res.status} ${await res.text()}`, {
          status: res.status,
          ...retryAfterCause(res),
        });
      }
      // 200 / 204 / 404 → success (idempotent).
    });
  }

  async *list(
    prefix: string,
    opts?: { startAfter?: string; maxKeys?: number; signal?: AbortSignal },
  ): AsyncIterable<StorageListEntry> {
    opts?.signal?.throwIfAborted();
    let yielded = 0;
    let continuationToken: string | undefined;
    const startAfter = opts?.startAfter ?? "";
    while (true) {
      opts?.signal?.throwIfAborted();
      const params = new URLSearchParams();
      params.set("list-type", "2");
      params.set("prefix", prefix);
      // Force S3 to URL-encode object keys in the response so keys
      // containing XML-hostile or whitespace bytes survive the round trip.
      // The XML parser (`xmlVal` in ./xml.ts) reverses this on `Key`; only
      // the key family (Key/Prefix/Delimiter/StartAfter) is encoded — ETag
      // and NextContinuationToken come back verbatim.
      params.set("encoding-type", "url");
      if (continuationToken !== undefined) {
        params.set("continuation-token", continuationToken);
      } else if (startAfter !== "") {
        params.set("start-after", startAfter);
      }
      if (opts?.maxKeys !== undefined) {
        const remaining = opts.maxKeys - yielded;
        params.set("max-keys", String(Math.min(remaining, 1000)));
      }
      const url = `${this.#endpoint}/${this.#bucket}/?${params.toString()}`;

      // Per-page 429 retry budget separate from the inner #retry budget:
      // 429 means "rate-limited, back off and retry the same page", and
      // a single hot page shouldn't burn the overall transient-failure
      // budget.
      let parsed: Awaited<ReturnType<typeof parseListObjectsV2CommandOutput>> | undefined;
      let lastHint: number | undefined;
      for (let attempt = 0; attempt < LIST_OBJECT_MAX_RETRIES; attempt++) {
        const outcome = await this.#retry(async () => {
          const res = await this.#dispatch(
            new Request(url, { method: "GET", signal: opts?.signal ?? null }),
          );
          if (res.status === 200) {
            return { kind: "ok" as const, body: await res.text() };
          }
          if (res.status === 429) {
            return {
              kind: "ratelimited" as const,
              retryAfterSeconds: parseRetryAfter(res.headers.get("Retry-After")),
            };
          }
          if (res.status === 403) {
            throw new BaerlyError("AccessDenied", `LIST ${prefix}: 403`);
          }
          if (res.status >= 500) {
            throw new BaerlyError(
              "NetworkError",
              `LIST ${prefix}: ${res.status} ${await res.text()}`,
              { status: res.status, ...retryAfterCause(res) },
            );
          }
          throw new BaerlyError(
            "InvalidResponse",
            `LIST ${prefix}: ${s3ErrorDetail(res.status, await res.text())}`,
          );
        });
        if (outcome.kind === "ok") {
          parsed = parseListObjectsV2CommandOutput(outcome.body);
          break;
        }
        lastHint = outcome.retryAfterSeconds;
        const hintMs =
          outcome.retryAfterSeconds !== undefined ? outcome.retryAfterSeconds * 1000 : 0;
        await delay(Math.max(hintMs, RATE_LIMIT_BACKOFF_MILLIS));
      }
      if (parsed === undefined) {
        throw new BaerlyError("NetworkError", `LIST ${prefix}: rate-limited`, {
          status: 429,
          ...(lastHint !== undefined ? { retryAfterSeconds: lastHint } : {}),
        });
      }

      for (const entry of parsed.Contents ?? []) {
        if (entry.Key === undefined) {
          continue;
        }
        yield {
          key: entry.Key,
          etag: entry.ETag ?? "",
          ...(entry.LastModified !== undefined && { lastModified: entry.LastModified }),
        };
        yielded += 1;
        if (opts?.maxKeys !== undefined && yielded >= opts.maxKeys) {
          return;
        }
      }
      continuationToken = parsed.NextContinuationToken;
      if (continuationToken === undefined || continuationToken === "") {
        return;
      }
    }
  }
}
