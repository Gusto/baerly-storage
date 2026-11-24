/**
 * Format constants of the prototype tree. Unlike `TreeLayout`
 * (`./layout.ts`), no override can change these: they fix what a reader
 * accepts, so a test layout can never widen the decoder.
 *
 * The namespace segment and format tag are prototype-only values. The
 * real versioned namespace (docs/adr/003-layout-versioning-cordon.md) is
 * chosen when the format is adopted.
 */

import {
  MAX_KEY_BYTES,
  MAX_PARALLEL_LOG_READS,
  STORAGE_RETRY_MAX_ATTEMPTS,
} from "@baerly/protocol";
import { MAX_SEGMENT_BYTES } from "../path-segment.ts";

/** Namespace segment under the collection prefix that holds every tree object. */
export const TREE_NS = "_v99";

/** The `format` tag of every node body. */
export const TREE_FORMAT = "baerly-tree-node-proto";

/** The `schema_version` of every node body. */
export const TREE_NODE_SCHEMA_VERSION = 1;

/**
 * Domain prefix of the chunk hash's HMAC message, used for
 * content-defined chunking. It separates chunk hashes from every other
 * keyed hash in the system. The version suffix names the keyed
 * construction, so a different message layout must take a different
 * domain.
 */
export const TREE_CHUNK_DOMAIN = "baerly-tree-chunk-v2";

/**
 * Length of a collection's chunk salt, the HMAC key of the chunk hash.
 * The head stores it as 32 lowercase hex characters.
 */
export const TREE_CHUNK_SALT_BYTES = 16;

/**
 * Largest valid node `level` (leaves are level 0). With a branch fanout
 * minimum of 2 every level is strictly smaller than the one below it, so
 * a tree of 2^53 rows stays far below this.
 */
export const TREE_MAX_LEVEL = 16;

/**
 * Calls the request ledger is charged for one node GET, node PUT or head
 * GET of a fold, and for each base GET a scan admission check counts.
 * Each goes through `retryStorageCall`
 * (`packages/protocol/src/storage/retry.ts`), which may make up to
 * `STORAGE_RETRY_MAX_ATTEMPTS` attempts, and the ledger charges every
 * attempt as it is issued, so a plan charged at this rate cannot run out
 * of ledger through retries partway through publication.
 */
export const TREE_RETRIED_CALL_CHARGE: number = STORAGE_RETRY_MAX_ATTEMPTS;

/**
 * Calls charged for a fold's head CAS. It is an `If-Match` PUT, which
 * `retryStorageCall` sends exactly once (`compareAndSwap`): a resend
 * would meet its own landed write as a 412.
 */
export const TREE_HEAD_CAS_CHARGE = 1;

/**
 * Most sibling nodes a read fetches at once. The same concurrency as the
 * log walk (`MAX_PARALLEL_LOG_READS`): it bounds simultaneous GETs, not
 * their total, which the request ledger bounds. On Workers the platform
 * runs at most 6 outgoing connections at a time whatever this value is.
 */
export const TREE_READ_PARALLEL_GETS: number = MAX_PARALLEL_LOG_READS;

/**
 * Wall-clock milliseconds a fold tick may spend capturing the head and
 * planning before it stops admitting log entries and publishes the
 * planned prefix (`prepareTreeFold`, `./fold.ts`).
 *
 * A tick that runs past the response on Cloudflare (`ctx.waitUntil`)
 * has about 30 s before the platform may cancel it, and a tick cut off
 * before its head CAS makes no progress: the next tick plans the same
 * batch, so without a clock folding can stall. Planning wall time is
 * almost all storage latency (a few hundred ms per R2 binding GET).
 * Publication issues one create per fresh node, and a fold's fresh
 * nodes are mostly rewrites of the nodes it read, so publication takes
 * roughly as long again as planning, plus the head CAS and its fate
 * re-read. Ten seconds of planning leaves the rest of the window for
 * that, and for any maintenance the same tick ran before the fold.
 *
 * The deadline is checked between log entries, so one entry's node
 * reads are never cut short, and it never stops a publication.
 */
export const TREE_FOLD_PLAN_DEADLINE_MS = 10_000;

/**
 * Most node GETs a fold planner issues at once when it reads ahead the
 * leaf paths of a batch of changes (`FoldPlanner.prefetch`). Planning
 * wall time is almost all storage latency, so reading a batch's nodes
 * together rather than one after another divides it by about this
 * width. Workers may cap simultaneous storage binding calls at about 6
 * (unverified); a deployed measurement tunes this value.
 */
export const TREE_FOLD_PARALLEL_GETS = 6;

/** Most child entries one branch may hold. */
export const BRANCH_MAX_ENTRIES = 256;

/**
 * Decoder ceiling on a branch body, in body bytes. It covers
 * {@link BRANCH_MAX_ENTRIES} entries of at most 1,211 bytes each (two
 * 256-byte IDs with every byte escaped, plus counts and refs) and the
 * envelope.
 */
export const BRANCH_MAX_BODY_BYTES = 524_288;

/**
 * Decoder ceiling on any node body, in body bytes, checked before the
 * node's kind is known. A format constant rather than a layout field, so
 * no layout override can change what a reader accepts.
 *
 * Every leaf the builder emits fits with slack. The largest envelope is
 * 721 bytes (a 256-byte collection name fully escaped, safe-integer
 * totals), so a leaf holding one isolated document is at most
 * `MAX_DOCUMENT_BYTES` + 721 bytes. Any other leaf holds less than 1 MiB of
 * document bytes plus fewer than one separator per 11 of them, so every
 * leaf body is at most 1,144,622 bytes.
 */
export const LEAF_MAX_BODY_BYTES = 2_097_152;

/**
 * Canonical bytes of the smallest valid document, `{"_id":"x"}`. Every
 * subtree therefore holds at least this many document bytes per row.
 */
export const MIN_DOCUMENT_BYTES = 11;

/**
 * Longest node key a decode error message repeats in full. A key a
 * bucket can hold is at most `MAX_KEY_BYTES` (1,024) UTF-8 bytes, so at
 * most 1,024 UTF-16 code units: every storable key is echoed whole, and
 * only an oversize key from a caller is cut. Like the two bounds below,
 * this shapes messages only and changes no stored byte.
 */
export const TREE_MESSAGE_KEY_CHARS = MAX_KEY_BYTES;

/**
 * Longest stored string an error message repeats. Every valid `_id` and
 * collection name is at most `MAX_SEGMENT_BYTES` (256) UTF-8 bytes, so
 * at most 256 UTF-16 code units, and attempts, hashes and the format tag
 * are shorter: a valid value is always echoed whole, and an oversize one
 * from a corrupt body is cut instead of copied into the message.
 */
export const TREE_MESSAGE_VALUE_CHARS = MAX_SEGMENT_BYTES;

/**
 * Longest detail text after the check name in a tree node error. A
 * detail holds at most a few values of {@link TREE_MESSAGE_VALUE_CHARS}
 * (up to six characters each once JSON-escaped) plus prose, which fits
 * well inside this; the cap bounds what a validator's own message or a
 * long field list can add.
 */
export const TREE_MESSAGE_DETAIL_CHARS = 4096;
