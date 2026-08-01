/**
 * `/v1/since` cursor codec — the composite `<generation>.<lsn>` token a
 * long-poll client acks and resumes from.
 *
 * Kept separate from `log.ts` for the same reason as `log-key.ts`:
 * `log.ts` carries the heavier `lsn` parsing runtime, and consumers that
 * only need to split a cursor shouldn't drag it into their bundle
 * closure. This module imports only `BaerlyError`.
 *
 * ## Why the cursor is not just the LSN
 *
 * The seq embedded in an LSN identifies a `log/<seq>` slot, and slots
 * are reused. `baerly admin restore --force` truncates a collection and
 * reseeds `log_seq_start` to one past the highest *surviving* log
 * object, which can land BELOW the old floor (the deliberate floor
 * exemption — see invariant 12 in `docs/spec/sync-protocol.md`). A
 * pre-restore cursor then passes `/v1/since`'s `cursorSeq <
 * log_seq_start` gate and resumes into the new generation, silently
 * skipping every restored row beneath it. The stream is gapped, not
 * broken, which is the worst failure mode for a sync cursor.
 *
 * Pairing the LSN with the generation that minted it turns that silent
 * gap into a `SchemaError` telling the client to re-bootstrap.
 *
 * The token is opaque on the wire: clients ack and echo it, never parse
 * it. `LogEntry.lsn` is unchanged — this shape exists only at the
 * `/v1/since` boundary.
 */

import { BaerlyError } from "./errors.ts";

/**
 * Separator between the generation and the LSN. The LSN is
 * `_`-delimited (`<base32-time>_<session>_<seq>`) and a generation is
 * lowercase hex, so `.` cannot occur in either half.
 */
const CURSOR_SEPARATOR = ".";

/**
 * Stands in for "this manifest has no `generation`". Both spellings of
 * that state — a `current.json` predating the field, and a bare-LSN
 * cursor minted before this build — decode to this value, so the
 * ordinary string comparison in `/v1/since` handles them without a
 * fail-open branch. See the truth table in
 * `docs/spec/sync-protocol.md`.
 */
export const NO_GENERATION = "-";

/**
 * Build the wire cursor for an entry's `lsn` under a manifest's
 * `generation`.
 *
 * A manifest predating the field emits the LSN **bare**, not
 * `-.<lsn>` — {@link parseCursor} maps both to {@link NO_GENERATION},
 * so the comparison is unchanged either way. Keeping it bare confines
 * the wire-shape change to collections that actually carry a nonce,
 * instead of changing every cursor in the bucket on upgrade.
 */
export const formatCursor = (generation: string | undefined, lsn: string): string =>
  generation === undefined ? lsn : `${generation}${CURSOR_SEPARATOR}${lsn}`;

/**
 * Split a wire cursor into its generation and LSN halves.
 *
 * A cursor with no separator is a bare LSN from a build that predates
 * the composite shape; it decodes to {@link NO_GENERATION} rather than
 * throwing, so an in-flight client is not forced to re-bootstrap across
 * a deploy that changed nothing about its collection.
 *
 * Throws `SchemaError` (→ HTTP 400) on more than one separator: that is
 * malformed caller input, not a shape this build ever minted, and
 * guessing which half is which would be worse than rejecting.
 */
export const parseCursor = (cursor: string): { generation: string; lsn: string } => {
  const parts = cursor.split(CURSOR_SEPARATOR);
  if (parts.length === 1) {
    return { generation: NO_GENERATION, lsn: cursor };
  }
  if (parts.length !== 2) {
    throw new BaerlyError(
      "SchemaError",
      `invalid cursor shape: ${JSON.stringify(cursor)} (expected "<generation>.<lsn>")`,
    );
  }
  return { generation: parts[0]!, lsn: parts[1]! };
};
