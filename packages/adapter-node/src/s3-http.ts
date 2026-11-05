import {
  BaerlyError,
  assertValidStorageKey,
  retryStorageCall,
  type Storage,
  type StorageGetOptions,
  type StorageGetResult,
  type StorageListEntry,
  type StoragePutOptions,
  type StoragePutResult,
} from "@baerly/protocol";
import { mapStorageError, retryAfterCause } from "./http-transport.ts";
import { parseListObjectsV2CommandOutput } from "./xml.ts";

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
  /**
   * Retries after the first attempt, for throttled and transient failures
   * alike (and per `list` page). Default `STORAGE_RETRY_MAX_ATTEMPTS - 1`
   * (2, so 3 attempts in total); `0` sends each request once. Must be a
   * non-negative integer; any other value makes each request reject with
   * `InvalidConfig` before it is sent.
   */
  retries?: number;
  /**
   * Backoff base in ms, overriding both default bases (50 ms after a
   * transient failure, 1 s after a throttle). Full jitter applies either
   * way. Omit for the default policy.
   */
  backoffMs?: number;
}

/**
 * `Storage` impl that speaks the S3 REST API directly. Works against
 * any S3-compatible endpoint — AWS S3, R2 (S3-compat), Minio. Does not
 * depend on any AWS SDK. GCS is NOT supported over this S3-interop path
 * (its conditional-write semantics can't linearize the commit log); use
 * the native `GcsHttpStorage` adapter instead.
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
  readonly #retries: number | undefined;
  readonly #backoffMs: number | undefined;

  constructor(options: S3HttpStorageOptions) {
    this.#endpoint = options.endpoint.replace(/\/+$/, "");
    this.#bucket = options.bucket;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#sign = options.sign;
    this.#retries = options.retries;
    this.#backoffMs = options.backoffMs;
  }

  #objectUrl(key: string, versionId?: string): string {
    // Choke point for every key-addressing verb — reject unaddressable
    // `.`/`..`/empty keys before URL normalization turns them into a
    // bucket-root 403. @see storage-compatibility.md "Key namespace".
    assertValidStorageKey(key);
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
      throw new BaerlyError("NetworkError", msg, { cause: error });
    }
  }

  #retry<T>(fn: () => Promise<T>, conditionalCreate = false): Promise<T> {
    return retryStorageCall(fn, {
      ...(this.#retries !== undefined && { retries: this.#retries }),
      ...(this.#backoffMs !== undefined && { backoffMs: this.#backoffMs }),
      conditionalCreate,
    });
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
        default: {
          throw await mapStorageError(res, "GET", key);
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
        throw new BaerlyError("WriteConflict", `PUT ${key}: precondition failed`);
      }
      // AWS S3 returns 409 ConditionalRequestConflict when concurrent
      // conditional writes race: a create (If-None-Match:"*") or a CAS
      // (If-Match). Minio returns 412. 409 means the write was contended
      // and may NOT have landed, so it maps to a retryable NetworkError —
      // this adapter's retry re-issues the same PUT, which resolves to 200
      // (we win) or 412 (key changed/present → WriteConflict → the Writer's
      // readback adopts or re-probes). A direct WriteConflict here would
      // adopt-read a possibly-absent entry.
      if (res.status === 409 && (opts?.ifNoneMatch === "*" || opts?.ifMatch !== undefined)) {
        throw new BaerlyError(
          "NetworkError",
          `PUT ${key}: 409 ConditionalRequestConflict (contended conditional write; retryable)`,
          { cause: { status: res.status, ...retryAfterCause(res) } },
        );
      }
      // S3-compatible servers diverge on `If-Match` against a missing
      // key: AWS S3 returns 412, Minio returns 404 (NoSuchKey). Map
      // 404-with-ifMatch to the same `WriteConflict` semantic so consumers
      // don't have to special-case the wire reply.
      if (res.status === 404 && opts?.ifMatch !== undefined) {
        throw new BaerlyError(
          "WriteConflict",
          `PUT ${key}: precondition failed (ifMatch=${opts.ifMatch} but key does not exist)`,
        );
      }
      if (res.status !== 200 && res.status !== 204) {
        throw await mapStorageError(res, "PUT", key);
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
    }, opts?.ifNoneMatch === "*");
  }

  async delete(key: string, opts?: { signal?: AbortSignal }): Promise<void> {
    opts?.signal?.throwIfAborted();
    const url = this.#objectUrl(key);
    await this.#retry(async () => {
      const res = await this.#dispatch(
        new Request(url, { method: "DELETE", signal: opts?.signal ?? null }),
      );
      // 200 / 204 / 404 → success (idempotent); any other status is a real
      // failure (403 → AccessDenied, 429/≥500 → retryable NetworkError, else
      // InvalidResponse) rather than a silently-swallowed non-2xx.
      if (res.status !== 200 && res.status !== 204 && res.status !== 404) {
        throw await mapStorageError(res, "DELETE", key);
      }
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

      // One retry budget per page: 429 and 5xx share the attempt counter,
      // so a page costs at most `retries + 1` requests whatever fails.
      const parsed = parseListObjectsV2CommandOutput(
        await this.#retry(async () => {
          const res = await this.#dispatch(
            new Request(url, { method: "GET", signal: opts?.signal ?? null }),
          );
          if (res.status !== 200) {
            throw await mapStorageError(res, "LIST", prefix);
          }
          return res.text();
        }),
      );

      for (const entry of parsed.Contents ?? []) {
        if (entry.Key === undefined) {
          continue;
        }
        yield {
          key: entry.Key,
          etag: entry.ETag ?? "",
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
