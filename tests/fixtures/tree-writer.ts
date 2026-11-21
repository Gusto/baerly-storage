/**
 * Commits to a tree collection through the real `Writer`, for tests that
 * write after a fold.
 *
 * Every commit runs under an observability context with in-band
 * maintenance disabled: the default write tick would run `compact()`
 * onto the tree head and replace the tree with a monolithic snapshot. A
 * raw `Writer.commit` reads no rows, so it never opens the head the way
 * the snapshot read path does, which refuses a head whose
 * `log_seq_start` moved without a snapshot. After each commit the head
 * is read back as a tree head, so a commit that disturbed it fails the
 * test at once.
 *
 * {@link TreeWriter.appendRaw} writes a `log/<seq>.json` entry the
 * `Writer` would refuse to commit (an invalid post-image, say), at the
 * next free seq, the way a pre-validation writer would have stored it,
 * provisioning a fresh head first when the collection has none.
 *
 * Test-only. NOT part of the protocol contract.
 */
import {
  type DocumentData,
  encodeJsonBytes,
  type LogEntry,
  logObjectKey,
  type Storage,
} from "@baerly/protocol";
import { findLogTail } from "@baerly/server/_internal/kernel";
import { createObservabilityContext } from "@baerly/server/_internal/observability";
import { Writer } from "@baerly/server/_internal/testing";
import { runWithContext } from "@baerly/server/observability";
import { readTreeHead, treeHeadKey } from "../../packages/server/src/tree/head.ts";
import { collectionOfPrefix } from "../../packages/server/src/tree/key.ts";
import { provisionCollection } from "./log-state.ts";

/** One row change: the row's new document, or `null` to delete it. */
export interface TreeWrite {
  readonly id: string;
  readonly value: DocumentData | null;
}

/** The real `Writer` over one tree collection. */
export class TreeWriter {
  readonly storage: Storage;
  readonly prefix: string;
  readonly collection: string;
  readonly #live = new Set<string>();

  constructor(storage: Storage, prefix: string) {
    this.storage = storage;
    this.prefix = prefix;
    this.collection = collectionOfPrefix(prefix);
  }

  /** Commit `writes` in order, one entry each: `I` for an absent `_id`, `U` for a live one, `D` for `null`. */
  async commit(writes: readonly TreeWrite[]): Promise<LogEntry[]> {
    const entries: LogEntry[] = [];
    for (const { id, value } of writes) {
      let op: LogEntry["op"] = "D";
      if (value !== null) {
        op = this.#live.has(id) ? "U" : "I";
      }
      const writer = new Writer({
        storage: this.storage,
        currentJsonKey: treeHeadKey(this.prefix),
      });
      const result = await runWithContext(
        createObservabilityContext({ maintenance: { disabled: true } }),
        () =>
          writer.commit({
            op,
            collection: this.collection,
            docId: id,
            ...(value !== null && { body: value }),
          }),
      );
      if (value === null) {
        this.#live.delete(id);
      } else {
        this.#live.add(id);
      }
      await this.#assertTreeHead();
      entries.push(result.entry);
    }
    return entries;
  }

  /** Store `fields` as the log entry at the next free seq, bypassing the `Writer`'s checks. */
  async appendRaw(fields: Partial<LogEntry> & Record<string, unknown>): Promise<number> {
    const head = await readTreeHead(this.storage, this.prefix);
    if (head === null) {
      await provisionCollection(this.storage, treeHeadKey(this.prefix));
    }
    const seq = await findLogTail(
      this.storage,
      this.prefix,
      Math.max(head?.json.log_seq_start ?? 0, head?.json.tail_hint ?? 0),
    );
    const entry = {
      lsn: `raw-${seq}`,
      commit_ts: "2026-01-01T00:00:00.000Z",
      collection: this.collection,
      session: "raw001",
      seq,
      ...fields,
    };
    await this.storage.put(logObjectKey(this.prefix, seq), encodeJsonBytes(entry), {
      ifNoneMatch: "*",
    });
    return seq;
  }

  async #assertTreeHead(): Promise<void> {
    const head = await readTreeHead(this.storage, this.prefix);
    if (head === null) {
      throw new Error(`tree writer: ${treeHeadKey(this.prefix)} is missing after a commit`);
    }
  }
}
