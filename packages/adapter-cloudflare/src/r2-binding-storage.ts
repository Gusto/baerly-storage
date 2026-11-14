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

/**
 * Construction options for {@link r2BindingStorage}. The factory takes
 * the `R2Bucket` binding directly, so this interface only exists to
 * document the shape consumers see in their `env`.
 */
export interface R2BindingStorageOptions {
  /**
   * The R2 binding from `env`. In `wrangler.toml`:
   *
   *   [[r2_buckets]]
   *   binding = "BUCKET"
   *   bucket_name = "baerly-prod"
   *
   * Then: `r2BindingStorage(env.BUCKET)`.
   */
  bucket: R2Bucket;
}

/**
 * R2's binding API returns bare-hex ETags (`R2Object.etag`). The
 * `Storage` contract follows S3's wire format — quoted (`"<hex>"`).
 * `stripQuotes` is forgiving of unquoted input so external sources
 * that hand us bare hex don't break.
 */
const stripQuotes = (etag: string): string =>
  etag.startsWith('"') && etag.endsWith('"') ? etag.slice(1, -1) : etag;
const quoteEtag = (hex: string): string => `"${hex}"`;

/** R2 error `10058` `TooManyRequests` at the end of a binding error message. */
const R2_TOO_MANY_REQUESTS = /\(10058\)\s*$/;
/** workerd's per-invocation subrequest limit ("Too many subrequests by single Worker invocation"). */
const WORKERS_SUBREQUEST_LIMIT = /too many subrequests/i;

class R2BindingStorageImpl implements Storage {
  readonly #bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    if (bucket === null || bucket === undefined) {
      throw new BaerlyError(
        "InvalidConfig",
        "r2BindingStorage: bucket binding is null/undefined — check wrangler.toml [[r2_buckets]] and the env var name",
      );
    }
    this.#bucket = bucket;
  }

  async get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> {
    assertValidStorageKey(key);
    opts?.signal?.throwIfAborted();
    const obj = await this.#callBinding(() => this.#bucket.get(key), `GET ${key}`);
    if (obj === null) {
      return null;
    }
    const body = new Uint8Array(await obj.arrayBuffer());
    return { body, etag: quoteEtag(obj.etag) };
  }

  async put(key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult> {
    assertValidStorageKey(key);
    opts?.signal?.throwIfAborted();
    const putOpts: R2PutOptions = {};
    if (opts?.contentType !== undefined) {
      putOpts.httpMetadata = { contentType: opts.contentType };
    }
    if (opts?.ifMatch !== undefined) {
      putOpts.onlyIf = { etagMatches: stripQuotes(opts.ifMatch) };
    } else if (opts?.ifNoneMatch === "*") {
      // R2 spells "create only" as `etagDoesNotMatch: "*"` (wildcard).
      // Do NOT strip the `*` — it's the literal wildcard, not an
      // etag.
      putOpts.onlyIf = { etagDoesNotMatch: "*" };
    }
    const result = await this.#callBinding(
      () => this.#bucket.put(key, body, putOpts),
      `PUT ${key}`,
      {
        conditionalCreate: opts?.ifNoneMatch === "*",
        // An `etagMatches` CAS is never resent: a resend after a lost ack
        // would see its own write as a precondition failure.
        compareAndSwap: opts?.ifMatch !== undefined,
      },
    );
    if (result === null) {
      // Binding signals precondition failure as `null`. It resolves rather
      // than throws, so it ends the retry loop: a lost-ack resend of a
      // create that already landed surfaces here as a precondition failure,
      // which the Writer resolves by readback.
      throw new BaerlyError("WriteConflict", `PUT ${key}: precondition failed`);
    }
    // `R2Object.uploaded` is the server-side write clock — surface it
    // verbatim. The kernel's adaptive-clock-skew loop consumes it
    // identically to `S3HttpStorage`'s `Date` header.
    return {
      etag: quoteEtag(result.etag),
      serverDate: result.uploaded,
    };
  }

  async delete(key: string, opts?: { signal?: AbortSignal }): Promise<void> {
    assertValidStorageKey(key);
    opts?.signal?.throwIfAborted();
    // R2.delete is idempotent — matches the `Storage.delete` contract.
    await this.#callBinding(() => this.#bucket.delete(key), `DELETE ${key}`);
  }

  async *list(
    prefix: string,
    opts?: { startAfter?: string; maxKeys?: number; signal?: AbortSignal },
  ): AsyncIterable<StorageListEntry> {
    opts?.signal?.throwIfAborted();
    let cursor: string | undefined = undefined;
    let yielded = 0;
    const startAfter = opts?.startAfter ?? "";
    const cap = opts?.maxKeys ?? Infinity;
    while (true) {
      opts?.signal?.throwIfAborted();
      // Break BEFORE the next list() call when the cap is already hit
      // — R2 rejects `limit: 0` with `MaxKeys params must be positive
      // integer <= 1000. (10022)`, so we can't just clamp.
      if (yielded >= cap) {
        return;
      }
      // R2.list: `limit` capped at 1000 per request. Page via
      // `cursor` until `truncated === false`. `startAfter` honored
      // only on the first page (one-shot cursor).
      const listOpts: R2ListOptions = { prefix };
      if (cursor !== undefined) {
        listOpts.cursor = cursor;
      } else if (startAfter !== "") {
        listOpts.startAfter = startAfter;
      }
      if (cap !== Infinity) {
        listOpts.limit = Math.min(cap - yielded, 1000);
      }
      const page = await this.#callBinding(() => this.#bucket.list(listOpts), `LIST ${prefix}`);
      for (const obj of page.objects) {
        if (yielded >= cap) {
          return;
        }
        yield {
          key: obj.key,
          etag: quoteEtag(obj.etag),
        };
        yielded += 1;
      }
      if (!page.truncated) {
        return;
      }
      cursor = page.cursor;
      if (cursor === undefined) {
        return;
      }
    }
  }

  /**
   * Run one binding call under the shared storage retry policy
   * (`retryStorageCall`: 3 attempts, full-jitter backoff), mapping
   * binding-layer errors to `BaerlyError` codes. The R2 binding surfaces
   * failures as plain `Error` with messages; sniff the common ones. If
   * the binding ever adds typed errors, tighten the sniff and keep the
   * message fallback for older runtimes.
   *
   * `AccessDenied` and `InvalidConfig` are permanent and not retried. An
   * `ifMatch` put (`compareAndSwap`) gets one attempt and no retry at all.
   * Two `NetworkError`s have distinct retry behavior:
   *
   * - R2 error `10058` (`TooManyRequests`, 429: "limit: 1 write/second
   *   per key") is tagged `throttled`, so it is retried from the throttle
   *   backoff base. Its `mayHaveApplied` flag preserves create uncertainty:
   *   Cloudflare does not document that this error proves an unapplied write.
   *   R2 binding errors end `message` with the
   *   error code in parentheses
   *   (https://developers.cloudflare.com/r2/api/error-codes/).
   * - The Workers "Too many subrequests" limit is tagged `refused`: not
   *   retried, since every later call in the invocation is refused too,
   *   and `notApplied` on a create when no earlier attempt is uncertain.
   *   The message match is a backstop, not the primary guard.
   *
   * The Writer reads back a failed create: an own entry is adopted, a
   * foreign entry advances to the next slot, and an unknown outcome stays
   * `AmbiguousCommit` even when the slot is currently empty. A negative
   * read cannot prove that an unresolved write will never land.
   *
   * Everything else is a `NetworkError` with an unknown outcome, so an
   * exhausted conditional create does not report `notApplied`.
   */
  #callBinding<T>(
    fn: () => Promise<T>,
    op: string,
    mode: { conditionalCreate?: boolean; compareAndSwap?: boolean } = {},
  ): Promise<T> {
    return retryStorageCall(
      async () => {
        try {
          return await fn();
        } catch (error) {
          if (error instanceof BaerlyError) {
            throw error;
          }
          const msg = error instanceof Error ? error.message : String(error);
          if (R2_TOO_MANY_REQUESTS.test(msg)) {
            throw new BaerlyError("NetworkError", `${op}: ${msg}`, {
              cause: { status: 429, throttled: true, mayHaveApplied: true, error },
            });
          }
          if (WORKERS_SUBREQUEST_LIMIT.test(msg)) {
            throw new BaerlyError("NetworkError", `${op}: ${msg}`, {
              cause: { refused: true, error },
            });
          }
          if (/auth|permission|forbidden/i.test(msg)) {
            throw new BaerlyError("AccessDenied", `${op}: ${msg}`, { cause: error });
          }
          if (/not.*found|no.*such.*bucket/i.test(msg)) {
            throw new BaerlyError("InvalidConfig", `${op}: ${msg}`, { cause: error });
          }
          throw new BaerlyError("NetworkError", `${op}: ${msg}`, { cause: error });
        }
      },
      // Binding calls are subrequests to an internal service: charged to
      // the request ledger's `internal` pool only.
      { ...mode, pool: "internal" },
    );
  }
}

