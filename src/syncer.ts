import {
  type DeleteValue,
  type JSONArraylessObject,
  type JSONValue,
  type LogEntry,
  type ManifestKey,
  type OMap,
  type ResolvedRef,
  type VersionId,
  type b64,
  LAG_WINDOW_MILLIS,
  MANIFEST_LIST_LOOKAHEAD_MILLIS,
  MPS3Error,
  ORPHAN_MANIFEST_GRACE_MILLIS,
  SESSION_ID_LENGTH,
  SYNCER_CLOCK_SKEW_MAX_RETRIES,
  TIMESTAMP_BIT_WIDTH,
  clone,
  countKey,
  logKey,
  lsnParts,
  measure,
  merge,
  str2uintDesc,
  timestamp,
  url,
  uuid,
} from "@baerly/protocol";
import type { Manifest } from "./manifest";
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
  <ManifestKey>`${ref.key}@${timestamp(epochMs)}`;

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
 * @see `docs/log-entry-shape.md` (per-mutation LogEntry emit path)
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

  /**
   * Per-(refUrl@version) wall-clock time at which this reader first
   * observed the manifest entry. Used to classify a 404 on the
   * referenced content key as either "in-flight" (within
   * {@link ORPHAN_MANIFEST_GRACE_MILLIS}) or "orphan" (older). The
   * manifest-first ordering in `MPS3.putAllResolved` deliberately permits
   * an interval where the manifest references content that has not
   * yet been PUT.
   *
   * @see docs/sync_protocol.md
   */
  private entryFirstObserved = new Map<string, number>();
  /** Set of `(refUrl@version)` we've already warned about, to keep
   *  the orphan-warning at one log line per entry. */
  private warnedOrphans = new Set<string>();

  static manifestRegex = /@([0-9a-z]+)_[0-9a-z]+_[0-9a-z]{2}$/;

  constructor(private manifest: Manifest) {}

  static manifestTimestamp = (key: string): number => {
    const match = key.match(Syncer.manifestRegex);
    if (!match || match[1] === undefined) return 0;
    return str2uintDesc(match[1], TIMESTAMP_BIT_WIDTH);
  };

  /**
   * True iff the manifest key's embedded timestamp agrees with the
   * server's `Last-Modified` within {@link LAG_WINDOW_MILLIS}.
   * Manifests outside the window are dropped — they may be from a
   * clock-skewed writer or replayed adversarially. When `modified`
   * is `undefined` (e.g. an in-memory storage with no server clock),
   * the cross-check degenerates to a key-shape check.
   *
   * @see `docs/sync_protocol.md` (clock-skew tolerance)
   */
  static isValid(key: string, modified?: Date): boolean {
    const match = key.match(Syncer.manifestRegex);
    if (!match) {
      return false;
    }
    if (modified === undefined) return true;
    const manifestTimestamp = this.manifestTimestamp(key);
    return Math.abs(manifestTimestamp - modified.getTime()) < LAG_WINDOW_MILLIS;
  }

  /**
   * Record that we've observed the manifest entry `(ref, version)` if
   * we hadn't already. Returns the wall-clock time at which we first
   * saw it.
   */
  observeEntry(ref: ResolvedRef, version: VersionId): number {
    const key = `${url(ref)}@${version}`;
    const existing = this.entryFirstObserved.get(key);
    if (existing !== undefined) return existing;
    const now = Date.now();
    this.entryFirstObserved.set(key, now);
    return now;
  }

  /**
   * Classify a 404 on content for `(ref, version)` as either
   * "in-flight" (manifest-first ordering: content PUT hasn't happened
   * yet, well within {@link ORPHAN_MANIFEST_GRACE_MILLIS}) or
   * "orphan" (the writer most likely died between manifest-PUT and
   * content-PUT). On the first orphan classification per entry, log
   * a warning via the configured `log` function.
   */
  classifyMissingContent(ref: ResolvedRef, version: VersionId): "in-flight" | "orphan" {
    const observedAt = this.observeEntry(ref, version);
    const age = Date.now() - observedAt;
    if (age < ORPHAN_MANIFEST_GRACE_MILLIS) return "in-flight";
    const key = `${url(ref)}@${version}`;
    if (!this.warnedOrphans.has(key)) {
      this.warnedOrphans.add(key);
      this.manifest.service.config.log(
        `WARN orphan manifest entry: ${url(ref)} → version ${version} missing after ${age}ms`,
      );
    }
    return "orphan";
  }

  // Manifest must be ordered by client operation time
  // (An exception is made for adjusting for clock skew)
  generate_manifest_key(): VersionId {
    return <VersionId>(
      (timestamp(
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

    // Errors from `getObject` / `listObjectV2` (`AccessDenied`,
    // `InvalidResponse`, `NetworkError`) are real faults — let them
    // propagate. The previous `catch` branch dispatched on
    // `err.name === "NoSuchKey"` from `@aws-sdk/client-s3`; that path
    // is dead today (`S3ClientLite.getObject` returns 404 instead of
    // throwing, and a fresh bucket lists empty).
    if (this.manifest.service.config.minimizeListObjectsCalls) {
      const poll = await this.manifest.service.getObject<string>({
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
    const collected: { Key: string; LastModified?: Date }[] = [];
    const [, dt] = await measure(
      (async () => {
        for await (const entry of this.manifest.service
          .storageFor(this.manifest.ref.bucket)
          .list(this.manifest.ref.key + "@", { startAfter: start_at })) {
          collected.push({
            Key: entry.key,
            ...(entry.lastModified !== undefined && { LastModified: entry.lastModified }),
          });
        }
      })(),
    );

    // prune invalid objects
    const manifests = collected.filter((obj) => {
      if (!Syncer.isValid(obj.Key, obj.LastModified)) {
        if (this.manifest.service.config.autoclean) {
          this.manifest.service.deleteObject({
            operation: "CLEANUP",
            ref: {
              bucket: this.manifest.ref.bucket,
              key: obj.Key,
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
      const latest = await this.manifest.service.getObject<ManifestFile>({
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
          this.manifest.service.deleteObject({
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
        promise: this.manifest.service.getObject<ManifestFile>({
          operation: "REPLAY",
          ref: {
            bucket: this.manifest.ref.bucket,
            key,
          },
        }),
      });
    }

    for (const { promise } of replays) {
      const step = await promise;
      this.latest_state = merge<ManifestFile>(this.latest_state, step.data?.update)!;
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

  async updateContent(
    write: Promise<Map<ResolvedRef, VersionId | DeleteValue>>,
    options: {
      keys: OMap<
        ResolvedRef,
        {
          replication?: b64;
        }
      >;
      /**
       * Document bodies keyed by ref. Threaded from `mps3.ts` so the
       * syncer can emit per-mutation {@link LogEntry} objects with the
       * post-image. `undefined` value signals a delete (matches the
       * representation in `write`). Optional because in-progress
       * tickets that do not need log-emit can omit it; the emit block
       * is a no-op when missing.
       */
      bodies?: Map<ResolvedRef, JSONValue | DeleteValue>;
    },
  ): Promise<unknown> {
    let manifest_version = this.generate_manifest_key();

    try {
      const update = await write;
      let response,
        manifest_key,
        retry = false;
      let attempts = 0;
      // Hoisted so the log-emit block below the loop can read
      // `state.files[url(ref)]?.version` as the pre-image.
      let state!: ManifestFile;
      do {
        state = await this.getLatest();
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

        const putResponse = await this.manifest.service.putObject({
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

      // Log-entry emission — one LogEntry per mutated ref under
      // `<manifest-prefix>/log/<lsn>.json`. Sits AFTER the CAS retry
      // loop (so we never emit for clock-skew-retried manifests that
      // get GC'd) and BEFORE the optional TOUCH_LATEST_CHANGE marker
      // (so subscribers polling on the marker see consistent state).
      // Failures are warned-and-continued: the manifest is the
      // source of truth, and orphan log entries are GC'd by Phase 5
      // compaction (mirrors `classifyMissingContent`'s tolerance for
      // orphan content).
      if (update.size > 0) {
        const commit_ts = new Date(
          Date.now() + this.manifest.service.config.clockOffset,
        ).toISOString();
        const logPuts: Promise<unknown>[] = [];
        for (const [ref, version] of update) {
          const entryLsn = this.generate_manifest_key();
          const { session, seq } = lsnParts(entryLsn);
          const priorVersion = state.files[url(ref)]?.version;
          const op: "I" | "U" | "D" =
            version === undefined ? "D" : priorVersion === undefined ? "I" : "U";
          // Collection mapping: first segment of `ref.key`, falling
          // back to `ref.bucket` for flat keys. Phase 4 (table API)
          // makes collections first-class. See docs/log-entry-shape.md.
          const slash = ref.key.indexOf("/");
          const collection = slash >= 0 ? ref.key.slice(0, slash) : ref.bucket;
          const body = options.bodies?.get(ref);
          const entry: LogEntry = {
            lsn: entryLsn,
            commit_ts,
            op,
            collection,
            doc_id: ref.key,
            schema_version: 0,
            session,
            seq,
            ...(op !== "D" && body !== undefined
              ? {
                  new: body as JSONArraylessObject,
                  patch: body as JSONArraylessObject,
                }
              : {}),
            // TODO(replica_identity FULL): emit `old` / `key_old`
            // when a collection opts in. See docs/log-entry-shape.md.
          };
          logPuts.push(
            this.manifest.service.putObject({
              operation: "PUT_LOG",
              ref: {
                bucket: this.manifest.ref.bucket,
                key: logKey(this.manifest.ref.key, entryLsn),
              },
              value: entry as unknown as JSONValue,
            }),
          );
        }
        const settled = await Promise.allSettled(logPuts);
        for (const r of settled) {
          if (r.status === "rejected") {
            this.manifest.service.config.log(
              "WARN log entry emit failed; manifest already committed",
              r.reason,
            );
          }
        }
      }

      if (this.manifest.service.config.minimizeListObjectsCalls) {
        response = await this.manifest.service.putObject({
          operation: "TOUCH_LATEST_CHANGE",
          ref: {
            key: this.manifest.ref.key,
            bucket: this.manifest.ref.bucket,
          },
          value: "",
        });
      }

      return response;
    } catch (err) {
      this.manifest.service.config.log("manifest update failed", err);
      if (err instanceof MPS3Error) throw err;
      throw new MPS3Error("NetworkError", "Manifest update failed", err);
    }
  }
}
