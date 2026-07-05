/**
 * `baerly admin restore` — bulk-import NDJSON into a fresh collection.
 *
 * Reads NDJSON from stdin, reconstructs each row, and calls
 * `Writer.commit({op:"I"})` per row into the target bucket.
 * Programmatic callers (today: tests + the export round-trip
 * integration test) can divert the input by passing
 * `{ streams: { stdin } }` to {@link runRestore}. Idempotent on a fresh
 * bucket: re-running on a half-completed restore **refuses** unless
 * `--force` is set (which reseeds a fresh `current.json` above the old
 * tail first).
 *
 * Args:
 *   --bucket   Required. Target bucket URI.
 *   --app      Required (or via baerly.config.ts).
 *   --tenant   Required (or via baerly.config.ts).
 *   --collection Required. Target collection name.
 *   --force    Truncate the target if it exists (reseed above the old tail).
 *   --json     JSON envelope.
 *
 * stdin: NDJSON, one `{_id, ...}` row per line. Empty lines tolerated.
 *        EOF terminates.
 *
 * Cost shape: under single-write commit each `Writer.commit` is 2 Class
 *   A PUTs (content + the committing `log/<seq>` create — no per-row
 *   `current.json` write). So: 1 PUT current.json (initial seed) + N × 2
 *   + 1 PUT current.json (final `tail_hint` stamp) = 2N + 2 Class A ops
 *   for N rows.
 *
 * Partial-restore semantics: a mid-stream Network / Internal / parse
 * error leaves the target in a partial state (some rows committed,
 * `current.json` advanced to wherever the last successful commit
 * landed). Re-run with `--force` to truncate, or hand-clean. The
 * malformed-line case (missing `_id`, bad JSON) fails fast on that
 * line; rows committed BEFORE it survive.
 *
 * Exit codes:
 *   0 — every row committed.
 *   1 — InvalidConfig (bad bucket URI, missing args).
 *   2 — Network / storage error mid-stream, or a malformed NDJSON
 *       line (raised as a plain `Error`, not `BaerlyError`).
 *   3 — Conflict from a pre-existing target without --force, or from a
 *       concurrent writer when --force was used.
 */

import { createInterface } from "node:readline";
import { type ArgsDef } from "citty";
import {
  BaerlyError,
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  type CurrentJson,
  type DocumentData,
  encodeJsonBytes,
  readCurrentJson,
  type Storage,
} from "@baerly/protocol";
import { Writer } from "@baerly/server/_internal/testing";
import { parseBucketUri } from "../bucket-uri.ts";
import { emitSuccess } from "../output.ts";
import {
  APP_ARG,
  assertCollectionArg,
  defineBaerlySubcommand,
  JSON_ARG,
  TENANT_ARG,
} from "../subcommand.ts";

const RESTORE_OWNER = "baerly-restore";

const RESTORE_ARGS = {
  bucket: {
    type: "string",
    required: true,
    description: "Target bucket URI (s3://<bucket>[/<prefix>], file:///<abs>, memory://<bucket>)",
    valueHint: "bucket-uri",
  },
  app: APP_ARG,
  tenant: TENANT_ARG,
  collection: {
    type: "string",
    required: true,
    description: "Target collection name.",
    valueHint: "name",
  },
  force: {
    type: "boolean",
    description: "Truncate the target if it exists (bump fence + reseed current.json).",
  },
  json: JSON_ARG,
} as const satisfies ArgsDef;

const tailFromListedLogKeys = async (
  storage: Storage,
  collectionPrefix: string,
): Promise<number> => {
  const logPrefix = `${collectionPrefix}/log/`;
  let maxSeq = -1;
  for await (const entry of storage.list(logPrefix)) {
    const tail = entry.key.slice(logPrefix.length);
    const match = /^(\d+)\.json$/.exec(tail);
    if (match === null) {
      continue;
    }
    const seq = Number.parseInt(match[1]!, 10);
    if (Number.isFinite(seq) && seq > maxSeq) {
      maxSeq = seq;
    }
  }
  return maxSeq + 1;
};

