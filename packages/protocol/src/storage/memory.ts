import { MPS3Error } from "../errors";
import type {
  Storage,
  StorageGetOptions,
  StorageGetResult,
  StorageListEntry,
  StoragePutOptions,
  StoragePutResult,
} from "./types";

interface StoredObject {
  body: Uint8Array;
  etag: string;
  contentType?: string;
}

/**
 * In-memory `Storage`. The randomized property test runs against
 * this; it must be deterministic — no clocks beyond the caller's,
 * no randomness, no I/O.
 *
 * ETags are a monotonically increasing hex counter formatted in the
 * `"<hex>"` shape S3 returns (the surrounding double-quotes are part
 * of the ETag header value). Keys are stored verbatim — callers that
 * URL-encode their keys (e.g. the legacy fetch adapter) get
 * URL-encoded keys back.
 */
export class MemoryStorage implements Storage {
  readonly #objects = new Map<string, StoredObject>();
  #etagCounter = 0;

  #nextEtag(): string {
    this.#etagCounter += 1;
    return `"${this.#etagCounter.toString(16)}"`;
  }

  async get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> {
    opts?.signal?.throwIfAborted();
    const stored = this.#objects.get(key);
    if (stored === undefined) return null;
    if (opts?.ifNoneMatch !== undefined && opts.ifNoneMatch === stored.etag) {
      // 304 Not Modified — caller's cached copy is current.
      return null;
    }
    return { body: stored.body, etag: stored.etag };
  }

  async put(
    key: string,
    body: Uint8Array,
    opts?: StoragePutOptions,
  ): Promise<StoragePutResult> {
    opts?.signal?.throwIfAborted();
    const existing = this.#objects.get(key);

    if (opts?.ifNoneMatch === "*" && existing !== undefined) {
      throw new MPS3Error(
        "InvalidResponse",
        `PreconditionFailed: ifNoneMatch="*" but key ${key} already exists`,
      );
    }
    if (opts?.ifMatch !== undefined) {
      if (existing === undefined) {
        throw new MPS3Error(
          "InvalidResponse",
          `PreconditionFailed: ifMatch=${opts.ifMatch} but key ${key} does not exist`,
        );
      }
      if (existing.etag !== opts.ifMatch) {
        throw new MPS3Error(
          "InvalidResponse",
          `PreconditionFailed: ifMatch=${opts.ifMatch} but current ETag is ${existing.etag}`,
        );
      }
    }

    const etag = this.#nextEtag();
    this.#objects.set(key, {
      body,
      etag,
      ...(opts?.contentType !== undefined && { contentType: opts.contentType }),
    });
    // `serverDate` is intentionally returned (callers like the kernel's
    // adaptive-clock loop need a value); `lastModified` is intentionally
    // *not* surfaced on `list()` — the in-memory impl has no
    // independent server clock, and pretending it does would force the
    // kernel's wall-clock cross-check against an artificially injected
    // `clockOffset`, breaking the property-based randomized tests.
    return { etag, serverDate: new Date() };
  }

  async delete(key: string, opts?: { signal?: AbortSignal }): Promise<void> {
    opts?.signal?.throwIfAborted();
    this.#objects.delete(key);
  }

  async *list(
    prefix: string,
    opts?: { startAfter?: string; maxKeys?: number; signal?: AbortSignal },
  ): AsyncIterable<StorageListEntry> {
    opts?.signal?.throwIfAborted();
    const startAfter = opts?.startAfter ?? "";
    const maxKeys = opts?.maxKeys ?? Infinity;
    const sorted = [...this.#objects.keys()]
      .filter((k) => k.startsWith(prefix) && k > startAfter)
      .sort();
    let yielded = 0;
    for (const key of sorted) {
      if (yielded >= maxKeys) return;
      opts?.signal?.throwIfAborted();
      const stored = this.#objects.get(key);
      if (stored === undefined) continue; // unreachable; satisfies noUncheckedIndexedAccess
      yield { key, etag: stored.etag };
      yielded += 1;
    }
  }

  /**
   * Test-only: drop all objects.
   * @internal
   */
  _clear(): void {
    this.#objects.clear();
    this.#etagCounter = 0;
  }

  /**
   * Test-only escape hatch: read the stored content-type for a key.
   * The legacy fetch adapter needs this to round-trip Content-Type
   * headers; the protocol kernel does not use it.
   * @internal
   */
  contentTypeOf(key: string): string | undefined {
    return this.#objects.get(key)?.contentType;
  }
}

