import {
  LIST_OBJECT_MAX_RETRIES,
  RATE_LIMIT_BACKOFF_MILLIS,
  S3_REQUEST_MAX_RETRIES,
} from "../constants";
import { BaerlyError } from "../errors";
import { delay } from "../time";
import type { XmlParser } from "../types";
import { parseListObjectsV2CommandOutput } from "../xml";
import type {
  Storage,
  StorageGetOptions,
  StorageGetResult,
  StorageListEntry,
  StoragePutOptions,
  StoragePutResult,
} from "./types";

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

const retry = async <T>(
  fn: () => Promise<T>,
  { retries = S3_REQUEST_MAX_RETRIES, backoffMs = 100, maxDelayMs = 10_000 } = {},
): Promise<T> => {
  let wait = backoffMs;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof BaerlyError && PERMANENT_ERROR_CODES.has(e.code)) throw e;
      if (attempt === retries) throw e;
      await delay(wait);
      wait = Math.min(wait * 1.5, maxDelayMs);
    }
  }
  throw new BaerlyError("Internal", "s3-http retry loop exited without returning or throwing");
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
  /**
   * XML parser for `ListObjectsV2` responses. `list()` requires one;
   * `get`/`put`/`delete` work without. If unset and `globalThis.DOMParser`
   * exists (browser/Worker), defaults to that.
   */
  xmlParser?: XmlParser;
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
  readonly #xmlParser?: XmlParser;
  readonly #retries: number;
  readonly #backoffMs: number;

  constructor(options: S3HttpStorageOptions) {
    this.#endpoint = options.endpoint.replace(/\/+$/, "");
    this.#bucket = options.bucket;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#sign = options.sign;
    this.#xmlParser = options.xmlParser ?? defaultXmlParser();
    this.#retries = options.retries ?? S3_REQUEST_MAX_RETRIES;
    this.#backoffMs = options.backoffMs ?? 100;
  }

  #objectUrl(key: string, versionId?: string): string {
    const base = `${this.#endpoint}/${this.#bucket}/${encodeURIComponent(key)}`;
    return versionId !== undefined ? `${base}?versionId=${encodeURIComponent(versionId)}` : base;
  }

  async #dispatch(req: Request): Promise<Response> {
    const signed = this.#sign ? await this.#sign(req) : req;
    return this.#fetch(signed);
  }

  #retry<T>(fn: () => Promise<T>): Promise<T> {
    return retry(fn, { retries: this.#retries, backoffMs: this.#backoffMs });
  }

  async get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> {
    opts?.signal?.throwIfAborted();
    const url = this.#objectUrl(key, opts?.versionId);
    const headers = new Headers();
    if (opts?.ifNoneMatch !== undefined) headers.set("If-None-Match", opts.ifNoneMatch);
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
        case 404:
          return null;
        case 403:
          throw new BaerlyError("AccessDenied", `GET ${key}: 403`);
        default:
          if (res.status >= 500) {
            throw new BaerlyError("NetworkError", `GET ${key}: ${res.status} ${await res.text()}`);
          }
          throw new BaerlyError("InvalidResponse", `GET ${key}: ${res.status} ${await res.text()}`);
      }
    });
  }

  async put(key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult> {
    opts?.signal?.throwIfAborted();
    const url = this.#objectUrl(key);
    const headers = new Headers();
    headers.set("Content-Type", opts?.contentType ?? "application/octet-stream");
    if (opts?.ifMatch !== undefined) headers.set("If-Match", opts.ifMatch);
    if (opts?.ifNoneMatch === "*") headers.set("If-None-Match", "*");
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
      if (res.status >= 500) {
        throw new BaerlyError("NetworkError", `PUT ${key}: ${res.status} ${await res.text()}`);
      }
      if (res.status !== 200 && res.status !== 204) {
        throw new BaerlyError("InvalidResponse", `PUT ${key}: ${res.status} ${await res.text()}`);
      }
      const etag = res.headers.get("ETag");
      if (etag === null) {
        throw new BaerlyError("InvalidResponse", `PUT ${key}: missing ETag`);
      }
      const dateStr = res.headers.get("Date");
      const versionId = res.headers.get("x-amz-version-id") ?? undefined;
      const result: { etag: string; serverDate?: Date; versionId?: string } = { etag };
      if (dateStr !== null) result.serverDate = new Date(dateStr);
      if (versionId !== undefined) result.versionId = versionId;
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
      if (res.status >= 500) {
        throw new BaerlyError("NetworkError", `DELETE ${key}: ${res.status} ${await res.text()}`);
      }
      // 200 / 204 / 404 → success (idempotent).
    });
  }

  async *list(
    prefix: string,
    opts?: { startAfter?: string; maxKeys?: number; signal?: AbortSignal },
  ): AsyncIterable<StorageListEntry> {
    opts?.signal?.throwIfAborted();
    const xmlParser = this.#xmlParser;
    if (!xmlParser) {
      throw new BaerlyError(
        "InvalidConfig",
        "S3HttpStorage.list requires an XML parser; pass `xmlParser` in options or provide globalThis.DOMParser",
      );
    }
    let yielded = 0;
    let continuationToken: string | undefined;
    const startAfter = opts?.startAfter ?? "";
    while (true) {
      opts?.signal?.throwIfAborted();
      const params = new URLSearchParams();
      params.set("list-type", "2");
      params.set("prefix", prefix);
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
      for (let attempt = 0; attempt < LIST_OBJECT_MAX_RETRIES; attempt++) {
        const outcome = await this.#retry(async () => {
          const res = await this.#dispatch(
            new Request(url, { method: "GET", signal: opts?.signal ?? null }),
          );
          if (res.status === 200) return { kind: "ok" as const, body: await res.text() };
          if (res.status === 429) return { kind: "ratelimited" as const };
          if (res.status === 403) {
            throw new BaerlyError("AccessDenied", `LIST ${prefix}: 403`);
          }
          if (res.status >= 500) {
            throw new BaerlyError(
              "NetworkError",
              `LIST ${prefix}: ${res.status} ${await res.text()}`,
            );
          }
          throw new BaerlyError(
            "InvalidResponse",
            `LIST ${prefix}: ${res.status} ${await res.text()}`,
          );
        });
        if (outcome.kind === "ok") {
          parsed = parseListObjectsV2CommandOutput(outcome.body, xmlParser);
          break;
        }
        await delay(RATE_LIMIT_BACKOFF_MILLIS);
      }
      if (parsed === undefined) {
        throw new BaerlyError("NetworkError", `LIST ${prefix}: rate-limited`);
      }

      for (const entry of parsed.Contents ?? []) {
        if (entry.Key === undefined) continue;
        yield {
          key: entry.Key,
          etag: entry.ETag ?? "",
          ...(entry.LastModified !== undefined && { lastModified: entry.LastModified }),
        };
        yielded += 1;
        if (opts?.maxKeys !== undefined && yielded >= opts.maxKeys) return;
      }
      continuationToken = parsed.NextContinuationToken;
      if (continuationToken === undefined || continuationToken === "") return;
    }
  }
}

const defaultXmlParser = (): XmlParser | undefined => {
  const globalParser = (globalThis as { DOMParser?: new () => XmlParser }).DOMParser;
  return globalParser !== undefined ? new globalParser() : undefined;
};
