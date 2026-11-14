/**
 * Manifest and log read seams over a {@link Db}: the collection read
 * context the HTTP router drives, and the `current.json` / log reads the
 * `/v1/since` handler makes. Module functions rather than `Db` methods so
 * the manifest and probe types stay off the public `Db` class; reached
 * outside this package through `@baerly/server/_internal/kernel`.
 *
 * Kept apart from `./db.ts` so the HTTP entry imports these without
 * pulling in the `Db` class and the collection API.
 */

import {
  type BaerlyConfig,
  BaerlyError,
  certifiedDeleteFloor,
  type CurrentJson,
  type CurrentJsonRead,
  decodeJsonBytes,
  logDeleteFloorOf,
  logObjectKey,
  type LogEntry,
  logSeqStartOf,
  readCurrentJson,
  type SchemaValidator,
  type Storage,
} from "@baerly/protocol";
import { isOwnCollection } from "./collection-alias.ts";
import type { Db } from "./db.ts";
import { probeTailChunk, probeTailFrom, type TailProbeChunk } from "./log-tail.ts";
import { assertNameSegment } from "./path-segment.ts";
import type { CollectionReadContext } from "./query.ts";

/**
 * Physical-key prefix for a `(app, tenant)` pair. Trailing slash is
 * part of the prefix so a caller's `list("")` resolves to
 * `list("app/<app>/tenant/<tenant>/")` and cannot enumerate a sibling
 * tenant whose name shares a prefix.
 */
const physicalPrefixFor = (app: string, tenant: string): string => `app/${app}/tenant/${tenant}/`;

interface DbInternals {
  readonly storage: Storage;
  readonly schemas: ReadonlyMap<string, SchemaValidator>;
}

/** Private-field accessor, registered by the `Db` static block. */
let internalsOf: (db: Db<BaerlyConfig>) => DbInternals;

/** Called once, from the `Db` static block. */
export const registerDbInternals = (accessor: (db: Db<BaerlyConfig>) => DbInternals): void => {
  internalsOf = accessor;
};

/**
 * Build a freshly-seeded {@link CollectionReadContext} for `name`. The
 * HTTP router uses this so it can drive `runAllWithMeta` directly
 * (the return shape carries the manifest-pointer cursor used to
 * pack `_meta` onto the read response envelope). Application
 * callers should keep using
 * {@link Db.collection}; the chainable terminals destructure the cursor
 * out and discard it to keep the locked `Query<T>` signature.
 *
 * Runs the same `name`-validation guard as {@link Db.collection}.
 *
 * @throws BaerlyError code="InvalidConfig" when `name` is empty,
 *   contains `/`, is `"."` or `".."`, contains control characters,
 *   starts with the reserved `"_"` prefix, exceeds 256 bytes, or is
 *   not in Unicode Normalization Form C.
 * @internal
 */
export const collectionReadContext = (
  db: Db<BaerlyConfig>,
  name: string,
): CollectionReadContext => {
  assertKeySegment(name, "collection", "Db.collection");
  const schema = internalsOf(db).schemas.get(name);
  return {
    storage: internalsOf(db).storage,
    collectionPrefix: `${physicalPrefixFor(db.app, db.tenant)}manifests/${name}`,
    collectionName: name,
    ...(schema !== undefined ? { schema } : {}),
  };
};

/**
 * Read + parse this `Db`'s `manifests/<collection>/current.json`. Returns
 * `null` when the collection has not been provisioned yet (no
 * `current.json` exists). Throws `BaerlyError{code:"InvalidResponse"}`
 * on a malformed body — same contract as the underlying
 * {@link readCurrentJson} helper in `@baerly/protocol`.
 *
 * Backs the `/v1/since` long-poll handler in
 * `packages/server/src/http/since.ts`; that handler needs the parsed
 * `CurrentJson` plus an ETag for the follow-up reads.
 *
 * @internal — typed seam for the HTTP handler; app code should use
 *             the collection API.
 */
export const getCurrentJson = async (
  db: Db<BaerlyConfig>,
  collection: string,
  opts?: { signal?: AbortSignal },
): Promise<CurrentJsonRead | null> => {
  // Defensive at the db layer so ALL callers are covered — including
  // the `/v1/since` handler, whose only inline screen catches empty /
  // `/` and lets `..` / control bytes through into this key.
  assertNameSegment(collection, "collection");
  const key = `${physicalPrefixFor(db.app, db.tenant)}manifests/${collection}/current.json`;
  return readCurrentJson(internalsOf(db).storage, key, opts);
};

