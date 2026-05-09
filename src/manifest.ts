import {
  type DeleteValue,
  type JSONValue,
  type ResolvedRef,
  type VersionId,
  type b64,
  OMap,
  url,
} from "@baerly/protocol";
import { MPS3 } from "./mps3";
import { OperationQueue } from "./operation-queue";
import type { UseStore } from "idb-keyval";
import { Syncer } from "./syncer";

class Subscriber {
  queue = Promise.resolve();

  constructor(
    public ref: ResolvedRef,
    public handler: (value: JSONValue | DeleteValue, error?: Error) => void,
    public lastVersion?: VersionId,
  ) {}

  notify(service: MPS3, version: VersionId | undefined, content: Promise<JSONValue | DeleteValue>) {
    this.queue = this.queue
      .then(() => content)
      .then((response) => {
        if (version !== this.lastVersion) {
          service.config.log(`${service.config.label} NOTIFY ${url(this.ref)} ${version}`);
          this.lastVersion = version;
          this.handler(response);
        }
      })
      .catch((err) => {
        service.config.log("subscriber handler threw", err);
      });
  }
}

/**
 * Per-manifest poller and subscriber registry. One `Manifest` per
 * configured manifest reference; each owns a {@link Syncer} (which reads
 * and writes the log) and an {@link OperationQueue} (which buffers
 * outgoing writes for offline-first delivery).
 *
 * The poll loop is what propagates remote writes into local subscribers.
 * Don't change the polling cadence or the manifest-key shape without
 * reading `docs/sync_protocol.md` first — the `<base32-time>_<session>_<seq>`
 * format is load-bearing for causal ordering.
 *
 * @see `docs/sync_protocol.md`
 * @see `docs/ARCHITECTURE.md` (lifecycle)
 */
export class Manifest {
  subscribers = new Set<Subscriber>();
  poller?: ReturnType<typeof setInterval>;
  pollInProgress: boolean = false;

  syncer: Syncer = new Syncer(this);
  operationQueue: OperationQueue<VersionId>;

  constructor(
    public service: MPS3,
    public ref: ResolvedRef,
  ) {
    this.operationQueue = new OperationQueue<VersionId>(undefined, service.config.log);
  }
  load(db: UseStore) {
    this.syncer.restore(db);
    this.operationQueue.restore(
      db,
      async (values: Map<ResolvedRef, JSONValue | DeleteValue>, label?: VersionId) => {
        if (!label) {
          // this write has not been attempted at all
          // we do a write from scratch
          await this.service._putAll(values, {
            manifests: [this.ref],
            keys: new OMap<ResolvedRef, { replication?: b64 }>(url),
            await: "local",
            isLoad: true,
          });
        } else {
          // the content was uploaded, but we don't know if the manifest was
          // so we do a manifest write
          await this.updateContent(
            values,
            Promise.resolve(new Map<ResolvedRef, VersionId>([[this.ref, label]])),
            {
              keys: new OMap<ResolvedRef, { replication?: b64 }>(url),
              await: "local",
              isLoad: true,
            },
          );
        }
      },
    );
  }
  observeVersionId(versionId: VersionId) {
    this.operationQueue.confirm(versionId);
  }

  async poll() {
    if (this.pollInProgress) return;
    this.pollInProgress = true;

    try {
      if (this.subscriberCount === 0 && this.poller) {
        clearInterval(this.poller);
        this.poller = undefined;
      }
      if (this.subscriberCount > 0 && !this.poller) {
        this.poller = setInterval(() => this.poll(), this.service.config.pollFrequency);
      }

      const state = await this.syncer.getLatest();

      // calculate which values are set by optimistic updates
      const mask: OMap<ResolvedRef, [JSONValue | DeleteValue, number]> =
        await this.operationQueue.flatten();

      await Promise.all(
        [...this.subscribers].map(async (subscriber) => {
          if (mask.has(subscriber.ref)) {
            const [value, op] = mask.get(subscriber.ref)!;
            subscriber.notify(this.service, <VersionId>`local-${op}`, Promise.resolve(value));
          } else {
            const fileState = state.files[url(subscriber.ref)];
            if (fileState) {
              this.syncer.observeEntry(subscriber.ref, fileState.version);
              const response = await this.service._getObject<JSONValue>({
                operation: "GET_CONTENT",
                ref: subscriber.ref,
                version: fileState.version,
              });
              if (response.$metadata.httpStatusCode === 404) {
                // Manifest-first ordering: the manifest references a
                // content key that hasn't been PUT yet (in-flight) or
                // never will be (orphan from a writer that died
                // between manifest-PUT and content-PUT). Either way,
                // skip the subscriber notification — false-positive
                // "deleted" notifications would corrupt the
                // application's view.
                this.syncer.classifyMissingContent(subscriber.ref, fileState.version);
              } else {
                subscriber.notify(this.service, fileState.version, Promise.resolve(response.data));
              }
            } else if (fileState === undefined) {
              subscriber.notify(this.service, undefined, Promise.resolve(undefined));
            }
          }
        }),
      );
    } catch (err) {
      this.subscribers.forEach((sub) => sub.handler(undefined, err as Error));
    } finally {
      this.pollInProgress = false;
    }
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
    return this.syncer.updateContent(values, write, options);
  }

  async getVersion(ref: ResolvedRef): Promise<string | undefined> {
    return (await this.syncer.getLatest()).files[url(ref)]?.version;
  }

  subscribe(
    keyRef: ResolvedRef,
    handler: (value: JSONValue | DeleteValue, error?: Error) => void,
  ): () => void {
    this.service.config.log(`SUBSCRIBE ${url(keyRef)} ${this.subscriberCount + 1}`);
    const sub = new Subscriber(keyRef, handler);
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}
