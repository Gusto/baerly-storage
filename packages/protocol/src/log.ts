import { BaerlyError } from "./errors.ts";
import type { DocumentData, JSONValue } from "./json.ts";
import { COUNT_BIT_WIDTH } from "./constants.ts";
import { str2uintDesc } from "./types.ts";

/**
 * Debezium-style JSON CDC envelope using pgoutput's message-tag (`I`/`U`/`D`) vocabulary. One per mutation.
 *
 * `LogEntry` is now a public wire contract: 0.3.0 is the public
 * early-access baseline. It is still pre-1.0 and soaking, so breaking
 * changes remain possible, but only through an explicit compatibility
 * decision, changelog/migration notes, and a versioned release. Assume
 * external consumers may exist; do not silently rename, remove, or
 * repurpose fields. New optional fields can be added in compatible
 * releases.
 *
 * Field requirement matrix:
 * - Always: `lsn`, `commit_ts`, `op`, `collection`, `session`,
 *   `seq`.
 * - For I/U/D: `doc_id`.
 * - For I/U: `after` (full post-image).
 * - Optional: `before` (when `replica_identity === "FULL"`), `key_old`
 *   (U/D when `replica_identity !== "PATCH_ONLY"`), `origin`.
 *
 * @see docs/spec/log-entry-shape.md
 */
export interface LogEntry {
  /**
   * Opaque, monotonic, lex-asc cursor. Shape is
   * `<base32-time>_<session>_<seq>` — minted inside
   * `Writer.commit` (see
   * `packages/server/src/writer.ts`) from `timestamp()` +
   * the per-commit `session` + `countKey(seq)`. Consumers ack and
   * resume from this string.
   *
   * When you have a `LogEntry` in hand, prefer the structured
   * `session` / `seq` fields below over parsing this string. The
   * one place that *does* need to crack it open is the
   * `/v1/since` boundary, where a client resumes from an opaque
   * `next_cursor` and no `LogEntry` is in scope — that path uses
   * `lsnParts` (the kernel-blessed parser) rather than ad-hoc
   * `split("_")`.
   */
  lsn: string;

  /** ISO-8601 ms timestamp. Redundant with `lsn` but cheap. */
  commit_ts: string;

  /** Insert / Update / Delete. */
  op: "I" | "U" | "D";

  /**
   * Collection name — the pgoutput RELATION analogue. Today this is
   * the collection bound to the `current.json` whose `tail_hint` minted
   * the entry. The table API makes collections first-class.
   */
  collection: string;

  /**
   * The document key (`ref.key`). Required for every op — `op` is
   * `I | U | D` and all three carry it — so the wire type is required,
   * not optional, matching `log-entry-shape.md`.
   */
  doc_id: string;

  /** Required for I, U. The post-image (Debezium's `after`). */
  after?: DocumentData;

  /**
   * The pre-image (Debezium's `before`). Present iff the
   * collection's `replica_identity` is `FULL`. ~2× log size on
   * update-heavy collections; off by default.
   */
  before?: DocumentData;

  /**
   * Pre-image of the primary key. U/D always carry this when
   * `replica_identity` is not `PATCH_ONLY`. (For baerly-storage today,
   * `_id` is the only PK.)
   */
  key_old?: { readonly [pk: string]: JSONValue };

  /** ORIGIN analogue — the writer session id. */
  origin?: string;

  /**
   * Causal metadata (baerly-storage-only; no pgoutput analogue). The
   * session id that built the `lsn`. Surfaces here so consumers
   * can dedupe / order without parsing the cursor.
   */
  session: string;

  /**
   * The `log/<seq>` slot this entry occupies — the integer in its
   * `log/<seq>.json` key, minted by `Writer.commit` as the forward-probed
   * collection-log tail (the winning `If-None-Match: "*"` create). One
   * entry per `session`, so this is a per-collection slot, not a
   * per-session counter. Also encoded (descending base-32) as the LSN's
   * third segment — see `lsnParts`.
   */
  seq: number;
}

/**
 * Per-collection setting controlling how much pre-image data each
 * `U` / `D` entry carries.
 *
 * - `PATCH_ONLY` (default today, applied unconditionally): `U`
 *   carries `{ after }`; no `before`, no `key_old`.
 *   Bandwidth-cheap. SQL consumers rebuilding before-images need
 *   to maintain a shadow table.
 * - `FULL`: `U` additionally carries `before` and `key_old`. ~2× log
 *   size on update-heavy collections; buys true 1:1 logical
 *   replication and "previous value" answerable from the log
 *   alone.
 *
 * Per-collection opt-in is not yet wired; every collection is
 * currently `PATCH_ONLY`.
 */
export type ReplicaIdentity = "PATCH_ONLY" | "FULL";

// `LOG_KEY_PREFIX` + `logObjectKey` live in the zero-import `log-key.ts`
// leaf so consumers that only need the key shape don't drag this module's
// `lsn` parsing runtime into their bundle closure (it added +3.8 KB raw to
// `maintenance.js` when the helper lived here).

/**
 * Extract the `session` and `seq` embedded in an `lsn` of shape
 * `<base32-time>_<session>_<seq>`. The seq portion is decoded as a
 * descending base-32 integer (matches `countKey` in `./types`).
 *
 * Use this at the `/v1/since` cursor-decoding boundary, where a
 * client resumes from an opaque `SinceResponse.next_cursor` and no
 * `LogEntry` is in scope. When iterating `LogEntry` records, read
 * `entry.session` / `entry.seq` directly instead.
 *
 * Throws on malformed input; callers should pass only lsns minted
 * by `Writer.commit` (see
 * `packages/server/src/writer.ts`).
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
