import { isDeployedEnv } from "../env.ts";
import { BaerlyError } from "../errors.ts";
import type {
  Storage,
  StorageGetOptions,
  StorageGetResult,
  StorageListEntry,
  StoragePutOptions,
  StoragePutResult,
} from "./types.ts";

interface StoredObject {
  body: Uint8Array;
  etag: string;
  contentType?: string;
}

const utf8Encoder = new TextEncoder();

const EPHEMERAL_ENV_OPT_IN = "BAERLY_ALLOW_EPHEMERAL_STORAGE";

// Read process env without a `node:` import so protocol stays Workerd-
// loadable (on Workerd `process` is absent → env is `{}` → not deployed).
const readProcessEnv = (): Record<string, string | undefined> =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

let warnedEphemeralInDeployment = false;

// Fail closed when in-memory storage would silently back a deployed
// workload (writes "succeed" into RAM, vanish on restart). No-op in
// dev/test; bypass in a deployment only via an explicit acknowledgement.
const assertEphemeralAllowed = (explicitOptIn: boolean): void => {
  const env = readProcessEnv();
  if (!isDeployedEnv(env)) {
    return;
  }
  if (!explicitOptIn && env[EPHEMERAL_ENV_OPT_IN] !== "true") {
    throw new BaerlyError(
      "InvalidConfig",
      "Refusing to use in-memory storage in a deployed environment — all data is lost on restart. " +
        "MemoryStorage is for tests/local dev only; configure a durable bucket (AWS S3 / Cloudflare R2). " +
        `To intentionally opt in: new MemoryStorage({ ephemeral: true }) or ${EPHEMERAL_ENV_OPT_IN}=true.`,
    );
  }
  if (!warnedEphemeralInDeployment) {
    warnedEphemeralInDeployment = true;
    console.warn(
      "[baerly] in-memory storage in a deployed environment — ALL DATA IS LOST ON RESTART.",
    );
  }
};

/** Options for {@link MemoryStorage}. */
export interface MemoryStorageOptions {
  /**
   * Acknowledge the store is intentionally ephemeral — required to
   * construct in a detected deployment ({@link isDeployedEnv}); ignored in
   * dev/test. Env equivalent: `BAERLY_ALLOW_EPHEMERAL_STORAGE=true`.
   */
  ephemeral?: boolean;
}

/**
 * Compare two keys by their UTF-8 byte sequences — the order S3 and
 * R2 use for `list`. JavaScript's default string sort compares UTF-16
 * code units, which diverges from UTF-8 byte order for supplementary-
 * plane characters (e.g. emoji sort before high-BMP characters under
 * UTF-16 but after them in UTF-8). Using this keeps the in-memory
 * reference backend faithful to the real adapters. (All kernel keys
 * are ASCII base-32, where the two orders coincide — this only
 * matters for adversarial / non-ASCII keys.)
 */
const compareKeysUtf8 = (a: string, b: string): number => {
  const ba = utf8Encoder.encode(a);
  const bb = utf8Encoder.encode(b);
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (ba[i] !== bb[i]) {
      return ba[i]! - bb[i]!;
    }
  }
  return ba.length - bb.length;
};

/**
 * In-memory `Storage`. The randomized property test runs against
 * this; it must be deterministic — no clocks beyond the caller's,
 * no randomness, no I/O.
 *
 * ETags are a monotonically increasing hex counter formatted in the
 * `"<hex>"` shape S3 returns (the surrounding double-quotes are part
 * of the ETag header value). Keys are stored verbatim.
 *
 * **Test-confidence caveat:** every method resolves on the microtask
 * queue with no real concurrency, so `put` reads `existing` and writes
 * back with no interleaving. MemoryStorage therefore CANNOT exercise the
 * compare-and-swap race the writer-fence model depends on — two writers
 * contending on one `current.json` always serialize here, so a green run
 * is necessary but not sufficient. That race is covered only by the
 * randomized integration tests against real S3 / Minio
 * (`tests/integration/randomized.test.ts`, `node-minio` variant).
 * Relatedly, `serverDate` returns the local clock, not an independent
 * server clock (see the `put` return below).
 */
