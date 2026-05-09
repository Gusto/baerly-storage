import {
  type DeleteValue,
  type JSONArraylessObject,
  type JSONValue,
  type ManifestKey,
  type OMap,
  type ResolvedRef,
  type VersionId,
  type b64,
  LAG_WINDOW_MILLIS,
  MANIFEST_LIST_LOOKAHEAD_MILLIS,
  MPS3Error,
  SESSION_ID_LENGTH,
  SYNCER_CLOCK_SKEW_MAX_RETRIES,
  TIMESTAMP_BIT_WIDTH,
  clone,
  countKey,
  merge,
  str2uintDesc,
  url,
  uuid,
} from "@baerly/protocol";
import type { Manifest } from "./manifest";
import * as time from "./time";
import { type UseStore, get, set } from "idb-keyval";

export interface FileState extends JSONArraylessObject {
  version: VersionId;
  /** Field used to track progression through replication graph */
  replication: b64;
}

/**
 * JSON Merge Patch (RFC 7386) over a {@link ManifestFile}.
 *
 * Mirrors the assignable subset of `Partial<ManifestFile>` (no recursive
 * `update` — an update-of-an-update is meaningless). RFC 7386 also permits
 * `null` inside `files` to signal deletion on apply; that case is written
 * at runtime via a single boundary cast (see `updateContent`) because
 * `JSONArrayless` — the constraint `merge<T>` enforces — disallows `null`.
 */
type ManifestPatch = {
  files?: { [url: string]: FileState };
};

export interface ManifestFile extends JSONArraylessObject {
  files: {
    [url: string]: FileState;
  };
  // JSON-merge-patch update that *this* operation was, the files do not include this
  update: ManifestPatch;
}
const MANIFEST_KEY = "manifest";
const INITIAL_STATE: ManifestFile & JSONValue = {
  files: {},
  update: {},
};

interface HttpCacheEntry<T> {
  etag: string;
  data: T;
}

/**
 * Compose a manifest log key from a manifest ref and an epoch-millis
 * timestamp. The `<key>@<base32-time>` shape is load-bearing — see
 * `docs/sync_protocol.md` (manifest log section).
 */
export const manifestKey = (ref: ResolvedRef, epochMs: number): ManifestKey =>
  <ManifestKey>`${ref.key}@${time.timestamp(epochMs)}`;

/**
 * Compose a manifest log key from a pre-computed version-id suffix
 * (output of {@link Syncer.generate_manifest_key}, shape
 * `<base32-time>_<session>_<seq>`). Distinct from {@link manifestKey}
 * because the suffix is already fully formatted — we don't re-derive
 * it from an epoch.
 */
export const manifestKeyFromVersion = (
  ref: ResolvedRef,
  version: VersionId | string,
): ManifestKey => <ManifestKey>`${ref.key}@${version}`;

/**
 * Extract the suffix following the final `@` of a manifest key, or
 * `undefined` if the key has no `@`. Inverse of {@link manifestKey} /
 * {@link manifestKeyFromVersion}.
 */
export const manifestKeySuffix = (key: ManifestKey | string): VersionId | undefined => {
  const i = key.lastIndexOf("@");
  return i === -1 ? undefined : <VersionId>key.substring(i + 1);
};

/**
 * Reads and writes the manifest log — the time-ordered append-only S3
 * key sequence that defines the protocol. Manifest keys have the shape
 * `<base32-time>_<session>_<seq>`; lexicographic order *is* causal order.
 *
 * Read `docs/sync_protocol.md` and `docs/causal_consistency_checking.md`
 * before changing anything in this file. Property-based and
 * state-machine tests cover the invariants — grep for `Syncer` in
 * `tests/` to find them.
 *
 * @see `docs/sync_protocol.md`
 * @see `docs/causal_consistency_checking.md`
 */
export class Syncer {
  session_id = uuid().substring(0, SESSION_ID_LENGTH);
  latest_key: string = ".";
  latest_state: ManifestFile = clone(INITIAL_STATE);

  loading?: Promise<unknown>;
  cache?: HttpCacheEntry<ManifestFile>;
  db?: UseStore;

  latest_timestamp = 0;
  writes = 0;

  static manifestRegex = /@([0-9a-z]+)_[0-9a-z]+_[0-9a-z]{2}$/;

  constructor(private manifest: Manifest) {}

  static manifestTimestamp = (key: string): number => {
    const match = key.match(Syncer.manifestRegex);
    if (!match || match[1] === undefined) return 0;
    return str2uintDesc(match[1], TIMESTAMP_BIT_WIDTH);
  };