const headerOf = (init: RequestInit | undefined, name: string): string | undefined => {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    const lower = name.toLowerCase();
    for (const [k, v] of headers) if (k.toLowerCase() === lower) return v;
    return undefined;
  }
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers as Record<string, string>)) {
    if (k.toLowerCase() === lower) return (headers as Record<string, string>)[k];
  }
  return undefined;
};

const bodyToBytes = async (body: BodyInit | null | undefined): Promise<Uint8Array> => {
  if (body === null || body === undefined) return new Uint8Array(0);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (typeof body === "string") return new TextEncoder().encode(body);
  // Blob, FormData, ReadableStream, URLSearchParams — fall back to Response.
  return new Uint8Array(await new Response(body).arrayBuffer());
};

const dispatch = async (
  storage: Storage,
  url: URL,
  init: RequestInit | undefined,
): Promise<Response> => {
  const params = new URLSearchParams(url.search);
  const segments = url.pathname.split("/");
  const key = segments.slice(2).join("/");

  if (params.get("list-type")) {
    // Match legacy semantics: prefix and start-after are taken as
    // already URL-encoded (the existing keys in storage are stored
    // URL-encoded by `S3ClientLite.getUrl`).
    const prefix = encodeURIComponent(params.get("prefix") || "");
    const startAfter = encodeURIComponent(params.get("start-after") || "");
    const entries: StorageListEntry[] = [];
    for await (const entry of storage.list(prefix, { startAfter })) {
      entries.push(entry);
    }
    const xml = `<ListBucketResult>${entries
      .map((e) => `<Contents><Key>${e.key}</Key></Contents>`)
      .join("")}</ListBucketResult>`;
    return new Response(xml, {
      status: 200,
      headers: { "content-type": "application/xml" },
    });
  }

  const method = init?.method ?? "GET";
  if (method === "GET") {
    const result = await storage.get(key);
    if (result === null) return new Response(null, { status: 404 });
    const headers: Record<string, string> = { etag: result.etag };
    const ct =
      storage instanceof MemoryStorage ? storage.contentTypeOf(key) : undefined;
    if (ct !== undefined) headers["content-type"] = ct;
    // TS 7's lib.dom narrows `BodyInit` to ArrayBuffer-backed views —
    // a generic `Uint8Array<ArrayBufferLike>` (which the protocol uses
    // because it permits SharedArrayBuffer) is not assignable. Decode
    // to a string for the Response; downstream `s3-client-lite` calls
    // `response.text()`/`.json()` anyway, so the round-trip is lossless
    // for the JSON payloads MPS3 stores.
    return new Response(new TextDecoder().decode(result.body), {
      status: 200,
      headers,
    });
  }
  if (method === "PUT") {
    const bytes = await bodyToBytes(init?.body);
    const ct = headerOf(init, "Content-Type");
    const { etag } = await storage.put(
      key,
      bytes,
      ct !== undefined ? { contentType: ct } : undefined,
    );
    return new Response(null, { status: 200, headers: { etag } });
  }
  if (method === "DELETE") {
    await storage.delete(key);
    return new Response(null, { status: 204 });
  }
  throw new MPS3Error("Internal", `Unsupported method: ${method}`);
};