export class MemoryStorage implements Storage {
  readonly #objects = new Map<string, StoredObject>();
  #etagCounter = 0;

  constructor(opts?: MemoryStorageOptions) {
    assertEphemeralAllowed(opts?.ephemeral === true);
  }

  #nextEtag(): string {
    this.#etagCounter += 1;
    return `"${this.#etagCounter.toString(16)}"`;
  }

  async get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> {
    opts?.signal?.throwIfAborted();
    const stored = this.#objects.get(key);
    if (stored === undefined) {
      return null;
    }
    if (opts?.ifNoneMatch !== undefined && opts.ifNoneMatch === stored.etag) {
      // 304 Not Modified — caller's cached copy is current.
      return null;
    }
    return { body: stored.body, etag: stored.etag };
  }

  async put(key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult> {
    opts?.signal?.throwIfAborted();
    const existing = this.#objects.get(key);

    if (opts?.ifNoneMatch === "*" && existing !== undefined) {
      throw new BaerlyError(
        "Conflict",
        `PUT ${key}: precondition failed (ifNoneMatch="*" but key exists)`,
      );
    }
    if (opts?.ifMatch !== undefined) {
      if (existing === undefined) {
        throw new BaerlyError(
          "Conflict",
          `PUT ${key}: precondition failed (ifMatch=${opts.ifMatch} but key does not exist)`,
        );
      }
      if (existing.etag !== opts.ifMatch) {
        throw new BaerlyError(
          "Conflict",
          `PUT ${key}: precondition failed (ifMatch=${opts.ifMatch} but current ETag is ${existing.etag})`,
        );
      }
    }

    const etag = this.#nextEtag();
    this.#objects.set(key, {
      body,
      etag,
      // Stryker disable next-line ObjectLiteral,ConditionalExpression: contentType is stored in the internal StoredObject but never returned by get() — the Storage interface has no contentType on StorageGetResult, so any mutation of this spread is observable-equivalent
      ...(opts?.contentType !== undefined && { contentType: opts.contentType }),
    });
    // `serverDate` is intentionally returned — the kernel's adaptive
    // clock-skew loop consumes the write-time server clock. `list()`
    // deliberately omits `lastModified`: the in-memory impl has no
    // independent server clock, and its only consumer (GC's `due_at`
    // anchor) falls back to `now()` when it is absent, so omitting it
    // changes nothing.
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
      .filter((k) => k.startsWith(prefix) && compareKeysUtf8(k, startAfter) > 0)
      .toSorted(compareKeysUtf8);
    let yielded = 0;
    for (const key of sorted) {
      if (yielded >= maxKeys) {
        return;
      }
      opts?.signal?.throwIfAborted();
      const stored = this.#objects.get(key);
      // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable guard — keys come from Map.keys() so the corresponding value is always present; this branch exists only to satisfy noUncheckedIndexedAccess
      if (stored === undefined) {
        continue;
      }
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
}

// Process-singleton MemoryStorage map keyed by bucket. Tests that need
// multiple `Db` / `Writer` instances to see each other's writes
// against an in-memory backend reach for this via
// {@link getOrCreateMemoryStorageForBucket}; {@link resetMemoryStorage}
// drops every bucket between test cases.
const sharedPerBucket = new Map<string, MemoryStorage>();

/**
 * Test isolation: drop every bucket's contents from the shared
 * memory storage used by {@link getOrCreateMemoryStorageForBucket}.
 * Direct `MemoryStorage` instances built via `new MemoryStorage()`
 * are unaffected — those are isolated by construction.
 */
export const resetMemoryStorage = (): void => {
  sharedPerBucket.clear();
};

/**
 * Get the process-singleton {@link MemoryStorage} for the named
 * bucket, creating one on first access. Use this when constructing
 * a `Storage` directly so multiple consumers in the same process
 * see each other's writes for the same bucket name.
 */
export const getOrCreateMemoryStorageForBucket = (bucket: string): MemoryStorage => {
  let s = sharedPerBucket.get(bucket);
  if (s === undefined) {
    s = new MemoryStorage();
    sharedPerBucket.set(bucket, s);
  }
  return s;
};