  /**
   * True iff the manifest key's embedded timestamp agrees with the S3
   * `Last-Modified` header within {@link LAG_WINDOW_MILLIS}. Manifests
   * outside the window are dropped — they may be from a clock-skewed
   * writer or replayed adversarially.
   *
   * @see `docs/sync_protocol.md` (clock-skew tolerance)
   */
  static isValid(key: string, modified: Date): boolean {
    const match = key.match(Syncer.manifestRegex);
    if (!match) {
      return false;
    }
    if (modified === undefined) return true;
    const manifestTimestamp = this.manifestTimestamp(key);
    const s3Timestamp = modified;
    // if the difference is greater than 5 seconds, ignore this update
    return Math.abs(manifestTimestamp - s3Timestamp.getTime()) < LAG_WINDOW_MILLIS;
  }

  // Manifest must be ordered by client operation time
  // (An exception is made for adjusting for clock skew)
  generate_manifest_key(): VersionId {
    return <VersionId>(
      (time.timestamp(
        Math.max(Date.now() + this.manifest.service.config.clockOffset, this.latest_timestamp),
      ) +
        "_" +
        this.session_id +
        "_" +
        countKey(this.writes++))
    );
  }

  async restore(db: UseStore) {
    this.db = db;
    this.loading = get(MANIFEST_KEY, db).then((loaded) => {
      if (loaded) {
        this.latest_state = loaded;
        this.manifest.service.config.log(`RESTORE ${MANIFEST_KEY}`);
      }
    });
  }

  async getLatest(): Promise<ManifestFile> {
    if (this.loading) await this.loading;
    this.loading = undefined;

    if (!this.manifest.service.config.online) {
      return this.latest_state;
    }

    // Errors from `_getObject` / `listObjectV2` (`AccessDenied`,
    // `InvalidResponse`, `NetworkError`) are real faults — let them
    // propagate. The previous `catch` branch dispatched on
    // `err.name === "NoSuchKey"` from `@aws-sdk/client-s3`; that path
    // is dead today (`S3ClientLite.getObject` returns 404 instead of
    // throwing, and a fresh bucket lists empty).
    if (this.manifest.service.config.minimizeListObjectsCalls) {
      const poll = await this.manifest.service._getObject<string>({
        operation: "POLL_LATEST_CHANGE",
        ref: this.manifest.ref,
        ifNoneMatch: this.cache?.etag,
        useCache: false,
      });
      if (poll.$metadata.httpStatusCode === 304) {
        return this.latest_state;
      }
    }

    const start_at = manifestKey(
      this.manifest.ref,
      Date.now() + this.manifest.service.config.clockOffset + MANIFEST_LIST_LOOKAHEAD_MILLIS,
    );
    const [objects, dt] = await time.measure(
      this.manifest.service.s3ClientLite.listObjectV2({
        Bucket: this.manifest.ref.bucket,
        Prefix: this.manifest.ref.key + "@",
        StartAfter: start_at,
      }),
    );

    // prune invalid objects
    const manifests = objects.Contents?.filter((obj) => {
      if (!Syncer.isValid(obj.Key!, obj.LastModified!)) {
        if (this.manifest.service.config.autoclean) {
          this.manifest.service._deleteObject({
            operation: "CLEANUP",
            ref: {
              bucket: this.manifest.ref.bucket,
              key: obj.Key!,
            },
          });
        }
        return false;
      }
      return true;
    });

    this.manifest.service.config.log(
      `${dt}ms LIST ${this.manifest.ref.bucket}/${this.manifest.ref.key} from ${start_at}`,
    );

    // Play the missing patches over the base state, oldest first
    if (manifests === undefined) {
      this.latest_state = clone(INITIAL_STATE);
      return this.latest_state;
    }

    // Keep a record of the high water mark so we can ensure latest writes increment it.
    this.latest_timestamp = Math.max(
      this.latest_timestamp,
      Syncer.manifestTimestamp(this.latest_key),
    );

    // Find the most recent patch, whose base state is settled, and that we have a record for
    if (manifests.length > 0) {
      this.latest_key = manifests[0]!.Key!;
      const latest = await this.manifest.service._getObject<ManifestFile>({
        operation: "GET_LATEST",
        ref: {
          bucket: this.manifest.ref.bucket,
          key: this.latest_key,
        },
      });
      this.latest_state = latest.data!;
    }

    // Go back a little before the latest key to accommodate writes in flight
    const gcPoint = manifestKey(
      this.manifest.ref,
      Math.max(Syncer.manifestTimestamp(this.latest_key) - LAG_WINDOW_MILLIS, 0),
    );

    // Play operations forward on latest state, oldest first.
    // Issue all GETs in parallel; merge sequentially to preserve causal order.
    const replays: Array<{
      key: string;
      promise: Promise<{ data?: ManifestFile }>;
    }> = [];
    for (let index = manifests.length - 1; index >= 0; index--) {
      const key = manifests[index]!.Key!;
      if (key > this.latest_key && key > gcPoint) {
        // Its old we can skip and GC asyncronously
        if (this.manifest.service.config.autoclean) {
          this.manifest.service._deleteObject({
            operation: "CLEANUP",
            ref: {
              bucket: this.manifest.ref.bucket,
              key,
            },
          });
        }
        continue;
      }

      replays.push({
        key,
        promise: this.manifest.service._getObject<ManifestFile>({
          operation: "REPLAY",
          ref: {
            bucket: this.manifest.ref.bucket,
            key,
          },
        }),
      });
    }

    for (const { key, promise } of replays) {
      const step = await promise;
      const stepVersionId = manifestKeySuffix(key)!;
      this.latest_state = merge<ManifestFile>(this.latest_state, step.data?.update)!;
      this.manifest.observeVersionId(stepVersionId);
    }

    if (this.db) set(MANIFEST_KEY, this.latest_state, this.db);
    /*
    if (pollEtag) {
      this.cache = {
        etag: pollEtag,
        data: this.latest_state,
      };
    }*/
    return this.latest_state;
  }

