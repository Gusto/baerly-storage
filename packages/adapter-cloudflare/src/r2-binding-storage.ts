import { BaerlyError } from "@baerly/protocol";
import type {
  Storage,
  StorageGetOptions,
  StorageGetResult,
  StorageListEntry,
  StoragePutOptions,
  StoragePutResult,
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
    opts?.signal?.throwIfAborted();
    const getOpts: R2GetOptions = {};
    if (opts?.ifNoneMatch !== undefined) {
      getOpts.onlyIf = { etagDoesNotMatch: stripQuotes(opts.ifNoneMatch) };
    }
    const obj = await this.#callBinding(() => this.#bucket.get(key, getOpts), `GET ${key}`);
    if (obj === null) return null;
    // R2 returns a bare `R2Object` (no body) when a conditional GET's
    // precondition succeeds — i.e. the caller's copy is current.
    // Match the `Storage` contract's 304 → null semantics.
    if (!("body" in obj) || obj.body === null) return null;
    const body = new Uint8Array(await obj.arrayBuffer());
    return { body, etag: quoteEtag(obj.etag) };
  }

  async put(key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult> {
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
    );
    if (result === null) {
      // Binding signals precondition failure as `null`. Match
      // `S3HttpStorage`'s 412 → InvalidResponse mapping.
      throw new BaerlyError("InvalidResponse", `PreconditionFailed: PUT ${key}`);
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
      if (yielded >= cap) return;
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
        if (yielded >= cap) return;
        yield {
          key: obj.key,
          etag: quoteEtag(obj.etag),
          lastModified: obj.uploaded,
        };
        yielded += 1;
      }
      if (!page.truncated) return;
      cursor = page.cursor;
      if (cursor === undefined) return;
    }
  }

  /**
   * Map binding-layer errors to `BaerlyError` codes. The R2 binding
   * surfaces failures as plain `Error` with messages; sniff the
   * common ones. If the binding ever adds typed errors, tighten the
   * sniff and keep the message fallback for older runtimes.
   */
  async #callBinding<T>(fn: () => Promise<T>, op: string): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof BaerlyError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (/auth|permission|forbidden/i.test(msg)) {
        throw new BaerlyError("AccessDenied", `${op}: ${msg}`, e);
      }
      if (/not.*found|no.*such.*bucket/i.test(msg)) {
        throw new BaerlyError("InvalidConfig", `${op}: ${msg}`, e);
      }
      throw new BaerlyError("NetworkError", `${op}: ${msg}`, e);
    }
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
 *    suitable for the kernel's adaptive-clock-skew loop.
 *  - `StorageListEntry.lastModified` from the same clock.
 *
 * Errors map to `BaerlyError` via the same convention as
 * `S3HttpStorage`: `AccessDenied` for binding-level permission
 * failures, `NetworkError` for transient R2 platform failures,
 * `InvalidResponse` for precondition (CAS) failures, `InvalidConfig`
 * if the caller hands in a null/undefined binding.
 *
 * @example
 * ```ts
 * import { r2BindingStorage } from "@baerly/adapter-cloudflare";
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
