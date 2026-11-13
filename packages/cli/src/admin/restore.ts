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
 * same seq; the stale ledger's pending depth no longer describes this
 * collection either. A missing ledger is a no-op.
 *
 * Cost shape: before any in-band maintenance triggered by a long import,
 *   the base billable shapes are fresh non-empty `N + 2` (initial seed,
 *   one committing `log/<seq>` create per row, final `tail_hint` stamp),
 *   force non-empty `N + 2 + P`, fresh empty `1`, and force empty
 *   `1 + P`, where `P` is the number of provider LIST pages consumed by
 *   the one `Storage.list()` iterator in `tailFromListedLogKeys`.
 *   Maintenance adds the same measured profile overhead as the main
 *   cost model.
 *
 * Partial-restore semantics: validation is per row, in stream order. A
 * line that fails (bad JSON, missing/duplicate/invalid-domain `_id`, or a
 * storage error) stops the run; rows BEFORE it stay committed, that line
 * and later ones are not, and the error message says how many rows
 * committed. The final `tail_hint` stamp may not have landed. Restore
 * again into a fresh target, or with `--force`. A whole-stream pre-pass
 * is deliberately not done (stdin is a stream). `_id`s are never
 * rewritten.
 *
 * Exit codes:
 *   0 — every row committed.
 *   1 — InvalidConfig (bad bucket URI, missing args, duplicate `_id`, or
 *       an `_id` outside the write domain: key-segment rule + NFC).
 *   2 — Network / storage error mid-stream, or a malformed NDJSON
 *       line (raised as a plain `Error`, not `BaerlyError`).
 *   3 — AlreadyExists from a pre-existing target without --force, or a
 *       WriteConflict from a lost `current.json` CAS against
 *       maintenance/compaction during --force.
 */

