import { BaerlyError } from "./errors.ts";
import type { JSONArraylessObject, JSONValue } from "./json.ts";
import { str2uintDesc } from "./types.ts";

/**
 * Postgres-logical-replication-shaped log entry. One per mutation.
 *
 * **Shape is fixed at this point and never changes after.** This is the
 * migration contract behind `baerly export --target=postgres` — the
 * keys are public, consumers ack on `lsn`, and any rename / removal is
 * a major-version migration.
 *
 * Field requirement matrix:
 * - Always: `lsn`, `commit_ts`, `op`, `collection`, `schema_version`,
 *   `session`, `seq`.
 * - For I/U/D: `doc_id`.
 * - For I/U: `new`, `patch` (equal in today's per-doc-replace model).
 * - Optional: `old` (when `replica_identity === "FULL"`), `key_old`
 *   (U/D when `replica_identity !== "PATCH_ONLY"`), `origin`.
 *
 * @see docs/spec/log-entry-shape.md
 */
export interface LogEntry {
  /**
   * Opaque, monotonic, lex-asc cursor. Shape is
   * `<base32-time>_<session>_<seq>` — minted inside
   * `ServerWriter.commit` (see
   * `packages/server/src/server-writer.ts`) from `timestamp()` +
   * the per-commit `session` + `countKey(seq)`. Consumers ack and
   * resume from this string; **do not parse it** — use the
   * `session` / `seq` fields below.
   */
  lsn: string;

  /** ISO-8601 ms timestamp. Redundant with `lsn` but cheap. */
  commit_ts: string;

  /**
   * Insert / Update / Delete / Truncate / Message. `M` is the
   * `pg_logical_emit_message` analogue — useful for app-defined
   * markers like deploy boundaries, snapshots, or out-of-band
   * schema announcements consumed via `schema_version`. `T`
   * truncates a whole collection. Today the emitter only produces
   * `I`/`U`/`D`; `T` and `M` are shape-only for forward
   * compatibility.
   */
  op: "I" | "U" | "D" | "T" | "M";

  /**
   * Collection name — the pgoutput RELATION analogue. Today derived
   * from the path segment immediately under the manifest prefix
   * (the part of `ref.key` before the first `/`); falls back to
   * `ref.bucket` for flat keys with no separator. The table API
   * makes collections first-class.
   */
  collection: string;

  /** Required for I/U/D; omitted for T (TRUNCATE) and M (MESSAGE). */
  doc_id?: string;

  /**
   * Monotonic per collection. Schema for the doc body is announced
   * out-of-band via `M` (MESSAGE) entries; this field lets the
   * consumer match a log entry to the schema in effect at write
   * time. Forward-only — renaming or removing the field is a
   * major-version migration; bumping the value is non-breaking.
   * Inlining the schema in every entry was rejected as bloat for a
   * field that changes rarely. Always `0` today; reserved for a
   * future schema-versioning scheme.
   */
  schema_version: number;

  /** Required for I, U. The post-image. */
  new?: JSONArraylessObject;

  /**
   * JSON-merge-patch (RFC 7386) form. Required for U; for I equals
   * `new`. In today's per-doc-replace model `new` and `patch` are
   * always equal; that changes when partial-doc merge writes land.
   */
  patch?: JSONArraylessObject;

  /**
   * The pre-image. Present iff the collection's `replica_identity`
   * is `FULL`. ~2× log size on update-heavy collections; off by
   * default.
   */
  old?: JSONArraylessObject;

  /**
   * Pre-image of the primary key. U/D always carry this when
   * `replica_identity` is not `PATCH_ONLY`. (For Baerly today,
   * `_id` is the only PK.)
   */
  key_old?: { readonly [pk: string]: JSONValue };

  /** ORIGIN analogue — the writer session id. */
  origin?: string;

  /**
   * Causal metadata (Baerly-only; no pgoutput analogue). The
   * session id that built the `lsn`. Surfaces here so consumers
   * can dedupe / order without parsing the cursor.
   */
  session: string;

  /** Per-session sequence number embedded in the `lsn`. */
  seq: number;
}

/**
 * Per-collection setting controlling how much pre-image data each
 * `U` / `D` entry carries.
 *
 * - `PATCH_ONLY` (default today, applied unconditionally): `U`
 *   carries `{ patch, new }`; no `old`, no `key_old`.
 *   Bandwidth-cheap. SQL consumers rebuilding before-images need
 *   to maintain a shadow table.
 * - `FULL`: `U` additionally carries `old` and `key_old`. ~2× log
 *   size on update-heavy collections; buys true 1:1 logical
 *   replication and "previous value" answerable from the log
 *   alone.
 *
 * Per-collection opt-in is not yet wired; every collection is
 * currently `PATCH_ONLY`.
 */
export type ReplicaIdentity = "PATCH_ONLY" | "FULL";

/**
 * S3 path segment for log entries (under the manifest prefix). The
 * full key shape is `<manifestPrefix>/log/<seq>.json` — composed
 * inline by callers (`server-writer`, `gc`, `rebuild-index`,
 * `http/since`) since the `<seq>` integer is the load-bearing
 * identifier and a one-arg helper would just hide the join.
 */
export const LOG_KEY_PREFIX = "log";

const COUNT_BIT_WIDTH = 10;

/**
 * Extract the `session` and `seq` embedded in an `lsn` of shape
 * `<base32-time>_<session>_<seq>`. The seq portion is decoded as a
 * descending base-32 integer (matches `countKey` in `./types`).
 *
 * Throws on malformed input; callers should pass only lsns minted
 * by `ServerWriter.commit` (see
 * `packages/server/src/server-writer.ts`).
 */
export const lsnParts = (lsn: string): { session: string; seq: number } => {
  const parts = lsn.split("_");
  if (parts.length !== 3) {
    throw new BaerlyError("InvalidResponse", `invalid lsn shape: ${lsn}`);
  }
  return {
    session: parts[1]!,
    seq: str2uintDesc(parts[2]!, COUNT_BIT_WIDTH),
  };
};
