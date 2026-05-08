import {
  DeleteObjectCommandInput,
  DeleteObjectCommandOutput,
  GetObjectCommandInput,
  GetObjectCommandOutput,
  PutObjectCommandInput,
  PutObjectCommandOutput,
  S3ClientConfig,
} from "@aws-sdk/client-s3";
import { AwsClient } from "aws4fetch";
import { FetchFn, S3ClientLite } from "S3ClientLite";
import { OMap } from "OMap";
import { Manifest } from "manifest";
import { DeleteValue, Ref, ResolvedRef, VersionId, url, uuid } from "types";
import { JSONValue } from "json";
import { UseStore, createStore, get, set } from "idb-keyval";
import * as time from "time";
import * as offlineFetch from "indexdb";
import { b64, sha256b64 } from "hashing";
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
     * S3ClientConfig, only some features are supported. Please report feature requests.
     * @see https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/clients/client-s3/interfaces/s3clientconfig.html
     * @defaultValue 1000
     */
    s3Config: S3ClientConfig;

    /**
     * DOMParser to use to parse XML responses from S3. The browser has one
     * but in other Javascript environments you may need to provide one.
     * @defaultValue new window.DOMParser()
     */
    parser?: DOMParser;

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
    log?: ((...args: any) => void) | boolean;
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
    parser: DOMParser;
    log: (...args: any) => void;
}

