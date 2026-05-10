import { AwsClient } from "aws4fetch";
import {
  type DeleteValue,
  type JSONValue,
  type Ref,
  type ResolvedRef,
  type S3VersionId,
  type Storage,
  type VersionId,
  type XmlParser,
  type b64,
  MEM_CACHE_CAPACITY,
  MPS3Error,
  OMap,
  S3HttpStorage,
  getOrCreateMemoryStorageForBucket,
  measure,
  resolveContentRef,
  resolveManifestRef,
  url,
  versionFromContent,
} from "@baerly/protocol";
import { Manifest } from "./manifest";
import { type UseStore, createStore, get, set } from "idb-keyval";
import { OfflineStorage } from "./offline-storage";

/**
 * Public S3-credential shape consumers pass via {@link MPS3Config.s3Config}.
 * Mirrors the AWS SDK's `S3ClientConfig` field-for-field so existing
 * callers don't have to change. The kernel itself never stores the
 * credentials past constructor time — the {@link S3HttpStorage} `sign`
 * callback closes over them.
 */
export interface S3ClientConfig {
  endpoint?: string;
  region?: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}

/**
 * Internal command shape used by `MPS3.getObject` for cache keys and
 * argument unification. PascalCase field names mirror the S3 wire
 * vocabulary; not part of the public API.
 */
interface GetObjectCommandInput {
  Bucket?: string;
  Key?: string;
  VersionId?: S3VersionId;
  IfNoneMatch?: string;
}

interface CommandMetadata {
  httpStatusCode?: number;
}

interface GetObjectCommandOutput {
  $metadata: CommandMetadata;
  Body?: unknown;
  ETag?: string;
  VersionId?: S3VersionId;
}

interface PutObjectCommandInput {
  Bucket?: string;
  Key?: string;
  Body?: string;
  ContentType?: string;
}

interface PutObjectCommandOutput {
  $metadata: CommandMetadata;
  ETag?: string;
  VersionId?: S3VersionId;
}

interface DeleteObjectCommandOutput {
  $metadata: CommandMetadata;
}

/**
 * Bounded LRU keyed by a string derived from `K`. Mirrors the subset of
 * `OMap` used by `MPS3.memCache` (`has`/`get`/`set`) but evicts the
 * oldest entry when capacity is reached. On `get`, the entry is
 * re-inserted to mark it most-recently-used; insertion order in
 * `Map` *is* recency order.
 *
 * Capacity comes from `MEM_CACHE_CAPACITY` in `packages/protocol/src/constants.ts`.
 */
/**
 * Canonical cache key for the in-memory and IDB-backed `getObject`
 * caches. Both layers must agree byte-for-byte or a disk hit can
 * silently overwrite a fresh memCache entry under a different key.
 */
const cacheKey = (i: GetObjectCommandInput): string =>
  JSON.stringify([i.Bucket, i.Key, i.VersionId, i.IfNoneMatch]);

/**
 * Decode a `Uint8Array` body to JSON for the `MPS3.getObject`
 * wrapper. The `Storage` seam returns bytes and the kernel parses
 * here (the JSON-vs-binary decision is the caller's, not storage's).
 * Empty bodies return `undefined`. Parse failures throw
 * `MPS3Error("InvalidResponse")` so callers see a clean error
 * instead of a silent `undefined`.
 */
const parseJsonBody = <T>(body: Uint8Array, bucket: string, key: string): T | undefined => {
  if (body.byteLength === 0) return undefined;
  const text = new TextDecoder().decode(body);
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new MPS3Error("InvalidResponse", `Failed to parse JSON for ${bucket}/${key}`, e);
  }
};

class BoundedLRU<K, V> {
  readonly #vals = new Map<string, V>();

  constructor(
    private readonly key: (k: K) => string,
    private readonly capacity: number,
  ) {}

  has(k: K): boolean {
    return this.#vals.has(this.key(k));
  }

  get(k: K): V | undefined {
    const id = this.key(k);
    const v = this.#vals.get(id);
    if (v !== undefined && this.#vals.delete(id)) {
      this.#vals.set(id, v);
    }
    return v;
  }

