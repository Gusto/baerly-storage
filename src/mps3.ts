import type {
  DeleteObjectCommandInput,
  DeleteObjectCommandOutput,
  GetObjectCommandInput,
  GetObjectCommandOutput,
  PutObjectCommandInput,
  PutObjectCommandOutput,
  S3ClientConfig,
} from "./s3-types";
import { AwsClient } from "aws4fetch";
import { type FetchFn, S3ClientLite } from "./S3ClientLite";
import { OMap } from "./OMap";
import { Manifest } from "./manifest";
import {
  type DeleteValue,
  type Ref,
  type ResolvedRef,
  type VersionId,
  type XmlParser,
  resolveContentRef,
  resolveManifestRef,
  url,
  uuid,
  versionFromUuid,
} from "./types";
import type { JSONValue } from "./json";
import { type UseStore, createStore, get, set } from "idb-keyval";
import * as time from "./time";
import * as offlineFetch from "./indexdb";
import { type b64, sha256b64 } from "./hashing";
import { MPS3Error } from "./errors";
import { MANIFEST_POLL_INTERVAL_MILLIS } from "./constants";
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
  /** @internal TODO we broke this */
  useChecksum?: boolean;

  /**
   * Frequency in milliseconds subscribers poll for changes.
   * Each poll consumes a GET API request, but minimal egress
   * due to If-None-Match request optimizations.
   * @defaultValue 1000
   */
  pollFrequency?: number;
  /**
   * S3 endpoint, region, and credentials. See `S3ClientConfig` in
   * `src/s3-types.ts` for the supported field surface.
   */
  s3Config: S3ClientConfig;

  /**
   * DOMParser used to parse S3 list-object XML responses.
   *
   * The parser MUST NOT expand external entities or DTDs — S3 responses
   * never contain a DOCTYPE in normal operation, and a permissive parser
   * exposes the client to XXE / billion-laughs attacks if a response is
   * tampered with in transit or returned by a malicious endpoint.
   *
   * Browsers: the default `new window.DOMParser()` is safe.
   *
   * Node / non-browser runtimes: use `@xmldom/xmldom@^0.9` (0.9.x and
   * later no longer interpret DTD entity definitions by default).
   * Earlier 0.8.x releases are deprecated and not recommended.
   *
   * @defaultValue `new window.DOMParser()`
   */
  parser?: XmlParser;

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
  useChecksum: boolean;
  pollFrequency: number;
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
  VersionId?: string;
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
 * - {@link subscribe} — watch a key for changes.
 * - {@link shutdown} — release polling timers.
 *
 * Errors thrown by any method are instances of `MPS3Error` (see
 * `src/errors.ts`); discriminate on the `code` field.
 *
 * @example
 * ```ts
 * import { MPS3 } from "mps3";
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
 *
 * const stop = mps3.subscribe("user/42", (u) => console.log("changed:", u));
 * // ... later
 * stop();
 * mps3.shutdown();
 * ```
 */
export class MPS3 {
  /**
   * Virtual endpoint for local-first operation
   */
  static LOCAL_ENDPOINT = "indexdb:"; // (!) browser compatibility
  /** @internal */
  config: ResolvedMPS3Config;
  /** @internal */
  s3ClientLite: S3ClientLite;
  /** @internal */
  manifests = new OMap<ResolvedRef, Manifest>(url);
  /** @internal */
  memCache = new OMap<GetObjectCommandInput, Promise<GetObjectCommandOutput & { data: any }>>(
    (input) => `${input.Bucket}${input.Key}${input.VersionId}${input.IfNoneMatch}`,
  );

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
      useChecksum: config.useChecksum ?? true,
      autoclean: config.autoclean ?? true,
      online: config.online ?? true,
      offlineStorage: config.offlineStorage ?? true,
      useVersioning: config.useVersioning || false,
      pollFrequency: config.pollFrequency || MANIFEST_POLL_INTERVAL_MILLIS,
      clockOffset: Math.floor(config.clockOffset ?? 0),
      adaptiveClock: config.adaptiveClock ?? true,
      minimizeListObjectsCalls: config.minimizeListObjectsCalls ?? true,
      parser: config.parser || new DOMParser(),
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