interface GetResponse<T> {
    $metadata: {
        httpStatusCode?: number;
    };
    ETag?: string;
    VersionId?: string;
    data: T | undefined;
}

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
    memCache = new OMap<
        GetObjectCommandInput,
        Promise<GetObjectCommandOutput & { data: any }>
    >(
        (input) =>
            `${input.Bucket}${input.Key}${input.VersionId}${input.IfNoneMatch}`
    );

    /** @internal */
    diskCache?: UseStore;

    /** @internal */
    endpoint: string;

    constructor(config: MPS3Config) {
        this.config = {
            ...config,
            label: config.label || "default",
            useChecksum: config.useChecksum === false ? false : true,
            autoclean: config.autoclean === false ? false : true,
            online: config.online === false ? false : true,
            offlineStorage: config.offlineStorage === false ? false : true,
            useVersioning: config.useVersioning || false,
            pollFrequency: config.pollFrequency || 1000,
            clockOffset: Math.floor(config.clockOffset!) || 0,
            adaptiveClock: config.adaptiveClock === false ? false : true,
            minimizeListObjectsCalls:
                config.minimizeListObjectsCalls === false ? false : true,
            parser: config.parser || new DOMParser(),
            defaultManifest: {
                bucket:
                    (<Ref>config.defaultManifest)?.bucket ||
                    config.defaultBucket,
                key:
                    typeof config.defaultManifest == "string"
                        ? config.defaultManifest
                        : config.defaultManifest?.key || "manifest.json",
            },
            log: (...args) =>
                (config.log === true ? console.log : config.log || (() => {}))(
                    this.config.label,
                    ...args
                ),
        };

        if (this.config.s3Config?.credentials instanceof Function)
            throw Error("We can't do that yet");

        this.endpoint =
            <string>config.s3Config.endpoint ||
            `https://s3.${config.s3Config.region}.amazonaws.com`;

        let fetchFn: FetchFn;

        if (this.config.s3Config?.credentials) {
            const client = new AwsClient({
                accessKeyId: this.config.s3Config.credentials.accessKeyId!, // required, akin to AWS_ACCESS_KEY_ID
                secretAccessKey:
                    this.config.s3Config.credentials.secretAccessKey!, // required, akin to AWS_SECRET_ACCESS_KEY
                sessionToken: this.config.s3Config.credentials.sessionToken!, // akin to AWS_SESSION_TOKEN if using temp credentials
                region: <string>this.config.s3Config.region || "us-east-1",
                service: "s3",
                retries: 0,
            });
            fetchFn = (...args) => client.fetch(...args);
        } else if (this.endpoint == MPS3.LOCAL_ENDPOINT) {
            fetchFn = offlineFetch.fetchFn;
        } else {
            fetchFn = (global || window).fetch.bind(global || window);
        }

        if (this.config.offlineStorage) {
            const dbName = `mps3-${this.config.label}`;
            this.diskCache = createStore(dbName, "v0");
        }

        this.s3ClientLite = new S3ClientLite(
            this.config.online ? fetchFn : () => new Promise(() => {}),
            this.endpoint,
            this
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

    public async get(
        ref: string | Ref,
        options: {
            manifest?: Ref;
        } = {}
    ): Promise<JSONValue | DeleteValue> {
        const manifestRef: ResolvedRef = {
            ...this.config.defaultManifest,
            ...options.manifest,
        };
        const manifest = this.getOrCreateManifest(manifestRef);
        const contentRef: ResolvedRef = {
            bucket:
                (<Ref>ref).bucket ||
                this.config.defaultBucket ||
                this.config.defaultManifest.bucket,
            key: typeof ref === "string" ? ref : ref.key,
        };

        const inflight = await manifest.operationQueue.flatten();
        if (inflight.has(contentRef)) {
            this.config.log(
                `GET (cached) ${contentRef} ${inflight.get(contentRef)}`
            );
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
                const cached = await get<
                    GetObjectCommandOutput & { data: T | undefined }
                >(key, this.diskCache);
                if (cached) {
                    this.config.log(`${args.operation} (disk cached) ${key}`);
                    this.memCache.set(command, Promise.resolve(cached));
                    return cached;
                }
            }
        }

        if (!this.config.online) {
            throw new Error(
                `${this.config.label} Offline and value not cached for ${key}`
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
                    `${time}ms ${args.operation} ${args.ref.bucket}/${args.ref.key}@${args.version} => ${response.VersionId}`
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
                        this.diskCache!
                    ).then(() =>
                        this.config.log(`STORE ${command.Bucket}${command.Key}`)
                    );
                });
            }
        }
        return work;
    }

    public async delete(
        ref: string | Ref,
        options: {
            manifests?: Ref[];
        } = {}
    ) {
        return this.putAll(new Map([[ref, undefined]]), options);
    }

    public async put(
        ref: string | Ref,
        value: JSONValue | DeleteValue,
        options: {
            replication?: b64;
            manifests?: Ref[];
            await?: "local" | "remote";
        } = {}
    ) {
        return this.putAll(new Map([[ref, value]]), options);
    }

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
        } = {}
    ) {
        const resolvedValues = new Map<ResolvedRef, JSONValue | DeleteValue>(
            [...values].map(([ref, value]) => [
                {
                    bucket:
                        (<Ref>ref).bucket ||
                        this.config.defaultBucket ||
                        this.config.defaultManifest.bucket,
                    key: typeof ref === "string" ? ref : ref.key,
                },
                value,
            ])
        );

        const manifests: ResolvedRef[] = (
            options?.manifests || [this.config.defaultManifest]
        ).map((ref) => ({
            ...this.config.defaultManifest,
            ...ref,
        }));

        const keys = options.keys
            ? new OMap(
                  url,
                  [...options.keys].map(([ref, key]) => [
                      {
                          bucket:
                              (<Ref>ref).bucket ||
                              this.config.defaultBucket ||
                              this.config.defaultManifest.bucket,
                          key: typeof ref === "string" ? ref : ref.key,
                      },
                      key,
                  ])
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
            await: options.await || this.config.online ? "remote" : "local",
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
        }
    ) {
        const webValues: Map<ResolvedRef, JSONValue | DeleteValue> = new Map();
        const contentVersions: Promise<
            Map<ResolvedRef, VersionId | DeleteValue>
        > = new Promise(async (resolve, reject) => {
            const results = new Map<ResolvedRef, VersionId | DeleteValue>();
            const contentOperations: Promise<any>[] = [];
            values.forEach((value, contentRef) => {
                if (value !== undefined) {
                    let version: VersionId | undefined = this.config
                        .useVersioning
                        ? undefined
                        : <VersionId>(<unknown>uuid()); // TODO timestamped versions
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
                                    throw Error(
                                        `Bucket ${contentRef.bucket} is not version enabled!`
                                    );
                                } else {
                                    version = <VersionId>fileUpdate.VersionId;
                                }
                            }
                            results.set(contentRef, version);
                        })
                    );
                } else {
                    contentOperations.push(
                        this._deleteObject({
                            ref: contentRef,
                        }).then((_) => {
                            results.set(contentRef, undefined);
                        })
                    );
                }
            });
            await Promise.all(contentOperations).catch(reject);
            resolve(results);
        });

        return Promise.all(
            options.manifests.map((ref) => {
                const manifest = this.getOrCreateManifest(ref);
                return manifest.updateContent(webValues, contentVersions, {
                    keys: options.keys,
                    await: options.await,
                    isLoad: options.isLoad === true,
                });
            })
        );
    }
    /** @internal */
    async _putObject(args: {
        operation: string;
        ref: ResolvedRef;
        value: JSONValue;
        version?: string;
    }): Promise<PutObjectCommandOutput & { Date: Date; latency: number }> {
        const content: string = JSON.stringify(args.value, null, 2);
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

        const [response, dt] = await time.measure(
            this.s3ClientLite.putObject(command)
        );
        this.config.log(
            `${dt}ms ${args.operation} ${command.Bucket}/${command.Key} => ${response.VersionId}`
        );

        if (this.diskCache) {
            const diskKey = `${command.Bucket}${command.Key}${
                args.version || response.VersionId
            }`;
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
                this.diskCache
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
        const [response, dt] = await time.measure(
            this.s3ClientLite.deleteObject(command)
        );
        this.config.log(
            `${dt}ms ${args.operation || "DELETE"} ${args.ref.bucket}/${
                args.ref.key
            } (${response.$metadata.httpStatusCode})}`
        );
        return response;
    }

    /**
     * Listen to a key for changes
     * @param key
     * @param handler callback to be notified of changes
     * @returns unsubscribe function
     */
    public subscribe(
        key: string | Ref,
        handler: (value: JSONValue | DeleteValue, error?: Error) => void,
        options?: {
            manifest?: Ref;
        }
    ): () => void {
        const manifestRef: ResolvedRef = {
            ...this.config.defaultManifest,
            ...options?.manifest,
        };
        const keyRef: ResolvedRef = {
            key: typeof key === "string" ? key : key.key,
            bucket:
                (<Ref>key).bucket ||
                this.config.defaultBucket ||
                manifestRef.bucket,
        };
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
        return Promise.all(
            [...this.manifests.values()].map((manifest) => manifest.poll())
        );
    }
    /** @internal */
    get subscriberCount(): number {
        return [...this.manifests.values()].reduce(
            (count, manifest) => count + manifest.subscriberCount,
            0
        );
    }

    shutdown(): void {
        this.manifests.forEach((manifest) => {
            manifest.subscribers.forEach((subscriber) => {
                manifest.subscribers.delete(subscriber);
            });
        });
    }
}