  set(k: K, v: V): this {
    const id = this.key(k);
    if (this.#vals.delete(id) === false && this.#vals.size >= this.capacity) {
      const oldest = this.#vals.keys().next().value;
      if (oldest !== undefined) this.#vals.delete(oldest);
    }
    this.#vals.set(id, v);
    return this;
  }
}
export interface MPS3Config {
  /** @internal */
  label?: string;
  /**
   * Bucket to use by default
   */
  defaultBucket: string;
  /**
   * Default manifest to use if one is not specified in an
   * operation's options
   * @defaultValue { bucket: defaultBucket, key: "manifest.json" }
   */
  defaultManifest?: string | Ref;
  /**
   * Feature toggle to use versioning on content objects. If not
   * using versioning content keys are appended with `@<version>`.
   * Host bucket must have versioning enabled for this to work.
   * @defaultValue false
   */
  useVersioning?: boolean;

  /**
   * S3 endpoint, region, and credentials. See {@link S3ClientConfig}.
   */
  s3Config: S3ClientConfig;

  /**
   * DOMParser used to parse S3 list-object XML responses. Must be
   * supplied explicitly — there is no fallback, since `globalThis.DOMParser`
   * does not exist in Node and reaching for it silently is fragile.
   *
   * The parser MUST NOT expand external entities or DTDs — S3 responses
   * never contain a DOCTYPE in normal operation, and a permissive parser
   * exposes the client to XXE / billion-laughs attacks if a response is
   * tampered with in transit or returned by a malicious endpoint.
   *
   * Browsers: pass `new window.DOMParser()`.
   *
   * Node / non-browser runtimes: use `@xmldom/xmldom@^0.9` (0.9.x and
   * later no longer interpret DTD entity definitions by default).
   * Earlier 0.8.x releases are deprecated and not recommended.
   */
  parser: XmlParser;

  /**
   * Should the client attempt to upstreams?
   * (default false)
   */
  online?: boolean;

  /**
   * Should the client cache writes locally?
   * (default true)
   */
  offlineStorage?: boolean;

  /**
   * Should the client delete expired references?
   * (default true)
   */
  autoclean?: boolean;

  /**
   * Clock offset in milliseconds
   * (default 0)
   */
  clockOffset?: number;

  /**
   * Update clock on detection of skewed clock
   * (default true)
   */
  adaptiveClock?: boolean;

  /**
   * Minimize the number of list-object-v2 operations by polling a last_change file first
   * (default true)
   */
  minimizeListObjectsCalls?: boolean;

  /**
   * Bring your own logger
   */
  log?: ((...args: unknown[]) => void) | boolean;
}

/** @internal */
export interface ResolvedMPS3Config extends MPS3Config {
  label: string;
  defaultManifest: ResolvedRef;
  useVersioning: boolean;
  online: boolean;
  offlineStorage: boolean;
  autoclean: boolean;
  clockOffset: number;
  adaptiveClock: boolean;
  minimizeListObjectsCalls: boolean;
  parser: XmlParser;
  log: (...args: unknown[]) => void;
}

interface GetResponse<T> {
  $metadata: {
    httpStatusCode?: number;
  };
  ETag?: string;
  VersionId?: S3VersionId;
  data: T | undefined;
}

/**
 * Vendorless, causally consistent multiplayer document database client
 * over any S3-compatible storage API.
 *
 * Construct one per logical "session" (typically per page in a browser
 * app). Same `defaultBucket`/`defaultManifest` across clients = same
 * shared state.
 *
 * Public surface:
 *
 * - {@link get} / {@link put} / {@link delete} — single-key operations.
 * - {@link putAll} — atomic multi-key write.
 *
 * Realtime change notifications are deferred to a Phase 10 opt-in
 * `NotificationBus`; until then, callers refresh on demand by issuing
 * a fresh {@link get}.
 *
 * Errors thrown by any method are instances of `MPS3Error` (see
 * `packages/protocol/src/errors.ts`); discriminate on the `code` field.
 *
 * @example
 * ```ts
 * import { MPS3 } from "baerly-storage";
 *
 * const mps3 = new MPS3({
 *   defaultBucket: "my-bucket",
 *   s3Config: {
 *     region: "us-east-1",
 *     credentials: {
 *       accessKeyId: "...",
 *       secretAccessKey: "...",
 *     },
 *   },
 * });
 *
 * await mps3.put("user/42", { name: "Ada" });
 * const user = await mps3.get("user/42");
 * ```
 */
