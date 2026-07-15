import {
  BaerlyError,
  LIST_OBJECT_MAX_RETRIES,
  RATE_LIMIT_BACKOFF_MILLIS,
  S3_REQUEST_MAX_RETRIES,
  assertValidStorageKey,
  delay,
  type Storage,
  type StorageGetOptions,
  type StorageGetResult,
  type StorageListEntry,
  type StoragePutOptions,
  type StoragePutResult,
} from "@baerly/protocol";
import { mapStorageError, parseRetryAfter, retry } from "./http-transport.ts";
import { parseListObjectsV2CommandOutput } from "./xml.ts";

/** Default GCS native XML API endpoint. */
export const DEFAULT_GCS_ENDPOINT = "https://storage.googleapis.com";

/**
 * Construction-time options for {@link GcsHttpStorage}. Everything is
 * optional except `bucket`; `endpoint` defaults to the GCS native XML
 * API host. `sign` is injected — `gcsStorage` wires in the
 * GOOG4-HMAC-SHA256 signer ({@link goog4Signer}); unit tests pass a
 * passthrough.
 */
export interface GcsHttpStorageOptions {
  /** GCS endpoint. Defaults to `https://storage.googleapis.com`. */
  endpoint?: string;
  /** GCS bucket name. */
  bucket: string;
  /** `fetch` implementation. Defaults to `globalThis.fetch.bind(globalThis)`. */
  fetch?: typeof fetch;
  /** Signs requests before send. GOOG4-HMAC-SHA256 in production. */
  sign?: (req: Request) => Promise<Request>;
  /** Max retries for transient (non-permanent) failures. */
  retries?: number;
  /** Initial backoff in ms. */
  backoffMs?: number;
}

/**
 * `Storage` impl that speaks the GCS native XML API and drives GCS's own
 * `x-goog-if-generation-match` conditional writes. Unlike GCS's S3-interop
 * endpoint (which treats `If-Match`/`If-None-Match` as read-scoped and can
 * never linearize the log), the native API returns 412 on any precondition
 * miss and the object `generation` in `x-goog-generation`. That generation
 * is carried verbatim in the opaque `Storage` etag.
 *
 * Authentication is plugged in via `sign` (GOOG4-HMAC-SHA256); this class
 * does no signing itself.
 */
export class GcsHttpStorage implements Storage {
  readonly #endpoint: string;
  readonly #bucket: string;
  readonly #fetch: typeof fetch;
  readonly #sign?: (req: Request) => Promise<Request>;
  readonly #retries: number;
  readonly #backoffMs: number;

  constructor(options: GcsHttpStorageOptions) {
    this.#endpoint = (options.endpoint ?? DEFAULT_GCS_ENDPOINT).replace(/\/+$/, "");
    this.#bucket = options.bucket;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#sign = options.sign;
    this.#retries = options.retries ?? S3_REQUEST_MAX_RETRIES;
    this.#backoffMs = options.backoffMs ?? 100;
  }

  #objectUrl(key: string, generation?: string): string {
    // Choke point for every key-addressing verb — reject unaddressable
    // `.`/`..`/empty keys before URL normalization turns them into a
    // bucket-root 403. @see storage-compatibility.md "Key namespace".
    assertValidStorageKey(key);
    const base = `${this.#endpoint}/${this.#bucket}/${encodeURIComponent(key)}`;
    // GCS's native equivalent of S3 ?versionId= is ?generation=. Not
    // exercised by the kernel (which never pins a historical version),
    // but threaded for parity with the Storage interface.
    return generation !== undefined ? `${base}?generation=${encodeURIComponent(generation)}` : base;
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
    // DELTA 4: no conditional read. GCS's native XML API has no
    // generation-based conditional GET. `x-goog-if-generation-{match,
    // not-match}` ARE honored against the `generation` this adapter carries
    // as the opaque etag — but only as write-style CAS preconditions that
    // 412 on failure, never as a 304-when-unchanged read. Empirically
    // confirmed on a real bucket under GOOG4 signing:
    // `if-generation-match: <stale>` → 412, and
    // `if-generation-not-match: <live-gen>` → 200 with the full body (not
    // 304); no header combination yields a conditional-read 304.
    // `opts.ifNoneMatch` is therefore intentionally ignored; the conformance
    // suite opts GCS out via `supportsConditionalGet: false`. Safe for
    // baerly: the kernel never issues a conditional read — every
    // `ifNoneMatch` it sends is `put(…, { ifNoneMatch: "*" })`
    // create-if-absent.
    return this.#retry(async () => {
      const res = await this.#dispatch(
        new Request(url, { method: "GET", signal: opts?.signal ?? null }),
      );
      switch (res.status) {
        case 200: {
          // DELTA 2: version token is x-goog-generation. No ETag fallback —
          // GCS's ETag is a quoted-MD5, not a generation; a fallback value
          // would poison the next x-goog-if-generation-match CAS. Fail loud
          // if absent (it is present on every GCS PUT/GET).
          const etag = res.headers.get("x-goog-generation");
          if (etag === null) {
            throw new BaerlyError("InvalidResponse", `GET ${key}: missing x-goog-generation`);
          }
          const body = new Uint8Array(await res.arrayBuffer());
          return { body, etag };
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
    // DELTA 1: native generation precondition, not S3 If-Match/If-None-Match.
    // ifNoneMatch:"*" => create-if-absent (:0); ifMatch => CAS (:<generation>).
    if (opts?.ifNoneMatch === "*") {
      headers.set("x-goog-if-generation-match", "0");
    } else if (opts?.ifMatch !== undefined) {
      headers.set("x-goog-if-generation-match", opts.ifMatch);
    }
    return this.#retry(async () => {
      const res = await this.#dispatch(
        new Request(url, {
          method: "PUT",
          headers,
          // TS lib.dom narrows BodyInit; the runtime accepts Uint8Array.
          body: body as BodyInit,
          signal: opts?.signal ?? null,
        }),
      );
      // DELTA 3: 412 is the ONLY precondition-failure status on GCS, for
      // BOTH create-collision and stale-CAS. No S3-style 409-contended
      // branch, no 404-with-ifMatch branch.
      if (res.status === 412) {
        throw new BaerlyError("Conflict", `PUT ${key}: precondition failed`);
      }
      if (res.status !== 200 && res.status !== 204) {
        throw await mapStorageError(res, "PUT", key);
      }
      // DELTA 2: version token is x-goog-generation, returned as etag. No
      // ETag fallback — GCS's ETag is a quoted-MD5, not a generation; a
      // fallback value would poison the next x-goog-if-generation-match CAS.
      // Fail loud if absent (it is present on every GCS PUT/GET).
      const etag = res.headers.get("x-goog-generation");
      if (etag === null) {
        throw new BaerlyError("InvalidResponse", `PUT ${key}: missing x-goog-generation`);
      }
      const dateStr = res.headers.get("Date");
      const result: { etag: string; serverDate?: Date } = { etag };
      if (dateStr !== null) {
        result.serverDate = new Date(dateStr);
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
          throw await mapStorageError(res, "LIST", prefix);
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
          // The version token is the generation, not the MD5 `<ETag>`, so the
          // list etag matches what get/put return for the same object (the
          // universal list-etag == version-token contract). GCS emits
          // `<Generation>` for every object; the `?? ""` is a defensive floor
          // for a malformed row and, like every list etag, is CAS-unused.
          key: entry.Key,
          etag: entry.Generation ?? "",
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