const bundle = defineBaerlySubcommand({
  name: "admin.restore",
  meta: {
    description: "Bulk-import canonical NDJSON into a fresh collection.",
  },
  args: RESTORE_ARGS,
  handler: async (args, ctx) => {
    const bucket = await parseBucketUri(args.bucket);
    const { app, tenant } = await ctx.resolveAppTenant({ app: args.app, tenant: args.tenant });
    assertCollectionArg(args.collection, "baerly admin restore");
    const currentJsonKey = `${bucket.keyPrefix}app/${app}/tenant/${tenant}/manifests/${args.collection}/current.json`;

    let baseSeq = 0;
    const head = await readCurrentJson(bucket.storage, currentJsonKey);
    if (head !== null && args.force !== true) {
      throw new BaerlyError(
        "Conflict",
        `baerly admin restore: ${currentJsonKey} exists; pass --force to truncate`,
        undefined,
        undefined,
        undefined,
        "Pass --force to truncate the existing collection, or choose an empty target.",
        false,
      );
    }
    if (head !== null) {
      // --force: reseed `current.json` above the old tail under
      // If-Match. The If-Match guards against a concurrent COMPACTOR
      // (the only steady-state writer of `current.json` under
      // single-write commit) landing between our read and our PUT —
      // that surfaces Conflict (exit 3). It does NOT fence concurrent
      // WRITERS: under single-write commit writers never touch
      // `current.json`, so the dormant `writer_fence` epoch is no
      // longer consulted. `restore` therefore assumes operational
      // exclusivity — do not run it against a collection taking live
      // writes. (We still bump the fence epoch to keep the field
      // monotone, but nothing reads it.)
      //
      // CRITICAL: stale log entries from the old generation still
      // live on disk under `log/<seq>.json` paths. The writer's
      // `If-None-Match: "*"` log PUT will 412 if we restart `tail_hint`
      // at 0 and collide with `log/0.json`. We instead advance
      // `tail_hint` and `log_seq_start` past the old data so new
      // commits land at fresh sequence numbers and the old log files
      // become unreferenced orphans (the compactor / GC sweep them on
      // the next maintenance pass). Do this from LISTed log keys, not
      // by folding the old log bodies: `--force` must be able to recover
      // from malformed old entries, and a hole must not make us
      // under-shoot a later old entry.
      const collectionPrefix = currentJsonKey.slice(0, currentJsonKey.lastIndexOf("/"));
      const truncatedNext = await tailFromListedLogKeys(bucket.storage, collectionPrefix);
      baseSeq = truncatedNext;
      const reseeded: CurrentJson = {
        schema_version: CURRENT_JSON_SCHEMA_VERSION,
        snapshot: null,
        tail_hint: truncatedNext,
        log_seq_start: truncatedNext,
        writer_fence: {
          epoch: head.json.writer_fence.epoch + 1,
          owner: RESTORE_OWNER,
          claimed_at: "",
        },
        snapshot_bytes: 0,
        snapshot_rows: 0,
      };
      try {
        await bucket.storage.put(currentJsonKey, encodeJsonBytes(reseeded), {
          ifMatch: head.etag,
          contentType: "application/json",
        });
      } catch (error) {
        if (error instanceof BaerlyError) {
          throw error;
        }
        throw new BaerlyError(
          "NetworkError",
          `baerly admin restore: failed to reseed current.json: ${(error as Error).message}`,
        );
      }
    } else {
      // Fresh target: seed `current.json` with `tail_hint=0`.
      const seed: CurrentJson = {
        schema_version: CURRENT_JSON_SCHEMA_VERSION,
        snapshot: null,
        tail_hint: 0,
        log_seq_start: 0,
        writer_fence: { epoch: 0, owner: RESTORE_OWNER, claimed_at: "" },
        snapshot_bytes: 0,
        snapshot_rows: 0,
      };
      await createCurrentJson(bucket.storage, currentJsonKey, seed);
    }

    const writer = new Writer({ storage: bucket.storage, currentJsonKey });

    const input = ctx.streams?.stdin ?? process.stdin;
    const rl = createInterface({ input, crlfDelay: Infinity });
    let count = 0;
    let lineNo = 0;
    for await (const line of rl) {
      lineNo++;
      if (line.length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        // Malformed NDJSON mid-stream → exit 2 (the ticket's
        // partial-restore contract: the line that failed wasn't
        // committed, but anything BEFORE it survives). Bare `Error`
        // (not `BaerlyError`) routes through the helper's "unknown"
        // arm → exit 2.
        throw new Error(
          `baerly admin restore: line ${lineNo} is not valid JSON: ${(error as Error).message}`,
          { cause: error },
        );
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`baerly admin restore: line ${lineNo} is not a JSON object`);
      }
      const row = parsed as Record<string, unknown>;
      const id = row["_id"];
      if (typeof id !== "string" || id.length === 0) {
        throw new Error(`baerly admin restore: line ${lineNo} missing non-empty string _id`);
      }
      // Pass the full object as the body — `_id` is part of the
      // body in the doc shape, and the writer keys on `docId`
      // separately.
      const body = row as unknown as DocumentData;
      await writer.commit({
        op: "I",
        collection: args.collection,
        docId: id,
        body,
      });
      count++;
    }
    // Stamp the final `tail_hint` durably. Under single-write commit the
    // writer never advances the hint (it's compactor-advanced) — but a
    // bulk restore knows exactly how many rows it wrote, so it stamps the
    // true tail (`baseSeq + count`) under If-Match so the restored bucket
    // reads efficiently without a forward-probe. A concurrent compactor
    // between our last commit and this stamp surfaces Conflict (exit 3).
    // CLAMP: `tail_hint` is a monotone lower bound, so never stamp it
    // BELOW what is already durable — take the max of our computed tail,
    // the value already stored, and `log_seq_start`. (Defends against a
    // compactor that advanced the hint between the reseed and here.)
    if (count > 0) {
      const afterLoad = await readCurrentJson(bucket.storage, currentJsonKey);
      if (afterLoad !== null) {
        const clampedTail = Math.max(
          baseSeq + count,
          afterLoad.json.tail_hint,
          afterLoad.json.log_seq_start,
        );
        const stamped: CurrentJson = { ...afterLoad.json, tail_hint: clampedTail };
        await bucket.storage.put(currentJsonKey, encodeJsonBytes(stamped), {
          ifMatch: afterLoad.etag,
          contentType: "application/json",
        });
      }
    }
    emitSuccess({
      command: "admin.restore",
      status: "ok",
      collection: args.collection,
      restored: count,
    });
    return 0;
  },
});

/** citty `defineCommand` block for `baerly admin restore`. */
export const restoreCmd = bundle.cmd;

/**
 * Programmatic entry used by tests. Bypasses citty's `run` wrapper
 * (which would call `process.exit` and kill vitest) and returns the
 * integer exit code directly.
 */
export const runRestore = bundle.run;