export class MPS3 {
  /**
   * Virtual endpoint for in-memory operation. Test-friendly: zero infra
   * deps, isolated per-process, no IDB shim required. Storage is shared
   * across all `MPS3` instances in the same process by bucket name —
   * use `resetMemoryStorage()` from `@baerly/protocol` between tests
   * when isolation matters.
   */
  static MEMORY_ENDPOINT = "memory:";
  /** @internal */
  config: ResolvedMPS3Config;
  /**
   * Per-bucket `Storage` instances. `MPS3` operates on multiple
   * buckets (a `Ref` carries one); each bucket gets its own backing
   * store the first time it's referenced. The legacy
   * `MemoryStorage`/`fetchFnFromStorage` factory pattern is mirrored:
   * memory mode uses the process-singleton; S3 mode constructs an
   * `S3HttpStorage` per bucket; offline mode shares a single
   * always-throwing stub.
   * @internal
   */
  #storages = new Map<string, Storage>();
  /**
   * Lazily constructs the {@link Storage} for `bucket`. Uniform
   * entry point for `getObject`/`putObject`/`deleteObject` and for
   * `Syncer` LIST/GET against a manifest's bucket.
   * @internal
   */
  storageFor(bucket: string): Storage {
    let s = this.#storages.get(bucket);
    if (s !== undefined) return s;
    if (!this.config.online) {
      s = this.#offlineStorage;
    } else if (this.endpoint === MPS3.MEMORY_ENDPOINT) {
      s = getOrCreateMemoryStorageForBucket(bucket);
    } else {
      s = new S3HttpStorage({
        endpoint: this.endpoint,
        bucket,
        fetch: globalThis.fetch.bind(globalThis),
        ...(this.#sign !== undefined && { sign: this.#sign }),
        xmlParser: this.config.parser,
      });
    }
    this.#storages.set(bucket, s);
    return s;
  }
  readonly #offlineStorage: Storage = new OfflineStorage();
  #sign?: (req: Request) => Promise<Request>;
  /** @internal */
  manifests = new OMap<ResolvedRef, Manifest>(url);
  /** @internal */
  memCache = new BoundedLRU<
    GetObjectCommandInput,
    Promise<GetObjectCommandOutput & { data: unknown }>
  >(cacheKey, MEM_CACHE_CAPACITY);

  /** @internal */
  diskCache?: UseStore;

  /** @internal */
  endpoint: string;

  constructor(config: MPS3Config) {
    const defaultManifest: ResolvedRef =
      typeof config.defaultManifest === "string"
        ? { bucket: config.defaultBucket, key: config.defaultManifest }
        : {
            bucket: config.defaultManifest?.bucket ?? config.defaultBucket,
            key: config.defaultManifest?.key ?? "manifest.json",
          };
    this.config = {
      ...config,
      label: config.label || "default",
      autoclean: config.autoclean ?? true,
      online: config.online ?? true,
      offlineStorage: config.offlineStorage ?? true,
      useVersioning: config.useVersioning || false,
      clockOffset: Math.floor(config.clockOffset ?? 0),
      adaptiveClock: config.adaptiveClock ?? true,
      minimizeListObjectsCalls: config.minimizeListObjectsCalls ?? true,
      parser: config.parser,
      defaultManifest,
      log: (...args) =>
        (config.log === true ? console.log : config.log || (() => {}))(this.config.label, ...args),
    };

    if (this.config.s3Config?.credentials instanceof Function)
      throw new MPS3Error(
        "InvalidConfig",
        "Function-based s3Config.credentials are not supported yet",
      );

    if (config.s3Config.endpoint && typeof config.s3Config.endpoint !== "string") {
      throw new MPS3Error("InvalidConfig", "Only string s3Config.endpoint is supported");
    }
    if (config.s3Config.region && typeof config.s3Config.region !== "string") {
      throw new MPS3Error("InvalidConfig", "Only string s3Config.region is supported");
    }

    this.endpoint =
      config.s3Config.endpoint || `https://s3.${config.s3Config.region}.amazonaws.com`;

    // Reject endpoints that aren't http(s) — e.g. a stray `file:`, `ftp:`,
    // or a typo'd path. The `MEMORY_ENDPOINT` (`memory:`) sentinel is
    // the only non-http(s) value the rest of the constructor knows how
    // to handle.
    if (this.endpoint !== MPS3.MEMORY_ENDPOINT) {
      let scheme: string;
      try {
        scheme = new URL(this.endpoint).protocol;
      } catch {
        throw new MPS3Error("InvalidConfig", `Invalid endpoint URL: ${this.endpoint}`);
      }
      if (scheme !== "http:" && scheme !== "https:") {
        throw new MPS3Error(
          "InvalidConfig",
          `Unsupported endpoint scheme: ${scheme} (expected http: or https:)`,
        );
      }
    }

    if (this.config.s3Config?.credentials) {
      const creds = this.config.s3Config.credentials;
      const client = new AwsClient({
        accessKeyId: creds.accessKeyId, // required, akin to AWS_ACCESS_KEY_ID
        secretAccessKey: creds.secretAccessKey, // required, akin to AWS_SECRET_ACCESS_KEY
        ...(creds.sessionToken && { sessionToken: creds.sessionToken }), // akin to AWS_SESSION_TOKEN if using temp credentials
        region: this.config.s3Config.region || "us-east-1",
        service: "s3",
        retries: 0,
      });
      this.#sign = (req) => client.sign(req);
    }

    if (this.config.offlineStorage) {
      const dbName = `mps3-${this.config.label}`;
      this.diskCache = createStore(dbName, "v0");
    }
  }
  /** @internal */
  getOrCreateManifest(ref: ResolvedRef): Manifest {
    if (!this.manifests.has(ref)) {
      const manifest = new Manifest(this, ref);
      this.manifests.set(ref, manifest);
    }
    return this.manifests.get(ref)!;
  }

  /**
   * Read the value for a key from the latest synced manifest state.
   *
   * @param ref - Either a string `"key"` or a `Ref` object. String form
   *   uses the configured `defaultBucket`.
   * @param options.manifest - Manifest to read from; defaults to
   *   {@link MPS3Config.defaultManifest}.
   * @returns The decoded JSON value, or `undefined` if the key is
   *   absent (never written, or deleted).
   * @throws {MPS3Error} `code = "OfflineNoCache"` if `online: false`
   *   and the key isn't in the local cache.
   * @throws {MPS3Error} `code = "AccessDenied"` if the bucket policy
   *   blocks the GET.
   * @throws {MPS3Error} `code = "NetworkError"` for transport failures.
   *
   * @example
   * ```ts
   * await mps3.put("user/42", { name: "Ada" });
   * const user = await mps3.get("user/42");
   * // → { name: "Ada" }
   * ```
   */
  public async get(
    ref: string | Ref,
    options: {
      manifest?: Ref;
    } = {},
  ): Promise<JSONValue | DeleteValue> {
    const manifestRef = resolveManifestRef(options.manifest, this.config.defaultManifest);
    const manifest = this.getOrCreateManifest(manifestRef);
    const contentRef = resolveContentRef(ref, this.config);

    const version = await manifest.getVersion(contentRef);
    if (version === undefined) return undefined;

    manifest.syncer.observeEntry(contentRef, version as VersionId);
    const response = await this.getObject<JSONValue>({
      operation: "GET",
      ref: contentRef,
      version: version,
    });
    if (response.$metadata.httpStatusCode === 404) {
      // Manifest-first ordering: a 404 here means the manifest
      // references content that's either in-flight or orphaned by a
      // writer that died mid-batch. Both surface as `undefined` to
      // callers; the warning (if outside the grace window) is logged
      // by `classifyMissingContent`.
      manifest.syncer.classifyMissingContent(contentRef, version as VersionId);
      return undefined;
    }
    return response.data;
  }

  /** @internal */
  async getObject<T>(args: {
    operation: string;
    ref: ResolvedRef;
    version?: string;
    ifNoneMatch?: string;
    useCache?: boolean;
  }): Promise<GetResponse<T>> {
    let command: GetObjectCommandInput;
    if (this.config.useVersioning) {
      command = {
        Bucket: args.ref.bucket,
        Key: args.ref.key,
        IfNoneMatch: args.ifNoneMatch,
        ...(args.version && { VersionId: args.version as S3VersionId }),
      };
    } else {
      command = {
        Bucket: args.ref.bucket,
        Key: `${args.ref.key}${args.version ? `@${args.version}` : ""}`,
        IfNoneMatch: args.ifNoneMatch,
      };
    }
    const key = cacheKey(command);
    if (args.useCache !== false) {
      if (this.memCache.has(command)) {
        /*
        this.config.log(
          `${this.config.label} ${args.operation} (mem cached) ${command.Bucket}/${command.Key}`,
        );*/
        return this.memCache.get(command)! as Promise<GetResponse<T>>;
      }
      if (this.diskCache) {
        const cached = await get<GetObjectCommandOutput & { data: T | undefined }>(
          key,
          this.diskCache,
        );
        if (cached) {
          this.config.log(`${args.operation} (disk cached) ${key}`);
          this.memCache.set(command, Promise.resolve(cached));
          return cached;
        }
      }
    }

    if (!this.config.online) {
      throw new MPS3Error(
        "OfflineNoCache",
        `${this.config.label} Offline and value not cached for ${key}`,
      );
    }

    const work = measure(
      this.storageFor(args.ref.bucket).get(command.Key!, {
        ...(command.IfNoneMatch !== undefined && { ifNoneMatch: command.IfNoneMatch }),
        ...(command.VersionId !== undefined && { versionId: command.VersionId }),
      }),
    ).then(([raw, dt]) => {
      const response: GetResponse<T> = raw === null
        ? {
            $metadata: { httpStatusCode: command.IfNoneMatch !== undefined ? 304 : 404 },
            data: undefined,
          }
        : {
            $metadata: { httpStatusCode: 200 },
            ETag: raw.etag,
            ...(raw.versionId !== undefined && { VersionId: raw.versionId as S3VersionId }),
            data: parseJsonBody<T>(raw.body, args.ref.bucket, command.Key!),
          };
      this.config.log(
        `${dt}ms ${args.operation} ${args.ref.bucket}/${args.ref.key}@${args.version} => ${response.VersionId}`,
      );
      return response;
    });

    if (args.useCache !== false) {
      this.memCache.set(command, work);
      if (this.diskCache) {
        work.then((response) => {
          set(key, response, this.diskCache!).then(() =>
            this.config.log(`STORE ${command.Bucket}${command.Key}`),
          );
        });
      }
    }
    return work;
  }

  /**
   * Delete a key. Equivalent to `put(ref, undefined)`. The key vanishes
   * from subsequent `get()` and `keys()` results.
   *
   * @param ref - Either a string `"key"` or a `Ref` object.
   * @param options.manifests - Apply the delete to these manifests
   *   atomically (defaults to `[defaultManifest]`).
   *
   * @example
   * ```ts
   * await mps3.delete("user/42");
   * ```
   */
  public async delete(
    ref: string | Ref,
    options: {
      manifests?: Ref[];
    } = {},
  ) {
    return this.putAll(new Map([[ref, undefined]]), options);
  }

  /**
   * Write a single key. The returned Promise settles when the manifest
   * patch is confirmed by S3 (and the content body has been persisted).
   *
   * @param ref - Either `"key"` or `{ bucket, key }`.
   * @param value - Any JSON value, or `undefined` to delete.
   * @param options.manifests - Write to multiple manifests atomically
   *   (defaults to `[defaultManifest]`).
   * @param options.replication - Replication marker for downstream
   *   replicators; see {@link replication}.
   * @returns A Promise that settles when the write is durable on S3.
   * @throws {MPS3Error} `code = "InvalidConfig"` if `useVersioning`
   *   is on but the bucket isn't versioned.
   * @throws {MPS3Error} `code = "NetworkError"` for transport failures.
   *
   * @example
   * ```ts
   * await mps3.put("user/42", { name: "Ada", email: "ada@example.com" });
   * ```
   */
  public async put(
    ref: string | Ref,
    value: JSONValue | DeleteValue,
    options: {
      replication?: b64;
      manifests?: Ref[];
    } = {},
  ) {
    return this.putAll(new Map([[ref, value]]), options);
  }

  /**
   * Write multiple keys in a single atomic manifest update. All keys
   * either land together or not at all — useful for transactional
   * writes that span keys.
   *
   * @param values - Map of `ref → value`. `undefined` value deletes.
   * @param options.manifests - Write to multiple manifests atomically.
   * @param options.keys - Per-key replication markers.
   *
   * @example
   * ```ts
   * await mps3.putAll(
   *   new Map<string, JSONValue | undefined>([
   *     ["user/42", { name: "Ada" }],
   *     ["user/43", { name: "Babbage" }],
   *     ["user/old", undefined], // delete
   *   ])
   * );
   * ```
   */
  public async putAll(
    values: Map<string | Ref, JSONValue | DeleteValue>,
    options: {
      keys?: Map<
        string | Ref,
        {
          replication?: b64;
        }
      >;
      manifests?: Ref[];
    } = {},
  ) {
    const resolvedValues = new Map<ResolvedRef, JSONValue | DeleteValue>(
      [...values].map(([ref, value]) => [resolveContentRef(ref, this.config), value]),
    );

    const manifests: ResolvedRef[] = (options?.manifests || [this.config.defaultManifest]).map(
      (ref) => resolveManifestRef(ref, this.config.defaultManifest),
    );

    const keys = options.keys
      ? new OMap(
          url,
          [...options.keys].map(([ref, key]) => [resolveContentRef(ref, this.config), key]),
        )
      : new OMap<
          ResolvedRef,
          {
            replication?: b64;
          }
        >(url);

    return this.putAllResolved(resolvedValues, {
      manifests,
      keys,
    });
  }
  /**
   * Manifest-first ordering: writes the manifest entry before any
   * content. A crash between manifest-PUT and content-PUT leaves the
   * bucket with an orphan manifest entry referencing missing content.
   * Readers tolerate this as in-flight (within a grace window) and
   * skip the row.
   *
   * Today there is no sweeper; orphan manifest entries persist until
   * the next manual cleanup. The eventual sweeper lives in
   * .claude/research/00-plan.md Phase 6 (cron compactor + two-phase
   * GC).
   *
   * Net trade vs the prior content-first ordering: previously, partial
   * failure leaked unreferenced content nothing could later identify;
   * now it leaks identifiable orphan entries the future sweeper will
   * GC.
   *
   * `useVersioning: true` keeps the legacy content-first ordering
   * because S3 only assigns the `x-amz-version-id` after PUT — the
   * manifest can't reference a version that doesn't exist yet.
   *
   * @internal
   */
  async putAllResolved(
    values: Map<ResolvedRef, JSONValue | DeleteValue>,
    options: {
      keys: OMap<
        ResolvedRef,
        {
          replication?: b64;
        }
      >;
      manifests: ResolvedRef[];
    },
  ) {
    if (this.config.useVersioning) {
      return this.putAllVersioned(values, options);
    }
    return this.putAllManifestFirst(values, options);
  }

  /** Manifest-first ordering for non-versioned mode. @internal */
  private async putAllManifestFirst(
    values: Map<ResolvedRef, JSONValue | DeleteValue>,
    options: {
      keys: OMap<ResolvedRef, { replication?: b64 }>;
      manifests: ResolvedRef[];
    },
  ) {
    const bodies = new Map<ResolvedRef, string>();

    // Step 1: hash all content bodies to compute versions WITHOUT PUTting.
    // Same JSON body ⇒ same VersionId, so a crash-recovery rewrite
    // produces an identical content key — manifest references stay valid.
    const versionEntries = await Promise.all(
      [...values].map(async ([contentRef, value]) => {
        if (value === undefined) {
          return [contentRef, undefined] as const;
        }
        const body = JSON.stringify(value);
        bodies.set(contentRef, body);
        const version = await versionFromContent(new TextEncoder().encode(body));
        return [contentRef, version] as const;
      }),
    );
    const contentVersions = new Map<ResolvedRef, VersionId | DeleteValue>(versionEntries);

    // Step 2 + 3: build manifest entries with computed versions and
    // PUT each manifest. The manifest PUT is the commit point.
    const manifestSettled = Promise.all(
      options.manifests.map((ref) => {
        const manifest = this.getOrCreateManifest(ref);
        return manifest.updateContent(Promise.resolve(contentVersions), {
          keys: options.keys,
          bodies: values,
        });
      }),
    );

    // Step 4: after the manifest commits, PUT (or DELETE) content.
    // Failures here leave orphan manifest entries; readers tolerate
    // 404-on-content as in-flight within ORPHAN_MANIFEST_GRACE_MILLIS.
    //
    // The `.then(undefined, () => undefined)` on `manifestSettled` is
    // load-bearing: if the manifest PUT rejects we don't want to also
    // surface the chained content rejection as unhandled. We let the
    // caller see only the manifest error and silently abort the
    // content step.
    const contentSettled = manifestSettled.then(
      () =>
        Promise.all(
          [...values].map(([contentRef, value]) => {
            if (value === undefined) {
              return this.deleteObject({ ref: contentRef });
            }
            const version = contentVersions.get(contentRef) as VersionId;
            return this.putObject({
              operation: "PUT_CONTENT",
              ref: contentRef,
              value,
              version,
              body: bodies.get(contentRef),
            });
          }),
        ),
      () => undefined,
    );

    await manifestSettled;
    await contentSettled;
    return manifestSettled;
  }

  /** Legacy content-first ordering for `useVersioning: true`. @internal */
  private async putAllVersioned(
    values: Map<ResolvedRef, JSONValue | DeleteValue>,
    options: {
      keys: OMap<ResolvedRef, { replication?: b64 }>;
      manifests: ResolvedRef[];
    },
  ) {
    const contentVersions: Promise<Map<ResolvedRef, VersionId | DeleteValue>> = (async () => {
      const results = new Map<ResolvedRef, VersionId | DeleteValue>();
      const contentOperations: Promise<any>[] = [];
      values.forEach((value, contentRef) => {
        if (value !== undefined) {
          contentOperations.push(
            this.putObject({
              operation: "PUT_CONTENT",
              ref: contentRef,
              value,
            }).then((fileUpdate) => {
              if (fileUpdate.VersionId === undefined) {
                this.config.log("PUT_CONTENT missing VersionId", fileUpdate);
                throw new MPS3Error(
                  "InvalidConfig",
                  `Bucket ${contentRef.bucket} is not version enabled!`,
                );
              }
              results.set(contentRef, fileUpdate.VersionId);
            }),
          );
        } else {
          contentOperations.push(
            this.deleteObject({
              ref: contentRef,
            }).then((_) => {
              results.set(contentRef, undefined);
            }),
          );
        }
      });
      await Promise.all(contentOperations);
      return results;
    })();

    return Promise.all(
      options.manifests.map((ref) => {
        const manifest = this.getOrCreateManifest(ref);
        return manifest.updateContent(contentVersions, {
          keys: options.keys,
          bodies: values,
        });
      }),
    );
  }
  /** @internal */
  async putObject(args: {
    operation: string;
    ref: ResolvedRef;
    value: JSONValue;
    version?: string;
    /**
     * Pre-stringified body, supplied by `putAllManifestFirst` so the
     * version hash and the PUT body are guaranteed to be the same byte
     * sequence (any drift would put content under a key the manifest
     * doesn't reference).
     */
    body?: string;
  }): Promise<PutObjectCommandOutput & { Date: Date; latency: number }> {
    const content: string = args.body ?? JSON.stringify(args.value);
    let command: PutObjectCommandInput = {
      Bucket: args.ref.bucket,
      Key: this.config.useVersioning
        ? args.ref.key
        : `${args.ref.key}${args.version ? `@${args.version}` : ""}`,
      ContentType: "application/json",
      Body: content,
    };

    const [putResult, dt] = await measure(
      this.storageFor(args.ref.bucket).put(command.Key!, new TextEncoder().encode(content), {
        contentType: "application/json",
      }),
    );
    const response: PutObjectCommandOutput & { Date: Date } = {
      $metadata: { httpStatusCode: 200 },
      ETag: putResult.etag,
      Date: putResult.serverDate ?? new Date(),
      ...(putResult.versionId !== undefined && {
        VersionId: putResult.versionId as S3VersionId,
      }),
    };
    this.config.log(
      `${dt}ms ${args.operation} ${command.Bucket}/${command.Key} => ${response.VersionId}`,
    );

    if (this.diskCache && args.operation === "PUT_CONTENT") {
      const diskKey = cacheKey({
        Bucket: command.Bucket,
        Key: command.Key,
        VersionId: this.config.useVersioning ? response.VersionId : undefined,
      });
      await set(
        diskKey,
        {
          $metadata: {
            httpStatusCode: 200,
          },
          etag: response.ETag,
          data: args.value,
        },
        this.diskCache,
      ).then(() => this.config.log(`STORE ${diskKey}`));
    }

    return { ...response, latency: dt };
  }
  /** @internal */
  async deleteObject(args: {
    operation?: string;
    ref: ResolvedRef;
  }): Promise<DeleteObjectCommandOutput> {
    const [, dt] = await measure(this.storageFor(args.ref.bucket).delete(args.ref.key));
    this.config.log(
      `${dt}ms ${args.operation || "DELETE"} ${args.ref.bucket}/${args.ref.key}`,
    );
    return { $metadata: { httpStatusCode: 204 } };
  }

}