    let fetchFn: FetchFn;

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
      fetchFn = (url, init) => client.fetch(url, init);
    } else if (this.endpoint === MPS3.LOCAL_ENDPOINT) {
      fetchFn = offlineFetch.fetchFn;
    } else {
      fetchFn = globalThis.fetch.bind(globalThis);
    }

    if (this.config.offlineStorage) {
      const dbName = `mps3-${this.config.label}`;
      this.diskCache = createStore(dbName, "v0");
    }

    this.s3ClientLite = new S3ClientLite(
      this.config.online ? fetchFn : () => new Promise(() => {}),
      this.endpoint,
      this,
    );
  }
  /** @internal */
  getOrCreateManifest(ref: ResolvedRef): Manifest {
    if (!this.manifests.has(ref)) {
      const manifest = new Manifest(this, ref);
      this.manifests.set(ref, manifest);
      if (this.config.offlineStorage) {
        const dbName = `mps3-${this.config.label}-${ref.bucket}-${ref.key}`;
        const db = createStore(dbName, "v0");
        this.config.log(`Restoring manifest from ${dbName}`);
        manifest.load(db);
      }
    }
    return this.manifests.get(ref)!;
  }

  /**
   * Read the value for a key. Layers local optimistic writes over the
   * latest synced manifest state — what you'd see if you started a
   * subscriber right now.
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

    const inflight = await manifest.operationQueue.flatten();
    if (inflight.has(contentRef)) {
      this.config.log(`GET (cached) ${contentRef} ${inflight.get(contentRef)}`);
      return inflight.get(contentRef)![0];
    }
    const version = await manifest.getVersion(contentRef);
    if (version === undefined) return undefined;

    return (
      await this._getObject<any>({
        operation: "GET",
        ref: contentRef,
        version: version,
      })
    ).data;
  }

  /** @internal */
  async _getObject<T>(args: {
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
        ...(args.version && { VersionId: args.version }),
      };
    } else {
      command = {
        Bucket: args.ref.bucket,
        Key: `${args.ref.key}${args.version ? `@${args.version}` : ""}`,
        IfNoneMatch: args.ifNoneMatch,
      };
    }
    const key = `${command.Bucket}${command.Key}${command.VersionId}`;
    if (args.useCache !== false) {
      if (this.memCache.has(command)) {
        /*
        this.config.log(
          `${this.config.label} ${args.operation} (mem cached) ${command.Bucket}/${command.Key}`,
        );*/
        return this.memCache.get(command)!;
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

    const work = time
      .measure(this.s3ClientLite.getObject(command))
      .then(async ([apiResponse, time]) => {
        const response: GetResponse<T> = {
          $metadata: apiResponse.$metadata,
          ETag: apiResponse.ETag,
          data: <T | undefined>apiResponse.Body,
        };
        this.config.log(
          `${time}ms ${args.operation} ${args.ref.bucket}/${args.ref.key}@${args.version} => ${response.VersionId}`,
        );
        return response;
      })
      .catch((err: any) => {
        if (err?.name === "304") {
          return {
            $metadata: {
              httpStatusCode: 304,
            },
            data: undefined,
          };
        } else {
          throw err;
        }
      });

    if (args.useCache !== false) {
      this.memCache.set(command, work);
      if (this.diskCache) {
        work.then((response) => {
          set(
            `${command.Bucket}${command.Key}${command.VersionId}`,
            response,
            this.diskCache!,
          ).then(() => this.config.log(`STORE ${command.Bucket}${command.Key}`));
        });
      }
    }
    return work;
  }

  /**
   * Delete a key. Equivalent to `put(ref, undefined)`. The key vanishes
   * from subsequent `get()` and `keys()` results; subscribers receive
   * `undefined`.
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
   * Write a single key. The returned Promise settles when the write is
   * durable at the level requested by `options.await`:
   * `"local"` (IndexedDB only — the offline-first ack) or
   * `"remote"` (manifest patch confirmed by S3).
   *
   * Default await level is `"remote"` when the client is online,
   * `"local"` otherwise.
   *
   * @param ref - Either `"key"` or `{ bucket, key }`.
   * @param value - Any JSON value, or `undefined` to delete.
   * @param options.await - `"local"` for offline-first ack, `"remote"`
   *   to wait for S3 confirmation.
   * @param options.manifests - Write to multiple manifests atomically
   *   (defaults to `[defaultManifest]`).
   * @param options.replication - Replication marker for downstream
   *   replicators; see {@link replication}.
   * @returns A Promise that settles when the write reaches the
   *   requested durability level.
   * @throws {MPS3Error} `code = "InvalidConfig"` if `useVersioning`
   *   is on but the bucket isn't versioned.
   * @throws {MPS3Error} `code = "NetworkError"` for transport failures.
   *
   * @example
   * ```ts
   * await mps3.put("user/42", { name: "Ada", email: "ada@example.com" });
   *
   * // Optimistic ack only:
   * await mps3.put("draft", { body: "..." }, { await: "local" });
   * ```
   */
  public async put(
    ref: string | Ref,
    value: JSONValue | DeleteValue,
    options: {
      replication?: b64;
      manifests?: Ref[];
      await?: "local" | "remote";
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
   * @param options.await - See {@link put}.
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
      await?: "local" | "remote";
      isLoad?: boolean;
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

    return this._putAll(resolvedValues, {
      manifests,
      keys,
      await: options.await ?? (this.config.online ? "remote" : "local"),
    });
  }
  /** @internal */
  async _putAll(
    values: Map<ResolvedRef, JSONValue | DeleteValue>,
    options: {
      keys: OMap<
        ResolvedRef,
        {
          replication?: b64;
        }
      >;
      manifests: ResolvedRef[];
      await: "local" | "remote";
      isLoad?: boolean;
    },
  ) {
    const webValues: Map<ResolvedRef, JSONValue | DeleteValue> = new Map();
    const contentVersions: Promise<Map<ResolvedRef, VersionId | DeleteValue>> = (async () => {
      const results = new Map<ResolvedRef, VersionId | DeleteValue>();
      const contentOperations: Promise<any>[] = [];
      values.forEach((value, contentRef) => {
        if (value !== undefined) {
          let version: VersionId | undefined = this.config.useVersioning
            ? undefined
            : versionFromUuid(uuid()); // TODO timestamped versions
          webValues.set(contentRef, value);

          contentOperations.push(
            this._putObject({
              operation: "PUT_CONTENT",
              ref: contentRef,
              value,
              version,
            }).then((fileUpdate) => {
              if (this.config.useVersioning) {
                if (fileUpdate.VersionId === undefined) {
                  console.error(fileUpdate);
                  throw new MPS3Error(
                    "InvalidConfig",
                    `Bucket ${contentRef.bucket} is not version enabled!`,
                  );
                } else {
                  version = <VersionId>fileUpdate.VersionId;
                }
              }
              results.set(contentRef, version);
            }),
          );
        } else {
          contentOperations.push(
            this._deleteObject({
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
        return manifest.updateContent(webValues, contentVersions, {
          keys: options.keys,
          await: options.await,
          isLoad: options.isLoad === true,
        });
      }),
    );
  }
  /** @internal */
  async _putObject(args: {
    operation: string;
    ref: ResolvedRef;
    value: JSONValue;
    version?: string;
  }): Promise<PutObjectCommandOutput & { Date: Date; latency: number }> {
    const content: string = JSON.stringify(args.value);
    let command: PutObjectCommandInput = {
      Bucket: args.ref.bucket,
      Key: this.config.useVersioning
        ? args.ref.key
        : `${args.ref.key}${args.version ? `@${args.version}` : ""}`,
      ContentType: "application/json",
      Body: content,
      ...(this.config.useChecksum && {
        ChecksumSHA256: await sha256b64(content),
      }),
    };

    const [response, dt] = await time.measure(this.s3ClientLite.putObject(command));
    this.config.log(
      `${dt}ms ${args.operation} ${command.Bucket}/${command.Key} => ${response.VersionId}`,
    );

    if (this.diskCache) {
      const diskKey = `${command.Bucket}${command.Key}${args.version || response.VersionId}`;
      const data = JSON.parse(content);
      await set(
        diskKey,
        {
          $metadata: {
            httpStatusCode: 200,
          },
          etag: response.ETag,
          data,
        },
        this.diskCache,
      ).then(() => this.config.log(`STORE ${diskKey}`));
    }

    return { ...response, latency: dt };
  }
  /** @internal */
  async _deleteObject(args: {
    operation?: string;
    ref: ResolvedRef;
  }): Promise<DeleteObjectCommandOutput> {
    const command: DeleteObjectCommandInput = {
      Bucket: args.ref.bucket,
      Key: args.ref.key,
    };
    const [response, dt] = await time.measure(this.s3ClientLite.deleteObject(command));
    this.config.log(
      `${dt}ms ${args.operation || "DELETE"} ${args.ref.bucket}/${
        args.ref.key
      } (${response.$metadata.httpStatusCode})}`,
    );
    return response;
  }

  /**
   * Watch a key for changes. The handler fires once with the initial
   * value (or `undefined` if absent), then again every time the value
   * changes — locally or remotely. Polling backs off automatically
   * when there are no subscribers.
   *
   * @param key - Either `"key"` or `{ bucket, key }`.
   * @param handler - Called with `(value, error?)`. `error` is set
   *   only when the initial read fails; subsequent calls during the
   *   subscription pass `undefined` for `error`. A `value` of
   *   `undefined` means the key was deleted.
   * @param options.manifest - Manifest to subscribe to; defaults to
   *   {@link MPS3Config.defaultManifest}.
   * @returns Unsubscribe function. Calling it stops further
   *   notifications. Idempotent.
   *
   * @example
   * ```ts
   * const unsubscribe = mps3.subscribe("user/42", (user, err) => {
   *   if (err) console.error(err);
   *   else console.log("user changed:", user);
   * });
   * // ... later
   * unsubscribe();
   * ```
   */
  public subscribe(
    key: string | Ref,
    handler: (value: JSONValue | DeleteValue, error?: Error) => void,
    options?: {
      manifest?: Ref;
    },
  ): () => void {
    const manifestRef = resolveManifestRef(options?.manifest, this.config.defaultManifest);
    const keyRef = resolveContentRef(key, this.config);
    const manifest = this.getOrCreateManifest(manifestRef);
    const unsubscribe = manifest.subscribe(keyRef, handler);
    this.get(keyRef, {
      manifest: manifestRef,
    })
      .then((initial) => {
        this.config.log(`NOTIFY (initial) ${url(keyRef)}`);
        // if the data is cached we don't want the subscriber called in the same tick as
        // the unsubscribe return value will not be initialized
        queueMicrotask(() => {
          handler(initial, undefined);
          manifest.poll();
        });
      })
      .catch((error) => {
        handler(undefined, error);
      });

    return unsubscribe;
  }

  /** @internal */
  refresh(): Promise<unknown> {
    return Promise.all([...this.manifests.values()].map((manifest) => manifest.poll()));
  }
  /** @internal */
  get subscriberCount(): number {
    return [...this.manifests.values()].reduce(
      (count, manifest) => count + manifest.subscriberCount,
      0,
    );
  }

  /**
   * Cancel every subscription on every manifest, releasing the
   * polling timers. Use this before tearing down the client (e.g.
   * page unload, hot-reload). In-flight writes are unaffected — they
   * still settle.
   */
  shutdown(): void {
    this.manifests.forEach((manifest) => {
      manifest.subscribers.forEach((subscriber) => {
        manifest.subscribers.delete(subscriber);
      });
    });
  }
}
