/**
 * A tree bucket for reader tests: one collection in `MemoryStorage`, with
 * its log, its tree nodes and a tree head, written directly.
 *
 * {@link TreeBucket.commit} appends `log/<seq>.json` entries the way the
 * `Writer` would (`I` for an absent `_id`, `U` for a live one, `D` for a
 * delete). {@link TreeBucket.fold} publishes the canonical tree of the
 * rows through a folded seq: the rows come from the logical oracle over
 * the log (`tree-oracle-logical.ts`), the tree from the canonical builder
 * (`packages/server/src/tree/build.ts`), sealed under a fresh attempt
 * identity. Every node is created with `If-None-Match: "*"`, then the
 * head is written with the new floor, totals and `proto_tree`. A crashed
 * fold writes the nodes and stops before the head, as a fold that dies
 * before its head CAS does. The builder stands in for the fold, which
 * produces the same canonical tree; this fixture is not a fold and
 * checks nothing it writes.
 *
 * The head starts as a fresh head without `proto_tree`. The first fold
 * adds it, with the test chunk salt.
 */
import {
  type DocumentData,
  encodeJsonBytes,
  type LogEntry,
  logObjectKey,
  MemoryStorage,
  type Storage,
} from "@baerly/protocol";
import { buildTree, type SealedTree, sealTree } from "../../packages/server/src/tree/build.ts";
import type { ChunkKey } from "../../packages/server/src/tree/chunk.ts";
import { treeHeadKey } from "../../packages/server/src/tree/head.ts";
import { collectionOfPrefix } from "../../packages/server/src/tree/key.ts";
import type { TreeConfig } from "../../packages/server/src/tree/layout.ts";
import { canonicalDocument } from "../../packages/server/src/tree/node-codec.ts";
import { logStateCurrentJson } from "./log-state.ts";
import { TREE_TEST_CHUNK_SALT, testChunkKey } from "./tree-chunk-salt.ts";
import { foldLogical, type LogicalView } from "./tree-oracle-logical.ts";

/** Collection prefix of every tree bucket. */
export const TREE_BUCKET_PREFIX = "app/helpdesk/tenant/acme/manifests/tickets";

/** One row change: the row's new document, or `null` to delete it. */
export interface BucketChange {
  readonly id: string;
  readonly value: DocumentData | null;
}

/** What to fold. */
export interface BucketFold {
  /** The folded seq: the new `log_seq_start`. Default: the whole log. */
  readonly through?: number;
  /** Write the nodes and stop before the head. */
  readonly crash?: boolean;
}

/** One collection's log, tree nodes and head in memory. */
export class TreeBucket {
  readonly storage: Storage = new MemoryStorage();
  readonly prefix: string;
  readonly collection: string;
  readonly config: TreeConfig;
  readonly #key: ChunkKey;
  readonly #log: LogEntry[] = [];
  readonly #live = new Set<string>();
  #floor = 0;
  #tailHint = 0;
  #rows = 0;
  #bytes = 0;
  #tree: SealedTree | null = null;
  #hasTree = false;
  #attempts = 0;

  private constructor(config: TreeConfig, key: ChunkKey, prefix: string) {
    this.config = config;
    this.#key = key;
    this.prefix = prefix;
    this.collection = collectionOfPrefix(prefix);
  }

  /** An empty collection under `config` with a fresh head. */
  static async open(config: TreeConfig, prefix = TREE_BUCKET_PREFIX): Promise<TreeBucket> {
    const bucket = new TreeBucket(config, await testChunkKey(), prefix);
    await bucket.#writeHead();
    return bucket;
  }

  /** The folded seq (`log_seq_start`). */
  get floor(): number {
    return this.#floor;
  }

  /** The first empty log slot. */
  get tail(): number {
    return this.#log.length;
  }

  /** The tree the head names, or `null` before a fold or for an empty tree. */
  get tree(): SealedTree | null {
    return this.#tree;
  }

