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
  CF_MAX_CONCURRENT_STORAGE_CALLS,
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
 * Wall-clock milliseconds a fold tick may take in total, from the
 * request's arrival to its head CAS and fate re-read (`prepareTreeFold`,
 * `./fold.ts`). Planning stops admitting log entries once the time
 * elapsed plus the estimated publication time of the plan so far would
 * pass it.
 *
 * A tick that runs past the response on Cloudflare (`ctx.waitUntil`)
 * has 30 s before the platform cancels it, silently and with no
 * remaining-time API, and a tick cut off before its head CAS makes no
 * progress: the next tick plans the same batch, so without a clock
 * folding can stall. Counting from the request's arrival rather than
 * from the response keeps a tick inside 30 s even where the window
 * counts from the invocation's start. The 10 s left over absorb what
 * the budget check cannot see: the entry admitted after the last check
 * (its log batch and node reads), publication calls slower than the
 * GETs the estimate is drawn from, and a create conflict's adoption GET.
 */
export const TREE_FOLD_TICK_BUDGET_MS = 20_000;

/**
 * Most storage calls a fold keeps in flight at once when no width is
 * passed: its node read-ahead (`FoldPlanner.prefetch`) and each level of
 * its publication's creates (`publishTree`). Planning and publication
 * wall time is almost all storage latency, so issuing a level's calls
 * together rather than one after another divides it by about this
 * width. The default is the Workers width, the narrowest first-class
 * host; a host passes its maintenance profile's `foldParallelCalls`.
 */
export const TREE_FOLD_PARALLEL_CALLS: number = CF_MAX_CONCURRENT_STORAGE_CALLS;

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

// ---------------------------------------------------------------------
// Fold records and artifact GC
// ---------------------------------------------------------------------

/** The `format` tag of every fold-record body. */
export const TREE_FOLD_RECORD_FORMAT = "baerly-tree-fold-record-proto";

/** The `schema_version` of every fold-record body. */
export const TREE_FOLD_RECORD_SCHEMA_VERSION = 1;

/**
 * Most node keys one fold record lists, `fresh` and `superseded`
 * together. Far above what any host's request ledger lets a fold touch:
 * the Workers Paid ledger admits at most about 1,500 fresh nodes and
 * 3,000 read ones, and an unbudgeted Node fold at its largest snapshot
 * ceiling stays near 9,000. Each listed key costs at most 100 body bytes,
 * so a full record fits {@link TREE_GC_RECORD_MAX_BODY_BYTES}. The fold
 * planner stops a fold before its record would pass this, as it stops
 * one that would overrun its ledger.
 */
export const TREE_GC_RECORD_MAX_KEYS = 16_384;

/**
 * Decoder ceiling on a fold-record body, in body bytes: the leaf
 * ceiling, so every tree object shares one read ceiling. It holds
 * {@link TREE_GC_RECORD_MAX_KEYS} keys at 100 bytes each plus the
 * envelope with room to spare.
 */
export const TREE_GC_RECORD_MAX_BODY_BYTES: number = LEAF_MAX_BODY_BYTES;

/**
 * Minutes a superseded tree node outlives the fold that replaced it, on
 * the storage server's clock, counted from when GC first stamps the
 * replacement. Sized to outlast one read: a complete scan at the largest
 * fold ceiling is about 1,350 GETs, seconds at storage latency, so a
 * quarter hour leaves wide room for a slow or suspended invocation. A
 * read that outlives it restarts or refuses with a retriable error, so
 * the delay is a margin, not a proof.
 */
export const TREE_GC_SUPERSEDED_DELAY_MINUTES = 15;

/**
 * Minutes, on the storage server's clock, that a tree node the leak
 * sweep found unreachable and unpublishable waits before the sweep may
 * delete it. A margin for reads through older roots; the deletion still
 * needs a fresh reachability check. At least
 * {@link TREE_GC_SUPERSEDED_DELAY_MINUTES}, so the sweep never deletes a
 * node sooner after its supersession than the fold-record path would.
 * The same age retires the records of a floor GC could not resolve.
 */
export const TREE_GC_SWEEP_AGE_MINUTES = 60;

/**
 * Least local-clock minutes between two GC state writes made only to
 * read the storage server's time, judged against the local time of the
 * previous one. Paces cost, about two writes a minute at most whatever
 * the write rate; never decides a deletion. Coarse enough to be cheap
 * and fine enough that it adds little to minute-scale delays.
 */
export const TREE_GC_CLOCK_PROBE_MINUTES = 1;

/**
 * Candidate checks one GC tick makes, the sweep page's listed keys
 * included: the floor a tick uses wherever its ledger does not admit
 * more. At depth 0 or 1 each check costs 3 calls, so a tick costs about
 * 235 calls, inside the Cloudflare Free ledger with room for the commit
 * and log retirement. At most `GC_MARK_LIST_PAGE_KEYS`, so one record
 * page always holds a tick's work.
 */
export const TREE_GC_TICK_CANDIDATES = 64;

/**
 * Keys per leak-sweep LIST page, one page per clock probe. Small, so the
 * sweep's checks leave most of {@link TREE_GC_TICK_CANDIDATES} to the
 * fold records; a pass over 1,350 nodes then takes about 85 probes.
 */
export const TREE_GC_SWEEP_LIST_KEYS = 16;

/**
 * Most fold-record GETs one GC tick makes, and separately most record
 * DELETEs. A fixed part of the tick's static call bound; a tick needs
 * only a few records to fill its candidate checks.
 */
export const TREE_GC_TICK_RECORD_CALLS = 4;

/**
 * Most per-floor work entries the GC state holds. Bounds the state
 * body; while it is full GC resolves no new floor, which delays
 * reclamation and never makes a deletion unsafe.
 */
export const TREE_GC_MAX_WORK_ENTRIES = 256;

/**
 * Most leak-sweep marks the GC state holds. Bounds the state body; a
 * key left unmarked is examined again on the next sweep pass.
 */
export const TREE_GC_MAX_SWEEP_MARKS = 256;