  updateContent(
    values: Map<ResolvedRef, JSONValue | DeleteValue>,
    write: Promise<Map<ResolvedRef, VersionId | DeleteValue>>,
    options: {
      keys: OMap<
        ResolvedRef,
        {
          replication?: b64;
        }
      >;
      await: "local" | "remote";
      isLoad: boolean;
    },
  ): Promise<unknown> {
    let manifest_version = this.generate_manifest_key();

    const localPersistence = this.manifest.operationQueue.propose(write, values, options.isLoad);
    const remotePersistency = localPersistence.then(async () => {
      try {
        const update = await write;
        let response,
          manifest_key,
          retry = false;
        let attempts = 0;
        do {
          const state = await this.getLatest();
          const updateFiles: { [url: string]: FileState } = {};
          state.update = { files: updateFiles };

          for (let [ref, version] of update) {
            const fileUrl = url(ref);
            if (version) {
              const fileState: FileState = {
                version: version,
                replication: options.keys.get(ref)?.replication ?? <b64>"",
              };
              updateFiles[fileUrl] = fileState;
            } else {
              // RFC 7386: `null` inside an inner object signals "delete this
              // key on apply". `merge()` strips it from the result, so the
              // settled `ManifestFile.files` never holds `null` — but the
              // wire-format `update` payload must carry it for replays.
              // The cast crosses the gap between `JSONArrayless` (no null)
              // and the protocol's actual permissive shape.
              updateFiles[fileUrl] = null as unknown as FileState;
            }
          }
          // put versioned write
          manifest_key = manifestKeyFromVersion(this.manifest.ref, manifest_version);
          this.manifest.operationQueue.label(write, manifest_version, options.isLoad);

          const putResponse = await this.manifest.service._putObject({
            operation: "PUT_MANIFEST",
            ref: {
              key: manifest_key,
              bucket: this.manifest.ref.bucket,
            },
            value: state,
          });

          // Check the response leads to a valid write.
          if (
            this.manifest.service.config.adaptiveClock &&
            !Syncer.isValid(manifest_key, putResponse.Date)
          ) {
            if (++attempts >= SYNCER_CLOCK_SKEW_MAX_RETRIES) {
              throw new MPS3Error(
                "NetworkError",
                `Clock-skew retries exceeded (${SYNCER_CLOCK_SKEW_MAX_RETRIES}); server clock unreachable`,
              );
            }
            this.manifest.service.config.clockOffset =
              putResponse.Date.getTime() - Date.now() + putResponse.latency;
            manifest_version = this.generate_manifest_key();
            retry = true;
          } else {
            retry = false;
          }
        } while (retry);

        // update poller with write to known location
        if (this.manifest.service.config.minimizeListObjectsCalls) {
          response = await this.manifest.service._putObject({
            operation: "TOUCH_LATEST_CHANGE",
            ref: {
              key: this.manifest.ref.key,
              bucket: this.manifest.ref.bucket,
            },
            value: "",
          });
        }

        this.manifest.poll();
        return response;
      } catch (err) {
        this.manifest.service.config.log("manifest update failed", err);
        await this.manifest.operationQueue.cancel(write, options.isLoad);
        if (err instanceof MPS3Error) throw err;
        throw new MPS3Error("NetworkError", "Manifest update failed", err);
      }
    });
    if (options.await === "local") {
      return localPersistence;
    } else {
      return remotePersistency;
    }
  }
}