import { createInterface } from "node:readline";
import { type ArgsDef } from "citty";
import {
  assertCurrentJsonTransition,
  assertDocumentValues,
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
import { assertDocId, Writer } from "@baerly/server/_internal/testing";
import { parseBucketUri } from "../bucket-uri.ts";
import { emitSuccess } from "../output.ts";
import {
  APP_ARG,
  assertCollectionArg,
  assertWritableNames,
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
    description: "Reseed the target when it already exists.",
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
    description:
      "Bulk-import canonical NDJSON into a fresh collection. Validates per row: rows before a failing line stay committed, and the error reports the count (re-run into a fresh target or with --force). Duplicate or non-NFC/invalid _ids are refused, never rewritten.",
  },
  args: RESTORE_ARGS,
  handler: async (args, ctx) => {
    const bucket = await parseBucketUri(args.bucket);
    const { app, tenant } = await ctx.resolveAppTenant({ app: args.app, tenant: args.tenant });
    assertCollectionArg(args.collection, "baerly admin restore");
    assertWritableNames({ app, tenant, collection: args.collection }, "baerly admin restore");
    const currentJsonKey = `${bucket.keyPrefix}app/${app}/tenant/${tenant}/manifests/${args.collection}/current.json`;
    const collectionPrefix = collectionPrefixOf(currentJsonKey);
    const pendingKey = gcPendingKey(collectionPrefix);

    let baseSeq = 0;
    const head = await readCurrentJson(bucket.storage, currentJsonKey);
    if (head !== null && args.force !== true) {
      throw new BaerlyError(
        "AlreadyExists",
        `baerly admin restore: collection ${JSON.stringify(args.collection)} (app ${JSON.stringify(app)}, tenant ${JSON.stringify(tenant)}) already exists; pass --force to truncate it`,
        {
          resolution:
            "Pass --force to truncate the existing collection, or restore into an empty target.",
        },
      );
    }
    if (head !== null) {
      // --force: reseed `current.json` above the old tail under
      // If-Match. The If-Match guards against a concurrent COMPACTOR
      // (the only steady-state writer of `current.json` under
      // single-write commit) landing between our read and our PUT —
      // that surfaces WriteConflict (exit 3). It does NOT fence concurrent
      // WRITERS: under single-write commit writers never touch
      // `current.json`, so the dormant `writer_fence` epoch is no
      // longer consulted. `restore` therefore assumes operational
      // exclusivity — do not run it against a collection taking live
      // writes. (We still bump the fence epoch to keep the field
      // monotone, but nothing reads it.)
      //
      // That contract covers concurrent MAINTENANCE PASSES too, not only
      // concurrent writers, and `runScheduledMaintenance` fires them on a
      // cron independent of writes — so "no live writes" is not by
      // itself enough. A GC pass reads `current.json` once at its top and
      // never re-reads it before issuing its sweep DELETEs, so a pass
      // that started before this reseed carries the pre-reseed floor
      // all the way through and, if a legacy ledger hands it `stale-log`
      // candidates, can delete log objects the reseed below re-creates.
      // The ledger clear does not close that window: such a pass loaded
      // its candidates into memory before the clear landed. A concurrent
      // `retireLogRange` is fenced instead of raced — it recomputes its
      // range inside the CAS mutator, so a reseed that lands first makes
      // it abort with `WriteConflict` and zero DELETEs.
      //
      // CRITICAL: stale log entries from the old generation still
      // live on disk under `log/<seq>.json` paths. The writer's
      // `If-None-Match: "*"` log PUT will 412 if we restart `tail_hint`
      // at 0 and collide with `log/0.json`. We instead advance
      // `tail_hint` and `log_seq_start` past the old data so new
      // commits land at fresh sequence numbers and the old log files
      // become unreferenced orphans (computed-range retirement reclaims
      // them once the new generation's fold floor advances past them).
      // Do this from LISTed log keys, not
      // by folding the old log bodies: `--force` must be able to recover
      // from malformed old entries, and a hole must not make us
      // under-shoot a later old entry.
      const truncatedNext = await tailFromListedLogKeys(bucket.storage, collectionPrefix);
      baseSeq = truncatedNext;
      // FLOOR EXEMPTION — deliberate. `casUpdateCurrentJson` rejects any
      // write that lowers `log_seq_start`; this PUT is not routed through
      // it, so `--force` can reseed BELOW the old floor. The compactor's
      // fold CAS also bypasses that helper, but calls the shared transition
      // validator directly before publication. `--force` is the only path
      // that intentionally lowers the floor.
      //
      // Why lowering is sound. `truncatedNext` is strictly greater than
      // every log object still on the bucket, so the writer's committing
      // `log/<seq>` create cannot collide with an old-generation object —
      // that 412 hazard is the whole point of the reseed (see above). It
      // can land below the old FOLD floor whenever the surviving log
      // objects stop short of it. Retirement is budget-bounded, so it
      // normally leaves a contiguous suffix and `truncatedNext` reaches
      // the fold floor — but two paths break that. A pass that crashes
      // between its floor CAS and the end of its DELETE loop leaves an
      // arbitrary subset of the authorized range behind
      // (`log-retention.ts`: leak, never corruption), and a failed
      // phantom cleanup on the `AmbiguousCommit` path leaves an isolated
      // sub-floor object. So fold floor 12 with `log/8` and `log/9`
      // retained and `log/10`, `log/11` gone is reachable, yielding
      // `truncatedNext` 10 < 12.
      //
      // Nothing is lost by that. Readers never see the survivors: they
      // walk from the new floor, and `fsck` bounds itself by listed keys,
      // so sub-floor objects produce no findings. The truncate is complete
      // with respect to every reader, which is what truncating means.
      //
      // It is not complete with respect to BYTES, and deliberately so.
      // Resetting `snapshot` to `null` makes the whole old generation
      // unreachable. The surviving sub-floor `log/` objects are reclaimed
      // by computed-range retirement once the new generation's fold floor
      // advances past them — the reseed literal below omits
      // `log_delete_floor`, so it decodes to 0 and the computed range
      // starts there, covering every survivor. Legacy `content/<sha>.json`
      // side objects stay put: no kernel reader opens one, so they are
      // inert, and an operator who wants the bytes back deletes the prefix
      // directly (`docs/guide/backups.md`).
      //
      // Do not "repair" this with `Math.max`; that reseeds a floor above
      // `tail_hint`, trips `assertCurrentJson`, and breaks truncate.
      // `restore.test.ts` pins both the empty-prefix and partial-sweep
      // cases.
      // `log_delete_floor` IS DELIBERATELY ABSENT from this literal. Do not
      // "repair" that with `...head.json`.
      //
      // Dropping it is the correct truncate semantics: the field is the
      // exclusive upper bound of the contiguous log prefix certified
      // deleted. A truncate starts a new generation, so its certification
      // resets to "no deleted prefix is certified."
      //
      // Carrying it forward is not merely redundant, it is unsound. This PUT
      // is the one `current.json` writer that does not call
      // `assertCurrentJsonTransition` (invariant 12 names it as the deliberate
      // exemption), so a carried floor is published UNCHECKED. A reseed can
      // land below the old delete floor only when the certified old prefix —
      // potentially the entire old log — is gone. With no surviving log
      // objects, LIST yields `truncatedNext = 0`; restored rows then reuse
      // slots below the old floor. Carrying that old-generation certificate
      // would store `log_delete_floor > log_seq_start`, which the very next
      // validated write rejects — in practice this command's own post-reseed
      // tail stamp. `restore.test.ts` pins the empty-old-log case, the field
      // omission, and the subsequent validated transition.
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
      // same seq; the ledger's pending depth no longer describes this
      // collection either. Clear it before the
      // writer's first commit below — write-tick maintenance runs
      // `runGc` inline (CF-free profile, `gcInterval = 4`), so a GC
      // pass can happen during the restore itself. `Storage.delete` is
      // idempotent (404 ⇒ no-op) per the `Storage` contract, so this is
      // safe whether or not a ledger exists.
      await bucket.storage.delete(pendingKey);
    } else {
      // Fresh target: seed `current.json` with `tail_hint=0`. This literal
      // omits `log_delete_floor` too, and correctly: it routes through
      // `createCurrentJson`, so no transition rule applies, and "no deleted
      // prefix is certified" is exactly what an absent field decodes to.
      // Named here so a sweep for missing-field sites stops rather than
      // adding it.
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
    const seenIds = new Map<string, number>();
    // Every failure past this point says how many rows are already
    // durable, so the operator knows what the target now holds.
    const committedNote = (when = "before this line"): string =>
      `; ${count} row${count === 1 ? "" : "s"} committed ${when} (they remain in the target; restore again into a fresh target, or with --force)`;
    const idFix =
      "Restore never rewrites an _id. Fix the dump line, or rewrite it to a fresh NFC _id that is not canonically equivalent to the original.";
    // Catch iterator failures separately from validation and commit failures,
    // which already carry their line-specific progress (or ambiguity range).
    const lines = (async function* () {
      try {
        yield* rl;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        failure.message += committedNote("before input failed");
        throw failure;
      }
    })();
    try {
      for await (const line of lines) {
        lineNo++;
        if (line.length === 0) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          // Malformed NDJSON mid-stream → exit 2. Bare `Error` (not
          // `BaerlyError`) routes through the helper's "unknown" arm.
          throw new Error(
            `baerly admin restore: line ${lineNo} is not valid JSON: ${(error as Error).message}${committedNote()}`,
            { cause: error },
          );
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error(
            `baerly admin restore: line ${lineNo} is not a JSON object${committedNote()}`,
          );
        }
        const row = parsed as Record<string, unknown>;
        const id = row["_id"];
        if (typeof id !== "string" || id.length === 0) {
          const fix = "Add a non-empty string _id to the dump line.";
          throw new BaerlyError(
            "InvalidConfig",
            `baerly admin restore: line ${lineNo} missing non-empty string _id${committedNote()}. ${fix}`,
            { resolution: fix },
          );
        }
        const firstLine = seenIds.get(id);
        if (firstLine !== undefined) {
          throw new BaerlyError(
            "InvalidConfig",
            `baerly admin restore: line ${lineNo} repeats _id ${JSON.stringify(id)} first seen on line ${firstLine}${committedNote()}. ${idFix}`,
            { resolution: idFix },
          );
        }
        try {
          assertDocId(id);
        } catch (error) {
          throw new BaerlyError(
            "InvalidConfig",
            `baerly admin restore: line ${lineNo} has an invalid _id ${JSON.stringify(id)}: ${(error as Error).message}${committedNote()}. ${idFix}`,
            { cause: error, resolution: idFix },
          );
        }
        seenIds.set(id, lineNo);
        // Document-value domain: JSON.parse can still yield a value the
        // write path refuses (`1e999` parses to Infinity).
        try {
          assertDocumentValues(row, "restore");
        } catch (error) {
          if (error instanceof BaerlyError) {
            throw new BaerlyError(
              "InvalidConfig",
              `baerly admin restore: line ${lineNo} (_id ${JSON.stringify(id)}) has an invalid document: ${error.message}${committedNote()}${error.resolution === undefined ? "" : `. ${error.resolution}`}`,
              { cause: error, resolution: error.resolution },
            );
          }
          throw error;
        }

        // Pass the full object as the body — `_id` is part of the
        // body in the doc shape, and the writer keys on `docId`
        // separately.
        const body = row as unknown as DocumentData;
        try {
          await writer.commit({
            op: "I",
            collection: args.collection,
            docId: id,
            body,
          });
        } catch (error) {
          if (error instanceof Error) {
            if ((error as { code?: unknown }).code === "AmbiguousCommit") {
              // The committing create's fate is unresolved: line N may
              // already be durable, so the count is a range, not a figure.
              error.message += `; line ${lineNo} may or may not be committed (between ${count} and ${count + 1} rows are in the target); restore again with --force to get an exact copy of the dump`;
            } else {
              error.message += `; line ${lineNo} was not committed${committedNote()}`;
            }
          }
          throw error;
        }
        count++;
      }
    } finally {
      rl.close();
    }
    // Stamp the final `tail_hint` durably. Under single-write commit the
    // writer never advances the hint (it's compactor-advanced) — but a
    // bulk restore knows exactly how many rows it wrote, so it stamps the
    // true tail (`baseSeq + count`) under If-Match so the restored bucket
    // reads efficiently without a forward-probe. A concurrent compactor
    // between our last commit and this stamp surfaces WriteConflict (exit 3).
    // CLAMP: `tail_hint` is a monotone lower bound, so never stamp it
    // BELOW what is already durable — take the max of our computed tail,
    // the value already stored, and `log_seq_start`. (Defends against a
    // compactor that advanced the hint between the reseed and here.)
    if (count > 0) {
      try {
        const afterLoad = await readCurrentJson(bucket.storage, currentJsonKey);
        if (afterLoad !== null) {
          const clampedTail = Math.max(
            baseSeq + count,
            afterLoad.json.tail_hint,
            afterLoad.json.log_seq_start,
          );
          const stamped: CurrentJson = { ...afterLoad.json, tail_hint: clampedTail };
          assertCurrentJsonTransition(afterLoad.json, stamped, currentJsonKey);
          await bucket.storage.put(currentJsonKey, encodeJsonBytes(stamped), {
            ifMatch: afterLoad.etag,
            contentType: "application/json",
          });
        }
      } catch (error) {
        // No retry: the If-Match stop-rule holds. All rows are durable;
        // only the read-efficiency hint is missing, and a rerun with
        // --force truncates the collection and restores it cleanly.
        throw new BaerlyError(
          error instanceof BaerlyError ? error.code : "NetworkError",
          `baerly admin restore: all ${count} row${count === 1 ? "" : "s"} were committed, but stamping tail_hint on current.json failed: ${(error as Error).message}. Rerun restore with --force to truncate and restore the dump again.`,
          { cause: error },
        );
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
