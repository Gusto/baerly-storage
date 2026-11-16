/**
 * Replay a collection's durable state into the live-document map a
 * reader sees. Property suites compare this against an in-memory model
 * after commits and maintenance passes.
 */

import { type DocumentData, logSeqStartOf, readCurrentJson, type Storage } from "@baerly/protocol";
import { probeTailFrom, loadSnapshotAsMap, walkLogRange } from "@baerly/server/_internal/kernel";
import { foldLogEntriesOnto } from "../../packages/server/src/log-walk.ts";

/**
 * The live documents of the collection under `prefix`
 * (`<…>/manifests/<collection>`), keyed by `_id`: the snapshot named by
 * `current.json`, then the strict `[log_seq_start, tail_hint)` log walk,
 * then the tolerant forward probe past `tail_hint` (a lower bound only,
 * under single-write commit). Mirrors what `runRead` folds.
 *
 * @throws when `current.json` is missing.
 */
export const replayLiveDocs = async (
  storage: Storage,
  prefix: string,
): Promise<Map<string, DocumentData>> => {
  const collection = prefix.slice(prefix.lastIndexOf("/") + 1);
  const read = await readCurrentJson(storage, `${prefix}/current.json`);
  if (read === null) {
    throw new Error(`current.json missing under ${prefix}`);
  }
  const live =
    read.json.snapshot === null
      ? new Map<string, DocumentData>()
      : await loadSnapshotAsMap(storage, read.json.snapshot, collection);
  const logSeqStart = logSeqStartOf(read.json);
  const hint = read.json.tail_hint;
  foldLogEntriesOnto(live, await walkLogRange(storage, prefix, logSeqStart, hint), { collection });
  const probe = await probeTailFrom(storage, prefix, Math.max(logSeqStart, hint));
  foldLogEntriesOnto(live, probe.entries, { collection });
  return live;
};
