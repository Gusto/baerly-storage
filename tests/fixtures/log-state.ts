/**
 * Single fixture builder for raw log state.
 *
 * baerly-storage commits writes as `log/<seq>.json` objects plus a
 * `current.json` pointer. Many tests need to seed that raw state
 * *directly* into `Storage` — bypassing the `Writer` — to exercise the
 * read / fold / maintenance paths against a known shape. This module is
 * the one place that knows how to construct that seed state, so a future
 * change to the on-disk format (the trailing integer's meaning, the key
 * shape) is a single edit here rather than a sweep across every test.
 *
 * The on-disk log-object key is built through `logObjectKey` from
 * `@baerly/protocol` — never hand-joined here. Callers pass a manifest
 * prefix (the `<…>/manifests/<collection>` segment) and a `seq`; this
 * builder owns the `/log/<seq>.json` join via the kernel helper.
 *
 * Two seed shapes:
 *   - {@link logStateCurrentJson} — a `CurrentJson` value with launch
 *     defaults, every field overridable. Pass it to `createCurrentJson`.
 *   - {@link seedLogEntry} / {@link seedLogEntries} — PUT raw
 *     `log/<seq>.json` object(s) carrying valid `LogEntry` bodies.
 *
 * NOT for driving the public write API: `writer.commit(...)` calls are
 * `CommitInput`-shaped and stay as-is. This builder only seeds the raw
 * storage state those writes would have produced.
 */

import {
  CURRENT_JSON_SCHEMA_VERSION,
  type CurrentJson,
  encodeJsonBytes,
  type LogEntry,
  logObjectKey,
  type Storage,
} from "@baerly/protocol";

/**
 * Build a `CurrentJson` with launch defaults. Every field is
 * overridable — pass the ones a given test cares about (commonly
 * `tail_hint` / `log_seq_start` / `writer_fence.owner`) and inherit the
 * rest.
 *
 * Defaults match a freshly-provisioned collection: no snapshot, an empty
 * log tail at seq 0, and a zero-epoch fence. Pass the result to
 * `createCurrentJson(storage, key, logStateCurrentJson(...))`.
 */
export const logStateCurrentJson = (overrides: Partial<CurrentJson> = {}): CurrentJson => ({
  schema_version: CURRENT_JSON_SCHEMA_VERSION,
  snapshot: null,
  tail_hint: 0,
  log_seq_start: 0,
  writer_fence: { epoch: 0, owner: "test", claimed_at: "" },
  snapshot_bytes: 0,
  snapshot_rows: 0,
  ...overrides,
});

/**
 * Build a valid `LogEntry` for sequence `seq`, with launch defaults that
 * satisfy the wire shape for an `I` op (the common seed case). Override
 * any field — `op` / `collection` / `doc_id` / `after` / `session` are
 * the usual ones. Internal: the seeders below build on it; export when a
 * test first needs the literal in hand rather than a PUT.
 */
const logStateEntry = (seq: number, overrides: Partial<LogEntry> = {}): LogEntry => ({
  lsn: `lsn-${seq}`,
  commit_ts: "2026-01-01T00:00:00.000Z",
  op: "I",
  collection: "c",
  doc_id: `d${seq}`,
  session: "ssn001",
  seq,
  ...overrides,
});

/**
 * PUT one raw `log/<seq>.json` object under `logPrefix` carrying a valid
 * `LogEntry`. `logPrefix` is the manifest prefix
 * (`<…>/manifests/<collection>`); the `/log/<seq>.json` join is owned by
 * `logObjectKey`. `overrides` are forwarded to {@link logStateEntry}.
 */
export const seedLogEntry = async (
  storage: Storage,
  logPrefix: string,
  seq: number,
  overrides: Partial<LogEntry> = {},
): Promise<LogEntry> => {
  const entry = logStateEntry(seq, overrides);
  await storage.put(logObjectKey(logPrefix, seq), encodeJsonBytes(entry));
  return entry;
};

/**
 * PUT a contiguous run of raw `log/<seq>.json` objects for
 * `[fromSeq, toExclusive)`. The optional `factory` maps a seq to per-entry
 * overrides (e.g. to vary `op` / `doc_id` / `after`); omit it for the
 * launch defaults from {@link logStateEntry}.
 */
export const seedLogEntries = async (
  storage: Storage,
  logPrefix: string,
  fromSeq: number,
  toExclusive: number,
  factory: (seq: number) => Partial<LogEntry> = () => ({}),
): Promise<void> => {
  for (let seq = fromSeq; seq < toExclusive; seq++) {
    await seedLogEntry(storage, logPrefix, seq, factory(seq));
  }
};
