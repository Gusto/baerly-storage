import { OMap } from "OMap";
import { MPS3 } from "mps3";
import { OperationQueue } from "operationQueue";
import { DeleteValue, ResolvedRef, VersionId, url } from "types";
import { JSONValue } from "json";
import { UseStore } from "idb-keyval";
import { Syncer } from "syncer";
import { b64 } from "hashing";

class Subscriber {
    queue = Promise.resolve();

    constructor(
        public ref: ResolvedRef,
        public handler: (value: JSONValue | DeleteValue) => void,
        public lastVersion?: VersionId
    ) {}

    notify(
        service: MPS3,
        version: VersionId | undefined,
        content: Promise<JSONValue | DeleteValue>
    ) {
        this.queue = this.queue
            .then(() => content)
            .then((response) => {
                if (version !== this.lastVersion) {
                    service.config.log(
                        `${service.config.label} NOTIFY ${url(
                            this.ref
                        )} ${version}`
                    );
                    this.lastVersion = version;
                    this.handler(response);
                }
            });
    }
}

export class Manifest {
    subscribers = new Set<Subscriber>();
    poller?: Timer;
    pollInProgress: boolean = false;

    syncer: Syncer = new Syncer(this);
    operationQueue = new OperationQueue<VersionId>();

    constructor(public service: MPS3, public ref: ResolvedRef) {
        console.log("Create manifest", url(ref));
    }
    load(db: UseStore) {
        this.syncer.restore(db);
        this.operationQueue.restore(
            db,
            async (
                values: Map<ResolvedRef, JSONValue | DeleteValue>,
                label?: VersionId
            ) => {
                if (!label) {
                    // this write has not been attempted at all
                    // we do a write from scratch
                    await this.service._putAll(values, {
                        manifests: [this.ref],
                        await: "local",
                        isLoad: true,
                    });
                } else {
                    // the content was uploaded, but we don't know if the manifest was
                    // so we do a manifest write
                    await this.updateContent(
                        values,
                        Promise.resolve(
                            new Map<ResolvedRef, VersionId>([[this.ref, label]])
                        ),
                        {
                            await: "local",
                            isLoad: true,
                        }
                    );
                }
            }
        );
    }
    observeVersionId(versionId: VersionId) {
        this.operationQueue.confirm(versionId);
    }

    async poll() {
        if (this.pollInProgress) return;
        this.pollInProgress = true;

        if (this.subscriberCount === 0 && this.poller) {
            clearInterval(this.poller);
            this.poller = undefined;
        }
        if (this.subscriberCount > 0 && !this.poller) {
            this.poller = setInterval(
                () => this.poll(),
                this.service.config.pollFrequency
            );
        }

        const state = await this.syncer.getLatest();

        if (state === undefined) {
            this.pollInProgress = false;
            return; // no changes
        }

        // calculate which values are set by optimistic updates
        const mask: OMap<ResolvedRef, [JSONValue | DeleteValue, number]> =
            await this.operationQueue.flatten();

        this.subscribers.forEach(async (subscriber) => {
            if (mask.has(subscriber.ref)) {
                // console.log("mask", url(subscriber.ref));
                const [value, op] = mask.get(subscriber.ref)!;
                subscriber.notify(
                    this.service,
                    <VersionId>`local-${op}`,
                    Promise.resolve(value)
                );
            } else {
                const fileState = state.files[url(subscriber.ref)];
                if (fileState) {
                    const content = this.service._getObject<any>({
                        operation: "GET_CONTENT",
                        ref: subscriber.ref,
                        version: fileState.version,
                    });
                    subscriber.notify(
                        this.service,
                        fileState.version,
                        content.then((res) => res.data)
                    );
                } else if (fileState === null) {
                    subscriber.notify(
                        this.service,
                        undefined,
                        Promise.resolve(undefined)
                    );
                }
            }
        });
        this.pollInProgress = false;
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
        }
    ): Promise<unknown> {
        return this.syncer.updateContent(values, write, options);
    }

    async getVersion(ref: ResolvedRef): Promise<string | undefined> {
        return (await this.syncer.getLatest()).files[url(ref)]?.version;
    }

    subscribe(
        keyRef: ResolvedRef,
        handler: (value: JSONValue | undefined) => void
    ): () => void {
        this.service.config.log(
            `SUBSCRIBE ${url(keyRef)} ${this.subscriberCount + 1}`
        );
        const sub = new Subscriber(keyRef, handler);
        this.subscribers.add(sub);
        return () => this.subscribers.delete(sub);
    }

    get subscriberCount(): number {
        return this.subscribers.size;
    }
}
