/**
 * Idempotent reconciliation for one secondary index.
 *
 * {@link rebuildIndex} folds the live `(snapshot, log_tail)` of a
 * collection into the doc set the writer's index emission would
 * have produced, then PUTs every missing index key and DELETEs every
 * orphaned one. Same-key zero-byte PUTs are no-ops (the entries are
 * content-addressed by composition); same-key DELETEs are
 * contractually idempotent.
 *
 * Invariants:
 *
 *   - **Re-running on a healthy index is a no-op.** `added = 0`,
 *     `removed = 0`.
 *   - **Re-running after a crashed mid-commit** reconciles toward
 *     the live `current.json` view — orphans deleted, missing keys
 *     PUT.
 *   - **Re-running while writes are in flight** is safe up to a
 *     race window: a write that lands during the rebuild may
 *     produce a transient "orphan" the rebuild sweeps, which the
 *     next live write then re-PUTs. The race converges on the next
 *     commit.
 *
 * The function reads the same fold the writer / reader use
 * (snapshot via {@link loadSnapshotAsMap}; log tail by direct
 * `get(<logPrefix>/log/<seq>.json)`) so it MUST agree with the
 * writer on the live doc set by construction.
 *
 * @see ./indexes.ts — `IndexDefinition`, `allIndexKeysFor`,
 *      `indexKeyPrefix`.
 * @see ./writer.ts — the fence-time emission path this
 *      command reconciles.
 */

import {
  BaerlyError,
  type DocumentData,
  logSeqStartOf,
  readCurrentJson,
  type Storage,
} from "@baerly/protocol";
import { loadSnapshotAsMap } from "./snapshot.ts";
import { allIndexKeysFor, type IndexDefinition, indexKeyPrefix } from "./indexes.ts";
import { foldLogEntriesOnto, walkLogRange } from "./log-walk.ts";

const EMPTY_BODY = new Uint8Array(0);
const APPLICATION_JSON = "application/json";

/**
 * Reconciliation summary.
 *
 * In a normal (mutating) run, the counts describe what was actually
 * PUT / DELETEd. In `dryRun` mode ({@link RebuildIndexOptions.dryRun}),
 * `added` / `removed` report the counts that a real rebuild *would*
 * have produced — storage is unchanged. `kept` counts pre-existing
 * intersection keys (`expected ∩ actual`) at function entry. In a real
 * run, `kept` may also include keys promoted from `added` via the
 * Conflict-race fallback (a PUT with `ifNoneMatch:"*"` returned 412
 * because a peer wrote the same key first, so the key was already
 * in place by the time we observed it); dryRun mode never issues
 * those PUTs and therefore does not observe that race.
 */
export interface RebuildIndexResult {
  /**
   * Keys PUT because they were missing on storage. In `dryRun` mode,
   * the predicted PUT count — no writes were issued.
   */
  readonly added: number;
  /**
   * Keys DELETEd because the doc no longer exists / no longer projects
   * them. In `dryRun` mode, the predicted DELETE count — no deletes
   * were issued.
   */
  readonly removed: number;
  /** Keys already in place. The healthy-index re-run reports this as the full expected count. */
  readonly kept: number;
}

/**
 * Optional knobs accepted by {@link rebuildIndex}. Every field is
 * optional; the function behaves identically to the older
 * positional-arg shape when `opts` is omitted.
 *
 * @public — surfaced from `baerly-storage` so admin tooling and the
 *   observability layer can opt in.
 */
export interface RebuildIndexOptions {
  /**
   * Cancellation signal. Forwarded to every storage `list` call so
   * long-running rebuilds over large collections can be cut short
   * by admin tooling. Storage `get` / `put` / `delete` calls inside
   * the reconciliation loop do not currently honour the signal
   * (the per-call durations are short enough that cooperative
   * cancellation between calls suffices); future tightening can
   * forward it through without breaking callers.
   */
  readonly signal?: AbortSignal;
  /**
   * When `true`, walk the expected-vs-actual diff and return the
   * counts that a real rebuild would have produced WITHOUT issuing
   * any PUT or DELETE. Used by `baerly admin fsck --indexes`
   * to report drift cheaply. Defaults to `false`.
   *
   * `kept` is reported as the pre-existing intersection
   * (`expected ∩ actual`); a real run can additionally fold
   * Conflict-race-demoted PUTs into `kept`, which dryRun does not
   * observe. See {@link RebuildIndexResult}.
   */
  readonly dryRun?: boolean;
}