/**
 * Construct a `Storage` backed by a Cloudflare R2 binding. The R2
 * binding bypasses SigV4 entirely: requests are dispatched in-cell
 * over a Cloudflare-internal channel, so the hot path skips
 * canonical-request building, body hashing, and DNS/TLS to a
 * separate origin.
 *
 * Pick this over `S3HttpStorage` when the Worker and bucket are in
 * the same Cloudflare account. Cross-cloud (AWS, GCS) and
 * cross-account R2 stay on the HTTP path.
 *
 * Wire-format conventions:
 *  - ETags returned in `"<hex>"` (S3 wire format) even though R2's
 *    binding returns bare hex. CAS round-trips strip and re-apply
 *    the quotes.
 *  - `serverDate` from `R2Object.uploaded` — a real server clock,
 *    suitable for the kernel's adaptive-clock-skew loop. `list()`
 *    yields `key` + `etag` only; `StorageListEntry` carries no
 *    per-entry timestamp.
 *
 * Errors map to `BaerlyError` via the same convention as
 * `S3HttpStorage`: `AccessDenied` for binding-level permission
 * failures, `NetworkError` for transient R2 platform failures,
 * `InvalidResponse` for precondition (CAS) failures, `InvalidConfig`
 * if the caller hands in a null/undefined binding. A failing binding
 * call is retried under the same policy as `S3HttpStorage`: at most 3
 * calls per `get` / `put` / `delete` and per `list` page.
 *
 * @example
 * ```ts
 * import { r2BindingStorage } from "@gusto/baerly-storage/cloudflare";
 *
 * export default {
 *   fetch(req, env: { BUCKET: R2Bucket }) {
 *     const storage = r2BindingStorage(env.BUCKET);
 *     // ...wire to Db
 *   },
 * };
 * ```
 */
export function r2BindingStorage(bucket: R2Bucket): Storage {
  return new R2BindingStorageImpl(bucket);
}

/**
 * Whether `storage` is the R2 binding itself (from {@link r2BindingStorage}).
 * R2 binding calls do not count toward Workers Free's 50 external
 * subrequests; anything else a Worker is given (`S3HttpStorage`, or a
 * wrapper around either) is assumed to reach the bucket through `fetch`,
 * where every call does.
 */
export const isR2BindingStorage = (storage: Storage): boolean =>
  storage instanceof R2BindingStorageImpl;