  /** Every entry committed so far, in seq order. */
  get log(): readonly LogEntry[] {
    return this.#log;
  }

  /** Append `changes` to the log, one entry each, in order. */
  async commit(changes: readonly BucketChange[]): Promise<void> {
    for (const { id, value } of changes) {
      const seq = this.#log.length;
      let op: LogEntry["op"] = "D";
      if (value === null) {
        this.#live.delete(id);
      } else {
        op = this.#live.has(id) ? "U" : "I";
        this.#live.add(id);
      }
      const entry = {
        lsn: `lsn-${seq}`,
        commit_ts: "2026-01-01T00:00:00.000Z",
        op,
        collection: this.collection,
        doc_id: id,
        session: "ssn001",
        seq,
        ...(value !== null && { after: value }),
      } as LogEntry;
      await this.storage.put(logObjectKey(this.prefix, seq), encodeJsonBytes(entry), {
        ifNoneMatch: "*",
      });
      this.#log.push(entry);
    }
  }

  /**
   * Publish the canonical tree of the rows through `through` (the whole
   * log by default), then move the head to it unless `crash`.
   */
  async fold(options: BucketFold = {}): Promise<void> {
    const through = options.through ?? this.#log.length;
    if (through < this.#floor || through > this.#log.length) {
      throw new Error(`tree bucket: cannot fold to ${through} from ${this.#floor}`);
    }
    const rows = this.rowsAt(through);
    const docs = [...rows.rows.values()].map((row) => canonicalDocument(row, "bucket row"));
    const plan = await buildTree(docs, this.#key, this.config);
    this.#attempts += 1;
    const sealed = await sealTree(plan, {
      prefix: this.prefix,
      attempt: this.#attempts.toString(16).padStart(32, "0"),
      floor: through,
    });
    for (const level of sealed.levels) {
      for (const node of level) {
        await this.storage.put(node.key, node.bytes, { ifNoneMatch: "*" });
      }
    }
    if (options.crash === true) {
      return;
    }
    this.#tree = sealed;
    this.#hasTree = true;
    this.#floor = through;
    this.#tailHint = Math.max(this.#tailHint, through);
    this.#rows = sealed.root?.summary.rows ?? 0;
    this.#bytes = sealed.root?.summary.bytes ?? 0;
    await this.#writeHead();
  }

  /** Rewrite the head with `tail_hint` set to `hint`, clamped to `[floor, tail]`. */
  async setTailHint(hint: number): Promise<void> {
    this.#tailHint = Math.min(Math.max(hint, this.#floor), this.#log.length);
    await this.#writeHead();
  }

  /** The logical oracle's rows through `targetSeq`. */
  rowsAt(targetSeq: number): LogicalView {
    return foldLogical({
      collection: this.collection,
      base: new Map(),
      baseSeq: 0,
      entries: this.#log,
      targetSeq,
    });
  }

  /** The logical oracle's rows a reader must see now: the whole log. */
  view(): LogicalView {
    return this.rowsAt(this.#log.length);
  }

  /** Every key and its bytes, for before/after comparison. */
  async image(): Promise<Map<string, string>> {
    const image = new Map<string, string>();
    for await (const entry of this.storage.list("")) {
      const got = await this.storage.get(entry.key);
      image.set(entry.key, got === null ? "<gone>" : got.body.toHex());
    }
    return image;
  }

  async #writeHead(): Promise<void> {
    const head = {
      ...logStateCurrentJson({
        log_seq_start: this.#floor,
        tail_hint: this.#tailHint,
        snapshot_rows: this.#rows,
        snapshot_bytes: this.#bytes,
      }),
      ...(this.#hasTree && {
        proto_tree: {
          root: this.#tree?.root?.key ?? null,
          gc_fence_epoch: 0,
          chunk_salt: TREE_TEST_CHUNK_SALT,
        },
      }),
    };
    await this.storage.put(treeHeadKey(this.prefix), encodeJsonBytes(head));
  }
}