/**
 * Idempotently reconcile one secondary index for one collection.
 *
 * @param storage         Storage handle (any in-tree `Storage`).
 * @param currentJsonKey  The collection's `current.json` key.
 * @param def             The index to reconcile. Single-field today;
 *                        composite definitions are accepted by the
 *                        key encoder but the read path only consults
 *                        single-field keys.
 * @param opts            Optional knobs — see {@link RebuildIndexOptions}.
 *                        Strictly additive: existing positional-arg
 *                        callers compile and behave unchanged when
 *                        omitted.
 *
 * @throws BaerlyError code="InvalidResponse" — `current.json` missing.
 * @throws BaerlyError code="Internal" — protocol-invariant
 *   violation (snapshot hash mismatch, missing log entry inside
 *   `[log_seq_start, next_seq)`).
 */
export const rebuildIndex = async (
  storage: Storage,
  currentJsonKey: string,
  def: IndexDefinition,
  opts: RebuildIndexOptions = {},
): Promise<RebuildIndexResult> => {
  const read = await readCurrentJson(storage, currentJsonKey);
  if (read === null) {
    throw new BaerlyError(
      "InvalidResponse",
      `rebuildIndex: current.json missing at ${JSON.stringify(currentJsonKey)}`,
    );
  }
  const lastSlash = currentJsonKey.lastIndexOf("/");
  if (lastSlash < 0) {
    throw new BaerlyError(
      "InvalidResponse",
      `rebuildIndex: currentJsonKey ${JSON.stringify(currentJsonKey)} must contain "/"`,
    );
  }
  const tablePrefix = currentJsonKey.slice(0, lastSlash);
  const collection = tablePrefix.slice(tablePrefix.lastIndexOf("/") + 1);
  const logSeqStart = logSeqStartOf(read.json);
  const nextSeq = read.json.next_seq;

  // 1. Build the live doc set by folding snapshot + log tail.
  //    Same shape the reader uses in `runRead` and the CLI uses in
  //    `doCopy`.
  const live =
    read.json.snapshot === null
      ? new Map<string, DocumentData>()
      : await loadSnapshotAsMap(storage, read.json.snapshot, collection);
  const entries = await walkLogRange(storage, tablePrefix, logSeqStart, nextSeq);
  foldLogEntriesOnto(live, entries, { collection });

  // 2. Compute the expected index-key set.
  const expected = new Set<string>();
  for (const [docId, body] of live) {
    for (const k of allIndexKeysFor(tablePrefix, [def], body, docId)) {
      expected.add(k);
    }
  }

  // 3. List actual keys under the index prefix. Forward the abort
  //    signal so admin tooling can cut short a rebuild over a huge
  //    collection; the storage `list` contract is the only step
  //    here that's unbounded in cost.
  const actual = new Set<string>();
  const listOpts: { signal?: AbortSignal } = {};
  if (opts.signal !== undefined) {
    listOpts.signal = opts.signal;
  }
  for await (const entry of storage.list(indexKeyPrefix(tablePrefix, def.name), listOpts)) {
    actual.add(entry.key);
  }

  // 4. Reconcile: PUT what's missing, DELETE what's orphaned.
  //    `ifNoneMatch:"*"` makes a same-key re-issue no-op; on the
  //    rare race where the entry already exists, swallow the 412 and
  //    count it as `kept` rather than `added`.
  //
  //    Under `opts.dryRun`, we walk the same diff but skip every
  //    mutating storage call — `added` / `removed` then report the
  //    counts a real rebuild WOULD have produced, leaving storage
  //    untouched. This is what `baerly admin fsck --indexes`
  //    consumes to surface drift without paying the rebuild cost.
  const dryRun = opts.dryRun === true;
  let added = 0;
  let removed = 0;
  let kept = 0;
  for (const k of expected) {
    if (actual.has(k)) {
      kept += 1;
      continue;
    }
    if (dryRun) {
      added += 1;
      continue;
    }
    try {
      await storage.put(k, EMPTY_BODY, {
        ifNoneMatch: "*",
        contentType: APPLICATION_JSON,
      });
      added += 1;
    } catch (error) {
      // 412 = a peer wrote the entry between our `list` and our
      // PUT. The entry exists; we couldn't have written different
      // bytes (zero-byte body); count it as kept and move on.
      if (error instanceof BaerlyError && error.code === "Conflict") {
        kept += 1;
      } else {
        throw error;
      }
    }
  }
  for (const k of actual) {
    if (expected.has(k)) {
      continue;
    }
    if (dryRun) {
      removed += 1;
      continue;
    }
    // Storage.delete is contractually idempotent — no defensive catch.
    await storage.delete(k);
    removed += 1;
  }
  return { added, removed, kept };
};