/**
 * Adapter: serve a `Storage` as a `fetch`-compatible function for
 * legacy callers that inject `fetchFn` into `MPS3Config`. Parses
 * S3-style URLs (e.g. `memory:/bucket/key`) and dispatches to the
 * `Storage` methods. The returned `Response` mirrors S3's wire
 * format closely enough for `src/s3-client-lite.ts` to consume.
 *
 * This is a transitional shim: when `MPS3` accepts a `Storage`
 * directly (00-plan.md Phase 2), the adapter goes away.
 *
 * Two modes:
 *  - `fetchFnFromStorage(storage)` — single backing storage; bucket
 *    is parsed from the URL but not used to namespace (the storage
 *    itself is the namespace).
 *  - `fetchFnFromStorage()` — partitions by bucket, lazily creating
 *    a fresh `MemoryStorage` per bucket. Matches the legacy
 *    `memory-fetch.ts` semantics.
 */
export function fetchFnFromStorage(storage: Storage): typeof fetch;
export function fetchFnFromStorage(): typeof fetch;
export function fetchFnFromStorage(storage?: Storage): typeof fetch {
  const perBucket = storage === undefined ? new Map<string, MemoryStorage>() : null;
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const segments = url.pathname.split("/");
    const bucket = segments[1];
    if (!bucket) {
      throw new MPS3Error("InvalidConfig", `Invalid bucket in URL: ${url.toString()}`);
    }
    let s: Storage;
    if (storage !== undefined) {
      s = storage;
    } else {
      let existing = perBucket!.get(bucket);
      if (existing === undefined) {
        existing = new MemoryStorage();
        perBucket!.set(bucket, existing);
      }
      s = existing;
    }
    return dispatch(s, url, init);
  }) as typeof fetch;
}

// Process-singleton fetchFn for the `memory:` endpoint. `MPS3` uses
// this when the caller picks `MEMORY_ENDPOINT` and provides no
// explicit `Storage`. Tests share the singleton across instances the
// same way the legacy `memory-fetch` module did.
const sharedPerBucket = new Map<string, MemoryStorage>();

/**
 * Process-singleton `fetch`-compatible function backed by an
 * in-memory `Storage`, partitioned per bucket. This is what `MPS3`
 * uses when the caller picks `MEMORY_ENDPOINT`, mirroring the legacy
 * `memory-fetch.ts` behavior.
 *
 * Use {@link resetMemoryStorage} between tests for isolation.
 */
export const memoryFetchFn: typeof fetch = (async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : input.toString());
  const segments = url.pathname.split("/");
  const bucket = segments[1];
  if (!bucket) {
    throw new MPS3Error("InvalidConfig", `Invalid bucket in URL: ${url.toString()}`);
  }
  let s = sharedPerBucket.get(bucket);
  if (s === undefined) {
    s = new MemoryStorage();
    sharedPerBucket.set(bucket, s);
  }
  return dispatch(s, url, init);
}) as typeof fetch;

/**
 * Test isolation: drop every bucket's contents from the shared
 * memory storage used by {@link memoryFetchFn}. Direct
 * `MemoryStorage` instances built via `new MemoryStorage()` are
 * unaffected — those are isolated by construction.
 */
export const resetMemoryStorage = (): void => {
  sharedPerBucket.clear();
};

/**
 * Test-only escape hatch: read the {@link MemoryStorage} backing
 * the named bucket in the {@link memoryFetchFn} singleton. Returns
 * `undefined` if no PUT has touched that bucket yet. Lets tests
 * `list(prefix)` directly instead of round-tripping through
 * URL-encoded fetch adapters.
 * @internal
 */
export const getMemoryStorageForBucket = (
  bucket: string,
): MemoryStorage | undefined => sharedPerBucket.get(bucket);

/**
 * Get the process-singleton {@link MemoryStorage} for the named
 * bucket, creating one on first access. Mirrors the lazy
 * per-bucket creation that {@link memoryFetchFn} does internally —
 * use this when constructing a `Storage` directly (the
 * `MEMORY_ENDPOINT` path on `MPS3`) so multiple `MPS3` instances
 * in the same process see each other's writes for the same
 * bucket name.
 */
export const getOrCreateMemoryStorageForBucket = (
  bucket: string,
): MemoryStorage => {
  let s = sharedPerBucket.get(bucket);
  if (s === undefined) {
    s = new MemoryStorage();
    sharedPerBucket.set(bucket, s);
  }
  return s;
};
