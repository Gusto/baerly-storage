/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes; migrate threads it through
   the materialised view and the new snapshot body. */

/**
 * `migrateCollection` — schema-version fold over one collection.
 *
 * Loads the materialised view (snapshot + live-log tail), applies the
 * caller's `(row) => row | null` transform to every row, sorts the
 * surviving post-images by `_id`, encodes a fresh L9 snapshot, and
 * CAS-advances `current.json` to point at it. `migrated_to` on the
 * new pointer records the target schema version so a re-run with the
 * same `targetVersion` short-circuits.
 *
 * Cost shape: `1 GET current.json + 1 GET prior snapshot (if any) +
 * (next_seq - log_seq_start) GETs log + 1 PUT new snapshot + 1 CAS
 * PUT current.json`. The CLI command `baerly admin migrate` wraps
 * this primitive.
 *
 * The migrate is a one-shot consolidation: after a successful run the
 * entire log range becomes folded into the new snapshot, so
 * `log_seq_start === next_seq` on the new pointer. Subsequent
 * {@link runGc} sweeps the now-stale log keys. Operators must accept
 * that pending replicators reading past the migrated range may need
 * to resync from the new snapshot.
 */

import {
  type CurrentJson,
  type DocumentData,
  type Storage,
  type StoragePutOptions,
  BaerlyError,
  encodeJsonBytes,
  logSeqStartOf,
  readCurrentJson,
  snapshotHash,
} from "@baerly/protocol";
import {
  type SnapshotBody,
  encodeSnapshotBody,
  loadSnapshotAsMap,
  snapshotKey,
} from "./compactor.ts";
import { foldLogEntriesOnto, walkLogRange } from "./log-walk.ts";

const APPLICATION_JSON = "application/json";

export interface MigrateCollectionArgs {
  readonly storage: Storage;
  /** Full bucket-relative key of the CAS pointer for the target collection. */
  readonly currentJsonKey: string;
  /** Collection name — must match the on-disk `SnapshotBody.collection`. */
  readonly collection: string;
  /**
   * Pure-function row transform. Returning `null` deletes the row.
   * Re-runs MUST produce the same output for the same input — the
   * primitive may invoke the transform exactly once per row, but a
   * crashed run that re-CASes on retry assumes determinism.
   */
  readonly transform: (row: DocumentData) => DocumentData | null;
  /**
   * Target `schema_version` to stamp on the new pointer's
   * `migrated_to` field. A subsequent call with the same value on a
   * pointer already at `migrated_to === targetVersion` short-circuits
   * to a no-op.
   */
  readonly targetVersion: number;
  readonly signal?: AbortSignal;
}

export interface MigrateCollectionResult {
  /** Total rows in the materialised view before the transform ran. */
  readonly inputRows: number;
  /** Rows surviving the transform — `transform` returning `null` reduces this. */
  readonly outputRows: number;
  /** `null` iff a no-op short-circuit fired. Otherwise the new snapshot's key. */
  readonly newSnapshotKey: string | null;
  /** ETag of the (possibly unchanged) `current.json` after the run. */
  readonly newCurrentEtag: string;
  /**
   * `true` iff the run short-circuited because the pointer was
   * already at `migrated_to === targetVersion`. Callers can branch
   * on this to skip post-run announcements.
   */
  readonly noOp: boolean;
}

/**
 * Apply `transform` over every materialised row of `collection` and
 * write the result as a fresh L9 snapshot, advancing `current.json`
 * atomically via CAS.
 *
 * Idempotent: a re-run with the same `targetVersion` on a pointer
 * whose `migrated_to` already matches is a no-op (`noOp: true`).
 *
 * @throws BaerlyError code="InvalidConfig" — `current.json` missing
 *   (collection not provisioned), or `targetVersion` is negative /
 *   non-integer.
 * @throws BaerlyError code="SchemaError" — `transform` returned a
 *   value that is not a plain `DocumentData` and is not
 *   `null`. The migrate refuses to write an indeterminate body.
 * @throws BaerlyError code="Conflict" — CAS lost on the pointer
 *   advance. The new snapshot body remains on disk and will be swept
 *   by `runGc`; caller decides whether to retry the whole migrate.
 */
