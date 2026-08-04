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
 * Side effect: both reseed branches also delete any leftover
 * `gc/pending.json` for the collection before the first row commits. A
 * candidate marked before the reseed names a key from the old
 * incarnation of the log, which the commits below may re-create at the
 * same seq; the stale ledger's rotation cursors and pending depth no
 * longer describe this collection either. A missing ledger is a no-op.
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
  gcPendingKey,
  mintGeneration,
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
import { collectionPrefixOf } from "./usage.ts";

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
    const collectionPrefix = collectionPrefixOf(currentJsonKey);
    const pendingKey = gcPendingKey(collectionPrefix);

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
      // That contract covers concurrent GC PASSES too, not only
      // concurrent writers, and `runScheduledMaintenance` fires GC on a
      // cron independent of writes — so "no live writes" is not by
      // itself enough. A pass reads `current.json` once at its top and
      // never re-reads it before issuing its sweep DELETEs, so a pass
      // that started before this reseed carries the pre-reseed floor
      // all the way through and can delete log objects the reseed
      // below re-creates. The ledger clear does not close that window:
      // such a pass loaded its candidates into memory before the clear
      // landed.
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
      const truncatedNext = await tailFromListedLogKeys(bucket.storage, collectionPrefix);
      baseSeq = truncatedNext;
      // FLOOR EXEMPTION — deliberate. `casUpdateCurrentJson` rejects any
      // write that lowers `log_seq_start`; this PUT is not routed through
      // it, so `--force` can reseed BELOW the old floor. (The compactor's
      // fold CAS also bypasses that helper, but it is monotone by
      // construction — it validates its seq-arithmetic options at the
      // seam rather than asserting the floor at the fold. `--force` is
      // the only path that intentionally lowers the floor.)
      //
      // Why lowering is sound. `truncatedNext` is strictly greater than
      // every log object still on the bucket, so the writer's committing
      // `log/<seq>` create cannot collide with an old-generation object —
      // that 412 hazard is the whole point of the reseed (see above). It
      // can land below the old floor whenever GC has swept the objects at
      // the top of the old range but not all of them: the sweep is
      // budget-bounded and walks `log/` in lex order (`0,1,10,11,2,...`),
      // so sub-floor objects routinely survive a pass. Old floor 12 with
      // `log/8`, `log/9` left behind yields `truncatedNext` 10 < 12.
      //
      // Nothing is lost by that. GC decides content liveness by
      // reachability, not by the floor: it keeps a hash iff the hash is
      // reachable from the current snapshot or from `[log_seq_start,
      // tail)` (see `collectLiveContentHashes` in `gc.ts`). Resetting
      // `snapshot` to `null` here makes the whole old generation
      // unreachable, so its content is marked `orphan-content` and swept
      // after the grace period — which is precisely what truncating
      // means. Readers never see the survivors: they walk from the new
      // floor, and `fsck` bounds itself by listed keys, so orphans below
      // it produce no findings.
      //
      // Do not "repair" this with `Math.max`; that reseeds a floor above
      // `tail_hint`, trips `assertCurrentJson`, and breaks truncate.
      // `restore.test.ts` pins both the empty-prefix and partial-sweep
      // cases.
      const reseeded: CurrentJson = {
        schema_version: CURRENT_JSON_SCHEMA_VERSION,
        snapshot: null,
        // Also resets `tail_hint` unclamped, so an over-claimed old hint
        // moves DOWN here (unlike the final stamp below, which clamps).
        // Safe: the hint is a non-authoritative lower bound, and the
        // forward-probe finds the true tail regardless.
        tail_hint: truncatedNext,
        log_seq_start: truncatedNext,
        writer_fence: {
          epoch: head.json.writer_fence.epoch + 1,
          owner: RESTORE_OWNER,
          claimed_at: "",
        },
        snapshot_bytes: 0,
        snapshot_rows: 0,
        // New generation. This is the one write in the system that
        // lowers `log_seq_start`, so it is the one write that can leave
        // a live `/v1/since` cursor pointing above the floor but into a
        // dead generation. Re-minting here is what lets the next resume
        // on that cursor fail loudly (`SchemaError` → re-bootstrap)
        // instead of silently skipping the restored rows beneath it.
        generation: mintGeneration(),
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
      // Clear the GC ledger the old incarnation left behind. A
      // candidate marked before this reseed names a key from the
      // truncated log, which the commits below may re-create at the
      // same seq; the ledger's rotation cursors and pending depth no
      // longer describe this collection either. Clear it before the
      // writer's first commit below — write-tick maintenance runs
      // `runGc` inline (CF-free profile, `gcInterval = 4`), so a GC
      // pass can happen during the restore itself. `Storage.delete` is
      // idempotent (404 ⇒ no-op) per the `Storage` contract, so this is
      // safe whether or not a ledger exists.
      await bucket.storage.delete(pendingKey);
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
        // Mint here too, even though there is no old generation at this
        // key right now. A client can still hold a cursor from a
        // previous incarnation of this collection (dropped, then
        // restored), and `writer_fence.epoch` resets to 0 on this branch
        // — which is exactly why the epoch cannot serve as the
        // discriminator and a nonce can.
        generation: mintGeneration(),
      };
      await createCurrentJson(bucket.storage, currentJsonKey, seed);
      // Same clear as the `--force` branch above, for the case where
      // `current.json` is absent but a ledger is not. There is no
      // `admin drop` subcommand, so this is not a product path — it is
      // reachable by operator surgery (deleting `current.json` by hand,
      // or restoring into a prefix a previous collection used) and by a
      // partially-completed reseed. Cheap insurance rather than a case
      // the CLI can produce on its own; must land before the writer's
      // first commit either way.
      await bucket.storage.delete(pendingKey);
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