/**
 * Read + parse one `LogEntry` by `seq` from
 * `manifests/<collection>/log/<seq>.json`. Returns `null`
 * when the entry is missing — this typically means the GC sweeper
 * deleted the entry between a `readCurrentJson` and this GET (the
 * `/v1/since` handler treats the race as silent and skips the
 * entry). Throws `BaerlyError{code:"InvalidResponse"}` on a body
 * that isn't valid JSON.
 *
 * `current` is the manifest this read is floored against — pass the
 * same one the `seq` was derived from. It is a parameter rather than
 * caller-enforced discipline so a new caller cannot introduce a
 * sub-floor read: entries below `current.log_seq_start` are folded
 * into the snapshot and may already be reclaimed (invariant 5 in
 * `docs/spec/sync-protocol.md`).
 *
 * @throws BaerlyError code="Internal" — `seq` is below
 *         `current.log_seq_start`, or below the certified prefix bound
 *         `current.log_delete_floor` (a distinct message: the object is
 *         gone, not merely reclaimable).
 *
 * @throws BaerlyError code="InvalidConfig" — the entry names a
 *         canonically-equivalent but byte-different collection (a
 *         legacy non-NFC spelling on R2); see `isOwnCollection`.
 *
 * @internal — typed seam for the HTTP handler; app code should use
 *             the collection API.
 */
export const getLogEntry = async (
  db: Db<BaerlyConfig>,
  collection: string,
  seq: number,
  current: CurrentJson,
  opts?: { signal?: AbortSignal },
): Promise<LogEntry | null> => {
  // Defensive at the db layer so ALL callers are covered — same
  // rationale as `getCurrentJson`; the `/v1/since` poll reaches here.
  // Path validation runs FIRST: a traversal attempt is a security
  // boundary and must not be reclassified as an invariant violation.
  assertNameSegment(collection, "collection");
  assertAtOrAboveLogFloor("getLogEntry", seq, current);
  const key = logObjectKey(`${physicalPrefixFor(db.app, db.tenant)}manifests/${collection}`, seq);
  const got = await internalsOf(db).storage.get(key, opts);
  if (got === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = decodeJsonBytes(got.body);
  } catch (error) {
    throw new BaerlyError("InvalidResponse", `log entry at ${key}: body is not valid JSON`, {
      cause: error,
    });
  }
  const entry = parsed as LogEntry;
  // On R2 an NFC name addresses a legacy non-NFC spelling's objects;
  // the change feed refuses them as every read does.
  isOwnCollection(entry.collection, collection);
  return entry;
};

/**
 * Forward-probe the TRUE committed log tail from `hint` (a lower
 * bound, typically `tail_hint`). Backs the `/v1/since` end-bound.
 *
 * `hint` stays a caller-chosen lower bound — the probe is defined
 * from an arbitrary starting point at or above the floor, and every
 * other consumer starts at `max(log_seq_start, tail_hint)`. What
 * `current` adds is that the floor cannot be forgotten (invariant 5
 * in `docs/spec/sync-protocol.md`).
 *
 * @throws BaerlyError code="Internal" — `hint` is below
 *         `current.log_seq_start`, or below the certified prefix bound
 *         `current.log_delete_floor` (a distinct message: the object is
 *         gone, not merely reclaimable).
 *
 * @internal — typed seam for the HTTP handler.
 */
export const probeLogTail = async (
  db: Db<BaerlyConfig>,
  collection: string,
  hint: number,
  current: CurrentJson,
  opts?: { signal?: AbortSignal },
): Promise<number> => {
  assertNameSegment(collection, "collection");
  assertAtOrAboveLogFloor("probeLogTail", hint, current);
  const logPrefix = `${physicalPrefixFor(db.app, db.tenant)}manifests/${collection}`;
  const { tail } = await probeTailFrom(internalsOf(db).storage, logPrefix, hint, opts);
  return tail;
};

/**
 * Forward-probe at most `cap` committed log entries from `hint` and
 * return them. Unlike {@link probeLogTail}, reaching `cap` is not an
 * error: the chunk comes back as `kind: "at-least"`, a prefix of the
 * entries past `hint`, so a caller with a bounded request budget can
 * deliver it and resume after its last entry. A slot GET the request
 * ledger refuses ends the chunk the same way, keeping the entries read
 * before it. Each slot is one GET; size `cap` with `forwardProbeCap`.
 *
 * @throws BaerlyError code="Internal" — `hint` is below the floor, as
 *         for {@link probeLogTail}.
 * @throws BaerlyError code="InvalidResponse" — an occupied slot does
 *         not hold valid JSON.
 * @throws BaerlyError code="InvalidConfig" — an entry names a
 *         canonically-equivalent but byte-different collection, as for
 *         {@link getLogEntry}.
 *
 * @internal — typed seam for the HTTP handler.
 */
