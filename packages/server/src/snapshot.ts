/**
 * Snapshot file shape + parse. Lifted out of `./compactor.ts` so that
 * the kernel barrel (`packages/server/src/index.ts`) — which re-exports
 * these four symbols — does not transitively pull `withObservability`
 * via `compact()`. `./compactor.ts` imports its own snapshot primitives
 * back from this module; the public API surface is unchanged.
 *
 * @see ../../../docs/spec/sync-protocol.md
 */

import {
  BaerlyError,
  decodeJsonBytes,
  type DocumentData,
  encodeJsonBytes,
  snapshotHash,
  SNAPSHOT_SCHEMA_VERSION,
  type Storage,
} from "@baerly/protocol";

/**
 * Single-level snapshot at L9; the level prefix is forward-compatible
 * with future L0..L9 rolling merges without a wire change.
 */
export const SNAPSHOT_LEVEL = 9 as const;

/**
 * `minSeq` and `maxSeq` are padded to {@link SEQ_DIGITS} digits so
 * `list(prefix)` returns snapshots in seq order without needing to
 * parse the filename. 12 digits caps at ~10^12 entries per collection;
 * a real bucket hits S3's per-prefix QPS ceiling long before that.
 */
export const SEQ_DIGITS = 12 as const;

const MAX_SEQ = 10 ** SEQ_DIGITS - 1;

/**
 * Build the on-bucket key for a snapshot file. `sha256` must be the
 * lowercase hex digest of the canonical body
 * ({@link encodeSnapshotBody}); the filename embeds it so a crashed
 * mid-PUT body that doesn't match its own filename hash is rejected
 * by readers as "missing."
 *
 * @throws BaerlyError code="InvalidConfig" — `minSeq`/`maxSeq` are
 *   out of range or `sha256` is not 64 hex chars.
 */
export const snapshotKey = (
  collectionPrefix: string,
  minSeq: number,
  maxSeq: number,
  sha256: string,
): string => {
  if (minSeq < 0 || maxSeq < 0 || minSeq > maxSeq || maxSeq > MAX_SEQ) {
    throw new BaerlyError("InvalidConfig", `snapshotKey: invalid range [${minSeq}, ${maxSeq})`);
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new BaerlyError("InvalidConfig", "snapshotKey: sha256 must be 64 hex chars");
  }
  const pad = (n: number): string => n.toString().padStart(SEQ_DIGITS, "0");
  return `${collectionPrefix}/snapshot/L${SNAPSHOT_LEVEL}/${pad(minSeq)}-${pad(maxSeq)}-${sha256}.json`;
};

/**
 * On-bucket body of a snapshot file. The reader recomputes the SHA-256
 * over the canonical serialisation ({@link encodeSnapshotBody}) and
 * rejects any mismatch with the filename hash.
 *
 * `docs` is sorted by `_id` for deterministic byte output — two
 * compactions over the same fold produce byte-identical snapshots,
 * which means same filename, which means an idempotent re-run never
 * leaves an orphan.
 */
export interface SnapshotBody {
  readonly schema_version: typeof SNAPSHOT_SCHEMA_VERSION;
  readonly min_seq: number;
  readonly max_seq: number;
  readonly collection: string;
  readonly docs: ReadonlyArray<{
    readonly _id: string;
    readonly body: DocumentData;
  }>;
}

/**
 * Canonical byte encoding of a {@link SnapshotBody}. Only the
 * compactor produces snapshots, and only this function does the
 * serialisation — so the byte output is deterministic for a given
 * `SnapshotBody` (identical input ⇒ identical bytes ⇒ identical
 * filename hash).
 */
export const encodeSnapshotBody = (s: SnapshotBody): Uint8Array => encodeJsonBytes(s);

/**
 * Load a snapshot file as a `Map<_id, DocumentData>`. Verifies the
 * body hash against the filename, checks the schema version, and
 * cross-checks `body.collection` against the caller's expectation.
 *
 * @example
 * ```ts
 * import { loadSnapshotAsMap } from "@gusto/baerly-storage";
 *
 * const map =
 *   srcCurrent.snapshot === null
 *     ? new Map<string, DocumentData>()
 *     : await loadSnapshotAsMap(src.storage, srcCurrent.snapshot, "tickets");
 * ```
 *
 * @throws BaerlyError code="Internal" — pointer resolves to no body,
 *   or the body's SHA-256 doesn't match the hash embedded in the
 *   filename. (Protocol invariant violation; a corrupted snapshot
 *   the reader cannot continue past.)
 * @throws BaerlyError code="InvalidResponse" — body isn't valid JSON,
 *   isn't an object, has an unsupported `schema_version`, or carries a
 *   `collection` that doesn't match `expectedCollection`.
 */
export const loadSnapshotAsMap = async (
  storage: Storage,
  key: string,
  expectedCollection: string,
  signal?: AbortSignal,
): Promise<Map<string, DocumentData>> => {
  const got = await storage.get(key, signal !== undefined ? { signal } : undefined);
  if (got === null) {
    throw new BaerlyError(
      "Internal",
      `compact: snapshot pointer ${key} resolves to no body; protocol violation`,
    );
  }
  // Verify hash: the filename shape is
  // `<...>/snapshot/L<n>/<min>-<max>-<sha256>.json`. The sha256 is
  // the segment after the LAST `-` (the two seq fields don't contain
  // dashes), with `.json` stripped.
  const filename = key.slice(key.lastIndexOf("/") + 1).replace(/\.json$/, "");
  const lastDash = filename.lastIndexOf("-");
  const expectedHash = filename.slice(lastDash + 1);
  const actualHash = await snapshotHash(got.body);
  if (actualHash !== expectedHash) {
    throw new BaerlyError(
      "Internal",
      `compact: snapshot ${key} body hash mismatch (got ${actualHash}); protocol violation`,
    );
  }
  let parsed: unknown;
  try {
    parsed = decodeJsonBytes(got.body);
  } catch (error) {
    throw new BaerlyError(
      "InvalidResponse",
      `compact: snapshot ${key} body is not valid JSON`,
      error,
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new BaerlyError("InvalidResponse", `compact: snapshot ${key} body is not an object`);
  }
  const body = parsed as SnapshotBody;
  if (body.schema_version !== SNAPSHOT_SCHEMA_VERSION) {
    throw new BaerlyError(
      "InvalidResponse",
      `compact: snapshot ${key} has unsupported schema_version ${String(body.schema_version)}`,
    );
  }
  if (body.collection !== expectedCollection) {
    throw new BaerlyError(
      "InvalidResponse",
      `compact: snapshot ${key} carries collection ${body.collection}, expected ${expectedCollection}`,
    );
  }
  if (!Array.isArray(body.docs)) {
    throw new BaerlyError("InvalidResponse", `compact: snapshot ${key} body.docs is not an array`);
  }
  const out = new Map<string, DocumentData>();
  for (const row of body.docs) {
    out.set(row._id, row.body);
  }
  return out;
};