export const migrateCollection = async (
  args: MigrateCollectionArgs,
): Promise<MigrateCollectionResult> => {
  const { storage, currentJsonKey, collection, transform, targetVersion, signal } = args;
  if (!Number.isInteger(targetVersion) || targetVersion < 0) {
    throw new BaerlyError(
      "InvalidConfig",
      `migrateCollection: targetVersion must be a non-negative integer (got ${String(targetVersion)})`,
    );
  }

  // ── Step 1. Read current.json fresh; capture etag. ──────────────
  const read = await readCurrentJson(
    storage,
    currentJsonKey,
    signal !== undefined ? { signal } : undefined,
  );
  if (read === null) {
    throw new BaerlyError(
      "InvalidConfig",
      `migrateCollection: current.json not found at ${currentJsonKey}`,
    );
  }
  const current = read.json;
  const baseEtag = read.etag;

  // Idempotent short-circuit. `migrated_to` semantics are
  // monotonically-bumping; a run targeting a version <= the recorded
  // one is also a no-op (already-migrated past it).
  if (current.migrated_to !== undefined && current.migrated_to >= targetVersion) {
    return {
      inputRows: 0,
      outputRows: 0,
      newSnapshotKey: null,
      newCurrentEtag: baseEtag,
      noOp: true,
    };
  }

  const tablePrefix = currentJsonKey.slice(0, currentJsonKey.lastIndexOf("/"));
  const logSeqStartBefore = logSeqStartOf(current);
  const nextSeq = current.next_seq;

  // ── Step 2. Load the prior snapshot (if any) as the fold base. ──
  const base =
    current.snapshot === null
      ? new Map<string, DocumentData>()
      : await loadSnapshotAsMap(storage, current.snapshot, collection, signal);

  // ── Step 3. Apply the live-log tail onto `base`. ────────────────
  const entries = await walkLogRange(
    storage,
    tablePrefix,
    logSeqStartBefore,
    nextSeq,
    signal !== undefined ? { signal } : undefined,
  );
  foldLogEntriesOnto(base, entries, { collection });

  // ── Step 4. Run the transform. Drop nulls; reject non-objects. ──
  const inputRows = base.size;
  const transformed = new Map<string, DocumentData>();
  for (const [id, row] of base) {
    const next = transform(row);
    if (next === null) {
      continue;
    }
    if (next === undefined || typeof next !== "object" || Array.isArray(next)) {
      throw new BaerlyError(
        "SchemaError",
        `migrateCollection: transform on row ${JSON.stringify(id)} returned a non-object (got ${describeNonObject(
          next,
        )})`,
      );
    }
    transformed.set(id, next);
  }

  // ── Step 5. Build canonical snapshot body. ──────────────────────
  // `min_seq: 0`, `max_seq: nextSeq` — the new snapshot covers
  // [0, nextSeq); the live log becomes empty (log_seq_start === nextSeq).
  const sortedDocs = Array.from(transformed.entries())
    .toSorted(([a], [b]) => {
      if (a < b) {
        return -1;
      }
      if (a > b) {
        return 1;
      }
      return 0;
    })
    .map(([id, body]) => ({ _id: id, body }));
  const snapshotBody: SnapshotBody = {
    schema_version: 1,
    min_seq: 0,
    max_seq: nextSeq,
    collection,
    docs: sortedDocs,
  };
  const bodyBytes = encodeSnapshotBody(snapshotBody);
  const sha256 = await snapshotHash(bodyBytes);
  const newSnapshotKey = snapshotKey(tablePrefix, 0, nextSeq, sha256);

  // ── Step 6. PUT the snapshot (content-addressed; idempotent). ───
  const putOpts: StoragePutOptions = {
    contentType: APPLICATION_JSON,
    ...(signal !== undefined && { signal }),
  };
  await storage.put(newSnapshotKey, bodyBytes, putOpts);

  // ── Step 7. CAS-advance current.json. ───────────────────────────
  const next: CurrentJson = {
    ...current,
    snapshot: newSnapshotKey,
    log_seq_start: nextSeq,
    migrated_to: targetVersion,
  };
  const nextBody = encodeJsonBytes(next);
  const casOpts: StoragePutOptions = {
    ifMatch: baseEtag,
    contentType: APPLICATION_JSON,
    ...(signal !== undefined && { signal }),
  };
  let putResult: { readonly etag: string };
  try {
    putResult = await storage.put(currentJsonKey, nextBody, casOpts);
  } catch (error) {
    if (error instanceof BaerlyError && error.code === "Conflict") {
      throw new BaerlyError(
        "Conflict",
        `migrateCollection: CAS lost on ${currentJsonKey}; retry the whole migrate (transform is deterministic)`,
        error,
      );
    }
    throw error;
  }
  return {
    inputRows,
    outputRows: transformed.size,
    newSnapshotKey,
    newCurrentEtag: putResult.etag,
    noOp: false,
  };
};

// Build a human-readable label for the "transform returned a non-object"
// error. `null`, arrays, and the bare `undefined` need to be
// disambiguated from `typeof`'s default "object".
const describeNonObject = (v: unknown): string => {
  if (v === undefined) {
    return "undefined";
  }
  if (Array.isArray(v)) {
    return "array";
  }
  return typeof v;
};