export const probeLogChunk = async (
  db: Db<BaerlyConfig>,
  collection: string,
  hint: number,
  current: CurrentJson,
  opts: { cap: number; signal?: AbortSignal },
): Promise<TailProbeChunk> => {
  assertNameSegment(collection, "collection");
  assertAtOrAboveLogFloor("probeLogChunk", hint, current);
  const logPrefix = `${physicalPrefixFor(db.app, db.tenant)}manifests/${collection}`;
  const chunk = await probeTailChunk(internalsOf(db).storage, logPrefix, hint, {
    ...opts,
    stopOnRefusal: true,
  });
  // As for getLogEntry: refuse a legacy non-NFC spelling's entries.
  for (const entry of chunk.entries) {
    isOwnCollection(entry.collection, collection);
  }
  return chunk;
};

/**
 * Guard a log-read seq against both floors on the manifest it was
 * derived from.
 *
 * Entries below `log_seq_start` have been folded into the snapshot
 * (invariant 5 in `docs/spec/sync-protocol.md`) and may be reclaimed at
 * any time, so a sub-floor read is never a legitimate request — it is
 * either a stale seq the caller failed to screen, or a caller that
 * never screened at all. Both are protocol-invariant violations by
 * internal code, hence `Internal` rather than `InvalidConfig`: no
 * client input reaches these seams unscreened (`/v1/since` rejects a
 * sub-floor cursor with `SchemaError` before ever getting here).
 *
 * Below `log_delete_floor` the contiguous prefix is certified deleted,
 * so the object is not merely *reclaimable* but already *reclaimed*.
 * The two floors get distinct messages. Same code, because both are the
 * same class of caller bug; different wording, because an operator
 * reading the throw has to know whether the bytes are recoverable.
 *
 * The floors arrive as the whole `CurrentJson` rather than as bare
 * numbers so neither can be invented independently of the manifest.
 *
 * Loud on purpose. PostgreSQL removed `old_snapshot_threshold` in PG17
 * because a fixed reclamation window that let a reader proceed
 * *silently* produced wrong answers; Oracle's `ORA-01555` is the same
 * trade and survives because it throws.
 */
const assertAtOrAboveLogFloor = (seam: string, seq: number, current: CurrentJson): void => {
  const floor = logSeqStartOf(current);
  // The delete floor is checked FIRST, and clamped.
  //
  // First, because `log_delete_floor <= log_seq_start` is a transition
  // invariant: any seq below the delete floor is also below the fold
  // floor, so an arm appended after the check below would be unreachable
  // dead code. Ordering it here changes no accept/reject outcome — only
  // which diagnostic wins — and lets the more specific one win.
  //
  // Clamped, because that `<= log_seq_start` bound is transition-scoped
  // and NOT enforced by the single-state read guard (deliberately: the
  // guard sits on `admin restore`'s own path, so failing it would leave
  // an out-of-bound floor unrepairable). An out-of-bound value therefore
  // arrives here off disk, and unclamped it would report an entry that is
  // present as already deleted.
  const storedDeleteFloor = logDeleteFloorOf(current);
  const deleteFloor = certifiedDeleteFloor(current);
  // `deleteFloor === 0` means no deleted prefix is certified, so this arm
  // has nothing to say and must stay silent: a negative seq against a
  // zero floor is a fold-floor rejection, and claiming its nonexistent
  // object was reclaimed would be the misdiagnosis this floor prevents.
  if (deleteFloor > 0 && seq < deleteFloor) {
    // Render the stored value too when the clamp bit, so an operator is
    // not told the field holds a number it does not hold.
    const clamped =
      storedDeleteFloor === deleteFloor
        ? ""
        : ` (stored log_delete_floor=${storedDeleteFloor}, clamped to log_seq_start=${floor})`;
    throw new BaerlyError(
      "Internal",
      `${seam}: seq ${seq} is below the certified delete floor ${deleteFloor}${clamped}; the log object is GONE — it has been reclaimed, not merely made reclaimable`,
    );
  }
  if (seq < floor) {
    throw new BaerlyError(
      "Internal",
      `${seam}: seq ${seq} is below the fold floor log_seq_start=${floor}; entries beneath the floor are folded into the snapshot and may already be reclaimed`,
    );
  }
};

/**
 * Guard an app, tenant, or collection name used as a path-segment in the
 * bucket-key encoding. Routes through {@link assertNameSegment}: the
 * shared {@link assertPathSegment} rule (empty / `"/"` / `"."`|`".."` /
 * C0-C1 control / leading `"_"` (ADR-003) / overlong) plus Unicode
 * Normalization Form C, all as `BaerlyError{code:"InvalidConfig"}`.
 * `role` and `verb` are baked into the message so the caller doesn't
 * need to format their own.
 *
 * Used by {@link Db.create} (twice — `app`, `tenant`) and
 * {@link collectionReadContext} (once — `name`).
 *
 * @internal
 */
export const assertKeySegment = (value: string, role: string, verb: string): void => {
  assertNameSegment(value, role, verb);
};
