/**
 * `current.json` — the per-collection compaction-state control object —
 * and its embedded, currently dormant {@link WriterFence} epoch token.
 *
 * A dedicated `coordination/` namespace (parallel to `storage/`) holds
 * primitives whose contract is "atomic agreement over a small JSON
 * object" rather than "byte I/O." Future siblings (compactor
 * manifest, sweeper checkpoint) join here, not at the top
 * level. The module lives inside `@baerly/protocol` because it is pure
 * (no Node imports, no `node:fs`, no `Buffer`, no `node:crypto`,
 * no implicit globals) and must remain Worker-bundleable — every byte
 * of network traffic threads through the {@link Storage} seam.
 *
 * Contract surface:
 *   - {@link readCurrentJson}   — fetch + parse + validate
 *   - {@link createCurrentJson} — create-only (CAS via `If-None-Match:"*"`)
 *   - {@link casUpdateCurrentJson} — read-modify-write (CAS via `If-Match`)
 *   - {@link assertCurrentJsonTransition} — shared before/after admission
 *   - {@link claimWriter}       — bump epoch + stamp server-clock claim time
 *
 * Why the two-round-trip claim protocol: `claimed_at` MUST come from
 * `StoragePutResult.serverDate` (the single shared clock across
 * instances), not the local clock. `serverDate` is only known *after*
 * the CAS PUT lands, so {@link claimWriter} writes the record with
 * `claimed_at: ""` first, then overwrites itself with the correct
 * `serverDate.toISOString()` in a second CAS. The epoch bump is
 * already durable from the first put either way; a peer landing
 * between the two writes loses cleanly with `Conflict`.
 *
 * Why CAS errors are wrapped: every in-tree {@link Storage} impl
 * surfaces a lost CAS as `BaerlyError{code:"Conflict"}`. Downstream
 * callers — the Writer, the compactor, the sweeper —
 * discriminate by `code` to decide whether to retry.
 * We re-wrap here only to add the `current.json at <key>` location
 * context to the message; the `code` is unchanged.
 */

import { encodeJsonBytes } from "../bytes.ts";
import { CURRENT_JSON_CONTENT_TYPE, CURRENT_JSON_SCHEMA_VERSION } from "../constants.ts";
import { BaerlyError } from "../errors.ts";
import type { Storage, StoragePutOptions, StoragePutResult } from "../storage/types.ts";

/**
 * Per-collection control object. CAS-protected. One per
 * `(tenant, collection)` key — for example
 * `<tenant>/<collection>/current.json`. The compactor swaps snapshot
 * generations by CAS-writing this object; the Writer reads it on every
 * commit to find the snapshot pointer and a non-authoritative
 * tail-probe floor. The numbered log create mints the next integer
 * `seq`; no commit-path code CAS-advances `current.json`.
 *
 * The schema is forward-compatible: adding a new optional field is
 * non-breaking. Renaming or removing a field requires bumping
 * {@link CURRENT_JSON_SCHEMA_VERSION}; readers MUST reject
 * unknown major versions with `BaerlyError{code:"InvalidResponse"}`.
 */
export interface CurrentJson {
  /**
   * Schema version. Today: `3`. Bump on any breaking change to
   * field semantics; readers must reject unknown major versions
   * with `BaerlyError{code:"InvalidResponse"}`.
   */
  schema_version: 3;

  /**
   * Pointer to the current snapshot generation. `null` before the
   * first compaction has produced a snapshot — readers fall back
   * to log-only replay. Shape is opaque-to-this-module; the
   * compactor owns its interpretation.
   */
  snapshot: string | null;

  /**
   * Non-authoritative monotone lower bound on the committed log tail.
   * The authoritative tail is discovered by forward-probe (log-tail.ts);
   * never trust this as the head. Durable advancement is owned by
   * compaction folds, write-tick tail refreshes, and explicit
   * operator/import paths; ordinary writer commits do not refresh it.
   */
  tail_hint: number;

  /**
   * Lowest live log sequence number. Entries with `seq < log_seq_start`
   * have been folded into the snapshot at {@link snapshot} (or, if
   * `snapshot === null`, have been dropped because the collection was
   * truncated). Readers walk `[log_seq_start, tail_hint)`. Always
   * present on disk — fresh `current.json` writes via
   * {@link createCurrentJson} set this to `0`; the compactor advances
   * it on every fold.
   *
   * Invariants:
   *   - `0 <= log_seq_start <= tail_hint`
   *   - `log_seq_start` advances monotonically (never decreases).
   *     {@link assertCurrentJsonTransition} rejects a writer that lowers
   *     it; `baerly admin restore
   *     --force` is the deliberate truncate exemption.
   *   - `log_seq_start > 0` implies `snapshot !== null` (the snapshot
   *     covers `[0, log_seq_start)`) — except after a `--force`
   *     truncate, which resets `snapshot` to `null` while reseeding
   *     the floor above any surviving old-generation log object.
   */
  log_seq_start: number;

  /**
   * Embedded write-fence epoch. See {@link WriterFence}.
   */
  writer_fence: WriterFence;

  // New in v2:

  /** Byte size of the snapshot pointed to by `snapshot`. */
  snapshot_bytes: number;

  /**
   * Row count of the snapshot (= compactor `base.size`, free). With
   * `tail_hint - log_seq_start` (trusted tail entries) this gives the
   * fold's entry count for the ENTRY ceiling `E`. Seeded 0.
   */
  snapshot_rows: number;

  /**
   * Optional compactor-stamped mean folded-entry byte size. Maintenance
   * derives live-tail bytes as `entry_count × mean_entry_bytes` without
   * an exact stored counter; absent until first fold.
   */
  mean_entry_bytes?: number;

  /**
   * Baseline for rate-limiting the graduation defer-warn off SHARED
   * durable state, not per-isolate memory. The warn fires when the
   * observed/probed tail minus `last_warned_seq` reaches
   * MAINTENANCE_WARN_INTERVAL_WRITES, and that firing CASes
   * `last_warned_seq` to the observed/probed tail. Absent → 0.
   */
  last_warned_seq?: number;

  /**
   * The exclusive upper bound of the contiguous log prefix certified
   * deleted. Every `log/<seq>.json` with `seq < log_delete_floor` is
   * gone from the bucket. Distinct from {@link log_seq_start}, which is the
   * lowest sequence a READER may need: the gap between them is the
   * deliberately-retained safety window, which absorbs a paused writer
   * resuming against its idempotency anchor.
   *
   * A FLOOR, not a rotation cursor. The deletable set is a contiguous
   * range over integer `seq` order that only ever grows at one end, so
   * this never wraps and never re-scans — which is why retiring stale
   * logs needs no LIST and no `gc/pending.json` entry. Compare
   * `GcPending.log_scan_cursor`, which drives a budget-bounded LIST in
   * LEXICOGRAPHIC key order (`0,1,10,11,2,…`) and therefore must be a
   * wrapping position rather than a bound.
   *
   * Optional because it postdates `schema_version: 3`. Absent is a
   * well-defined state meaning "no deleted prefix is certified" and
   * decodes to `0` via {@link logDeleteFloorOf}; a bucket written by an
   * earlier build simply starts its first retention pass from the bottom
   * of the keyspace.
   *
   * Invariants:
   *   - advances monotonically (never decreases)
   *   - `0 <= log_delete_floor <= log_seq_start`
   *
   * Both are transition-scoped and enforced in
   * {@link assertCurrentJsonTransition}. The single-state guard checks
   * shape only, so a retirement pass must clamp against
   * {@link log_seq_start} rather than trust this value.
   */
  log_delete_floor?: number;

  /**
   * Opaque non-empty generation nonce, re-minted by every writer that
   * *replaces* this collection rather than advancing it — the two
   * `baerly admin restore` seeds and the writer/dev auto-provision
   * paths. Steady-state writers (the compactor's fold CAS,
   * {@link claimWriter}, every {@link casUpdateCurrentJson} mutator)
   * carry it through untouched, so it changes only on truncate or
   * re-provision. Mint with {@link mintGeneration}.
   *
   * `/v1/since` pairs it with each entry's `lsn` to build the cursor it
   * hands clients, then rejects a resume whose generation no longer
   * matches. Without it, a `restore --force` that reseeds
   * `log_seq_start` BELOW the old floor (the deliberate floor exemption
   * — invariant 12 in `docs/spec/sync-protocol.md`) lets a pre-restore
   * cursor clear the `cursorSeq < log_seq_start` gate and silently skip
   * every restored row beneath it.
   *
   * Deliberately NOT `writer_fence.epoch`: the fresh-target restore
   * branch seeds `epoch: 0`, so a truncate-to-empty is indistinguishable
   * from a genuine epoch-0 collection. A counter that resets cannot
   * discriminate generations; a nonce can.
   *
   * Optional because it postdates `schema_version: 3` and buckets
   * written by earlier builds do not carry it. Absent is a well-defined
   * state, not a degraded one — it decodes to `NO_GENERATION` on both
   * sides of the comparison (see `../cursor.ts`), so a collection that
   * was never truncated keeps resuming normally.
   */
  generation?: string;
}

/**
 * Fence-token sub-shape embedded in {@link CurrentJson}. The
 * monotonically-bumped `epoch` is the only safety-critical field —
 * `owner` is informational and may be missing in older records;
 * `claimed_at` is the server response date at claim time, NOT the
 * local clock; `lease_until` is reserved for manual rotation and is not
 * consumed by the current kernel. Log entries are not stamped with this
 * epoch; the fence is dormant authority metadata, not a reader replay
 * filter.
 *
 * Borrowed from FoundationDB's `recoveryCount` on cstate, IsleDB's
 * `writer_fence` on `manifest/CURRENT`, and TigerBeetle's VSR view
 * number. In the earlier two-write commit design, every commit checked
 * the epoch before continuing under `current.json` authority. Under
 * single-write commit no production path reads or writes the fence.
 */
export interface WriterFence {
  /**
   * Monotonic unsigned integer. Bumped only by an explicit
   * {@link claimWriter} call — do NOT bump on every cold start, do
   * NOT bump on every commit. Under single-write commit this is retained
   * as an explicit admin/testing primitive only; no production commit
   * path claims or verifies the fence.
   */
  epoch: number;

  /**
   * Owner identifier — debug only, NOT consulted for safety.
   * Suggested shape: `<worker_id>@<deploy_id>`. May be the empty
   * string when claim provenance is unknown (e.g. initial
   * creation). Safety derives from `epoch`, not from `owner`.
   */
  owner: string;

  /**
   * ISO-8601 timestamp from the `StoragePutResult.serverDate` on
   * the successful CAS PUT. **Never use `new Date()` or
   * `Date.now()` to populate this field** — under multi-instance
   * deployment the local clock may disagree with peers; the
   * server's clock is the only one all instances share. Format
   * via `serverDate.toISOString()`. The empty string `""` means
   * "claim time unknown" — readers MUST treat it as such rather
   * than parsing it.
   */
  claimed_at: string;

  /**
   * Optional explicit lease horizon, also ISO-8601. Reserved for
   * future manual rotation workflows; current code only writes
   * the field through if a caller supplies it and does not read
   * it.
   */
  lease_until?: string;
}

/**
 * Return shape from {@link readCurrentJson} et al.: the parsed JSON
 * plus the ETag needed for a follow-up CAS write.
 */
export interface CurrentJsonRead {
  readonly json: CurrentJson;
  readonly etag: string;
}

/**
 * Read + parse `current.json` at `key`. Returns `null` on not-found.
 *
 * @throws BaerlyError{code:"InvalidResponse"} — body is not valid
 *         JSON, or `schema_version` is unknown, or the shape fails
 *         the runtime guard.
 */
export async function readCurrentJson(
  storage: Storage,
  key: string,
  opts?: { signal?: AbortSignal },
): Promise<CurrentJsonRead | null> {
  const got = await storage.get(key, opts);
  if (got === null) {
    return null;
  }
  const text = new TextDecoder().decode(got.body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new BaerlyError(
      "InvalidResponse",
      `current.json at ${key}: body is not valid JSON`,
      error,
    );
  }
  return { json: assertCurrentJson(parsed, key), etag: got.etag };
}

/**
 * Mint a fresh {@link CurrentJson.generation} nonce.
 *
 * Twelve lowercase hex characters (≈2.8 × 10¹⁴ values) — sized so the
 * birthday bound is unreachable across the truncates a bucket sees in
 * its lifetime, while costing only twelve bytes on every `/v1/since`
 * response. A collision would let a stale cursor resume into a
 * truncated generation, which is the exact failure this field exists to
 * prevent, so the margin is deliberate.
 *
 * `crypto.randomUUID` is universally available (Node 19+, Workerd, Bun,
 * browsers) — the same source `uuid()` in `../types.ts` uses.
 *
 * Call this only where a collection is REPLACED, never where one is
 * advanced; see {@link CurrentJson.generation} for the writer split.
 */
export const mintGeneration = (): string => crypto.randomUUID().replaceAll("-", "").slice(0, 12);

/**
 * The charset {@link mintGeneration} emits and `/v1/since` accepts in
 * the generation half of a cursor. Pinned so the manifest validator
 * and the wire validator cannot drift.
 */
const GENERATION_RE = /^[0-9a-f]+$/;

/**
 * Create `current.json` if-and-only-if it does not exist (S3
 * `If-None-Match: "*"`). Use this once per collection at provisioning
 * time; subsequent updates go through {@link casUpdateCurrentJson}.
 *
 * @throws BaerlyError{code:"Conflict"} — the key already exists.
 *         Caller decides whether to read + reconcile or surface.
 * @throws BaerlyError{code:"InvalidResponse"} — `initial` fails the
 *         runtime shape guard.
 */
export async function createCurrentJson(
  storage: Storage,
  key: string,
  initial: CurrentJson,
  opts?: { signal?: AbortSignal },
): Promise<CurrentJsonRead> {
  assertCurrentJson(initial, key);
  const body = encodeJson(initial);
  const putOpts: StoragePutOptions = {
    ifNoneMatch: "*",
    contentType: CURRENT_JSON_CONTENT_TYPE,
    ...(opts?.signal !== undefined && { signal: opts.signal }),
  };
  let result: StoragePutResult;
  try {
    result = await storage.put(key, body, putOpts);
  } catch (error) {
    throw translateCasError(error, key);
  }
  return { json: initial, etag: result.etag };
}

/**
 * Admission control for a `current.json` state transition.
 *
 * Distinct from {@link assertCurrentJson}, which validates one state in
 * isolation and therefore structurally cannot express a rule about a
 * pair of states. Every invariant that compares before/after belongs
 * here, and every writer that bypasses {@link casUpdateCurrentJson}
 * MUST call it directly — "monotone by construction" is an argument
 * that has to be re-made every time the writer is reimplemented, and
 * it does not survive a chunk-aware compactor or a read-banking path.
 *
 * `Internal`, not `InvalidResponse`: the fault is a local caller's
 * mutator, not a malformed storage response, and `InvalidResponse` maps
 * to HTTP 502 ("storage upstream failed"), which would misattribute a
 * programmer error to the bucket.
 *
 * @throws BaerlyError{code:"Internal"} on any violated transition rule.
 * @see docs/spec/sync-protocol.md invariant 12
 */
export const assertCurrentJsonTransition = (
  before: CurrentJson,
  after: CurrentJson,
  key: string,
): void => {
  // A regressed floor makes a stale pre-fold reader cursor pass the
  // `cursorSeq < log_seq_start` re-bootstrap check (http/since.ts)
  // instead of failing it. Equality is permitted: the `tail_hint`
  // refresh and the `last_warned_seq` stamp in maintenance.ts both hold
  // the floor fixed.
  if (after.log_seq_start < before.log_seq_start) {
    throw new BaerlyError(
      "Internal",
      `current.json at ${key}: log_seq_start must not decrease (${String(before.log_seq_start)} → ${String(after.log_seq_start)})`,
    );
  }
  // Same argument one floor down, and read through the accessor on BOTH
  // sides: absent means "no deleted prefix is certified", so a pre-field
  // manifest compares as 0 rather than as `undefined`.
  const beforeDeleteFloor = logDeleteFloorOf(before);
  const afterDeleteFloor = logDeleteFloorOf(after);
  if (afterDeleteFloor < beforeDeleteFloor) {
    throw new BaerlyError(
      "Internal",
      `current.json at ${key}: log_delete_floor must not decrease (${String(beforeDeleteFloor)} → ${String(afterDeleteFloor)})`,
    );
  }
  // Deleting at or above the live floor would remove an object a reader
  // walking `[log_seq_start, tail_hint)` still needs. This is the hard
  // safety line for both maintenance triggers.
  if (afterDeleteFloor > after.log_seq_start) {
    throw new BaerlyError(
      "Internal",
      `current.json at ${key}: log_delete_floor must not exceed log_seq_start (${String(afterDeleteFloor)} > ${String(after.log_seq_start)})`,
    );
  }
};

/**
 * Read-modify-write `current.json` under CAS. The `mutator` receives
 * a deep clone of the current parsed JSON (mutate freely) and returns
 * the new state. The new state is written with `If-Match:
 * <currentEtag>`; on conflict, throws.
 *
 * `mutator` MUST be synchronous and deterministic — it may be called
 * multiple times if the caller wraps this in a retry loop, so it
 * must not have side effects.
 *
 * @throws BaerlyError{code:"Conflict"} — another writer landed a write
 *         between this function's read and write. Caller decides
 *         whether to retry (read + remutate + rewrite).
 * @throws BaerlyError{code:"InvalidResponse"} — `key` does not exist
 *         (use {@link createCurrentJson} instead) or body doesn't
 *         parse / fails the shape guard.
 * @throws BaerlyError{code:"Internal"} — the mutator decreased
 *         `log_seq_start`, decreased `log_delete_floor`, or set
 *         `log_delete_floor > log_seq_start`. Equality is permitted.
 *         The compactor calls the same transition validator before its
 *         direct `If-Match` PUT; `baerly admin restore --force` is the
 *         deliberate truncate exemption.
 */
export async function casUpdateCurrentJson(
  storage: Storage,
  key: string,
  mutator: (current: CurrentJson) => CurrentJson,
  opts?: { signal?: AbortSignal },
): Promise<CurrentJsonRead> {
  const existing = await readCurrentJson(storage, key, opts);
  if (existing === null) {
    throw new BaerlyError(
      "InvalidResponse",
      `current.json at ${key} does not exist; use createCurrentJson first`,
    );
  }
  // Defensive deep clone so a mutator that mutates its argument can't
  // corrupt the original record on the caller's retry path.
  // `structuredClone` is a global on Node ≥17 and Workers; the package
  // targets Node ≥24 so it is safe.
  const next = mutator(structuredClone(existing.json));
  assertCurrentJson(next, key);
  assertCurrentJsonTransition(existing.json, next, key);
  const body = encodeJson(next);
  const putOpts: StoragePutOptions = {
    ifMatch: existing.etag,
    contentType: CURRENT_JSON_CONTENT_TYPE,
    ...(opts?.signal !== undefined && { signal: opts.signal }),
  };
  let result: StoragePutResult;
  try {
    result = await storage.put(key, body, putOpts);
  } catch (error) {
    throw translateCasError(error, key);
  }
  return { json: next, etag: result.etag };
}

/**
 * Claim ownership of the dormant write fence by bumping `epoch` and
 * stamping `claimed_at` from `StoragePutResult.serverDate`. Under
 * single-write commit there is no production commit-path call site;
 * this is retained for explicit admin/testing workflows and future
 * rotation designs.
 *
 * `owner` is informational — see {@link WriterFence.owner}. Safety
 * derives from the monotonic `epoch`, not from `owner`.
 *
 * Implementation note (two round-trips): because
 * `StoragePutResult.serverDate` is only known *after* the CAS PUT
 * lands, this function writes the record with `claimed_at: ""`
 * first, then overwrites itself with the correct
 * `serverDate.toISOString()` in a second CAS. A peer landing between
 * the two writes loses cleanly with `Conflict` — the epoch bump is
 * already durable from the first put either way. If `serverDate` is
 * `undefined` on the first PUT (impl doesn't surface it), the second
 * write is skipped and `claimed_at` remains the empty string;
 * readers MUST treat the empty string as "unknown claim time"
 * rather than parsing it.
 *
 * @see {@link ../../../../docs/spec/writer-fence-adversarial-model.md} —
 *   the full failure envelope (absent / lying / non-monotonic Date,
 *   peer-between-PUTs, bounded clock skew), and the "Differentiation
 *   from mps3" subsection framing the §103 non-obviousness story.
 * @see {@link ../../../../docs/spec/prior-art.md} —
 *   IDS-shaped prior-art differentiation against mps3, SlateDB,
 *   Iceberg, Delta, and the broader S3-leader-election literature.
 *
 * @throws BaerlyError{code:"Conflict"} — another writer claimed the
 *         fence between this call's read and write. Caller decides
 *         whether to retry.
 * @throws BaerlyError{code:"InvalidResponse"} — `key` does not exist.
 */
export async function claimWriter(
  storage: Storage,
  key: string,
  owner: string,
  opts?: { signal?: AbortSignal },
): Promise<CurrentJsonRead> {
  const existing = await readCurrentJson(storage, key, opts);
  if (existing === null) {
    throw new BaerlyError(
      "InvalidResponse",
      `current.json at ${key} does not exist; use createCurrentJson first`,
    );
  }
  const provisional: CurrentJson = {
    ...existing.json,
    writer_fence: {
      epoch: existing.json.writer_fence.epoch + 1,
      owner,
      // Will be overwritten with serverDate.toISOString() once the put
      // returns, when the impl surfaces it. Stays `""` ("unknown") if
      // the impl doesn't.
      claimed_at: "",
      // Stryker disable next-line ConditionalExpression: `→true` spreads `{lease_until: undefined}` which JSON.stringify omits, so the stored bytes are identical to the normal `→false` path (no key emitted). Genuine equivalent mutant.
      ...(existing.json.writer_fence.lease_until !== undefined && {
        lease_until: existing.json.writer_fence.lease_until,
      }),
    },
  };
  assertCurrentJsonTransition(existing.json, provisional, key);
  const body = encodeJson(provisional);
  const putOpts: StoragePutOptions = {
    ifMatch: existing.etag,
    contentType: CURRENT_JSON_CONTENT_TYPE,
    ...(opts?.signal !== undefined && { signal: opts.signal }),
  };
  let result: StoragePutResult;
  try {
    result = await storage.put(key, body, putOpts);
  } catch (error) {
    throw translateCasError(error, key);
  }
  // No server clock surfaced — leave `claimed_at` empty. The epoch
  // bump is durable; safety is unaffected.
  if (result.serverDate === undefined) {
    return { json: provisional, etag: result.etag };
  }
  // Stamp the server clock through a second CAS-on-our-own-etag. A
  // peer landing between the two writes loses cleanly with Conflict
  // (the fence is safe — next claim will bump past both).
  const stamped: CurrentJson = {
    ...provisional,
    writer_fence: {
      ...provisional.writer_fence,
      claimed_at: result.serverDate.toISOString(),
    },
  };
  assertCurrentJsonTransition(provisional, stamped, key);
  const stampedBody = encodeJson(stamped);
  const stampPutOpts: StoragePutOptions = {
    ifMatch: result.etag,
    contentType: CURRENT_JSON_CONTENT_TYPE,
    ...(opts?.signal !== undefined && { signal: opts.signal }),
  };
  let stampResult: StoragePutResult;
  try {
    stampResult = await storage.put(key, stampedBody, stampPutOpts);
  } catch (error) {
    throw translateCasError(error, key);
  }
  return { json: stamped, etag: stampResult.etag };
}

/**
 * Read `current.json.log_seq_start` — the low-water mark of the live
 * log range `[log_seq_start, tail_hint)`. The field is always present
 * on disk (every `createCurrentJson` write seeds it; the compactor
 * advances it on every fold); this helper exists to document intent
 * at call sites that walk the log range or assert the snapshot
 * invariants.
 */
export const logSeqStartOf = (c: CurrentJson): number => c.log_seq_start;

/**
 * Read `log_delete_floor`, defaulting an absent field to `0`. Absent
 * means "no deleted prefix is certified", which is exactly what a
 * pre-field bucket records even if older GC deleted sparse log objects.
 */
export const logDeleteFloorOf = (c: CurrentJson): number => c.log_delete_floor ?? 0;

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

const encodeJson = (json: CurrentJson): Uint8Array => encodeJsonBytes(json);

/**
 * Runtime guard for `parsed` to be a {@link CurrentJson}. Throws
 * `BaerlyError{code:"InvalidResponse"}` rather than coercing. Tolerant
 * reader: unknown keys ignored, new required fields bump
 * `schema_version` (move (b), ADR-003).
 */
const assertCurrentJson = (parsed: unknown, key: string): CurrentJson => {
  if (parsed === null || typeof parsed !== "object") {
    throw new BaerlyError(
      "InvalidResponse",
      `current.json at ${key}: parsed body is not an object`,
    );
  }
  const r = parsed as Record<string, unknown>;
  if (r["schema_version"] === 1 || r["schema_version"] === 2) {
    throw new BaerlyError(
      "InvalidResponse",
      `current.json at ${key} uses schema v${String(r["schema_version"])} from a pre-0.3.0 internal build; this build requires schema v${CURRENT_JSON_SCHEMA_VERSION}. Dump/restore with the old build, or re-provision scratch/local buckets.`,
    );
  }
  if (r["schema_version"] !== CURRENT_JSON_SCHEMA_VERSION) {
    throw new BaerlyError(
      "InvalidResponse",
      `current.json at ${key}: unsupported schema_version ${String(r["schema_version"])}; this build requires ${CURRENT_JSON_SCHEMA_VERSION}. This almost always means stale scratch data from a different build — wipe the local dev bucket (e.g. \`rm -rf .baerly-data\`) or recreate the R2/S3 bucket, then retry.`,
    );
  }
  if (!(typeof r["snapshot"] === "string" || r["snapshot"] === null)) {
    throw new BaerlyError(
      "InvalidResponse",
      `current.json at ${key}: snapshot must be string|null`,
    );
  }
  // Stryker disable next-line ConditionalExpression,StringLiteral: three equivalent mutants on this line — (1) `typeof r["tail_hint"] !== "number"` → false is subsumed by !Number.isInteger (which rejects all non-numbers); (2) `r["tail_hint"] < 0` → false is subsumed by the downstream `log_seq_start > tail_hint` cross-check (log_seq_start ≥ 0, so log_seq_start > negative_tail_hint always fires); (3) StringLiteral "tail_hint" → "" turns r[""] → undefined → !Number.isInteger(undefined) still true → still throws.
  if (
    typeof r["tail_hint"] !== "number" ||
    !Number.isInteger(r["tail_hint"]) ||
    r["tail_hint"] < 0
  ) {
    throw new BaerlyError(
      "InvalidResponse",
      `current.json at ${key}: tail_hint must be a non-negative integer`,
    );
  }
  if (
    // Stryker disable next-line ConditionalExpression: `typeof r["log_seq_start"] !== "number"` → false is equivalent — !Number.isInteger rejects all non-numbers anyway, making the typeof check fully subsumed.
    typeof r["log_seq_start"] !== "number" ||
    !Number.isInteger(r["log_seq_start"]) ||
    r["log_seq_start"] < 0
  ) {
    throw new BaerlyError(
      "InvalidResponse",
      `current.json at ${key}: log_seq_start must be a non-negative integer`,
    );
  }
  if (r["log_seq_start"] > r["tail_hint"]) {
    throw new BaerlyError(
      "InvalidResponse",
      `current.json at ${key}: log_seq_start ${String(r["log_seq_start"])} > tail_hint ${String(r["tail_hint"])}`,
    );
  }
  const fence = r["writer_fence"];
  if (fence === null || typeof fence !== "object") {
    throw new BaerlyError("InvalidResponse", `current.json at ${key}: writer_fence missing`);
  }
  const f = fence as Record<string, unknown>;
  // Stryker disable next-line ConditionalExpression: same rationale as `log_seq_start` above.
  if (typeof f["epoch"] !== "number" || !Number.isInteger(f["epoch"]) || f["epoch"] < 0) {
    throw new BaerlyError(
      "InvalidResponse",
      `current.json at ${key}: writer_fence.epoch must be a non-negative integer`,
    );
  }
  if (typeof f["owner"] !== "string") {
    throw new BaerlyError(
      "InvalidResponse",
      `current.json at ${key}: writer_fence.owner must be a string`,
    );
  }
  if (typeof f["claimed_at"] !== "string") {
    throw new BaerlyError(
      "InvalidResponse",
      `current.json at ${key}: writer_fence.claimed_at must be a string`,
    );
  }
  if (f["lease_until"] !== undefined && typeof f["lease_until"] !== "string") {
    throw new BaerlyError(
      "InvalidResponse",
      `current.json at ${key}: writer_fence.lease_until must be string if present`,
    );
  }
  if (
    // Stryker disable next-line ConditionalExpression: same rationale as `log_seq_start` above.
    typeof r["snapshot_bytes"] !== "number" ||
    !Number.isInteger(r["snapshot_bytes"]) ||
    r["snapshot_bytes"] < 0
  ) {
    throw new BaerlyError(
      "InvalidResponse",
      `current.json at ${key}: snapshot_bytes must be a non-negative integer`,
    );
  }
  if (
    // Stryker disable next-line ConditionalExpression: same rationale as `log_seq_start` above.
    typeof r["snapshot_rows"] !== "number" ||
    !Number.isInteger(r["snapshot_rows"]) ||
    r["snapshot_rows"] < 0
  ) {
    throw new BaerlyError(
      "InvalidResponse",
      `current.json at ${key}: snapshot_rows must be a non-negative integer`,
    );
  }
  if (
    r["last_warned_seq"] !== undefined &&
    // Stryker disable next-line ConditionalExpression: same rationale as `log_seq_start` above.
    (typeof r["last_warned_seq"] !== "number" ||
      !Number.isInteger(r["last_warned_seq"]) ||
      r["last_warned_seq"] < 0)
  ) {
    throw new BaerlyError(
      "InvalidResponse",
      `current.json at ${key}: last_warned_seq must be a non-negative integer if present`,
    );
  }
  // Shape only. `log_delete_floor <= log_seq_start` is deliberately NOT
  // checked here: `readCurrentJson` sits on `admin restore`'s own path
  // (it reads `head` before it can reseed), so rejecting a single state
  // on that bound would turn an out-of-bound floor into a bucket with no
  // in-product repair path. The bound is transition-scoped in
  // {@link assertCurrentJsonTransition}, and consumers of the field
  // clamp against `log_seq_start` rather than trust it.
  if (
    r["log_delete_floor"] !== undefined &&
    // Stryker disable next-line ConditionalExpression: same rationale as `log_seq_start` above.
    (typeof r["log_delete_floor"] !== "number" ||
      !Number.isInteger(r["log_delete_floor"]) ||
      r["log_delete_floor"] < 0)
  ) {
    throw new BaerlyError(
      "InvalidResponse",
      `current.json at ${key}: log_delete_floor must be a non-negative integer if present`,
    );
  }
  if (
    r["mean_entry_bytes"] !== undefined &&
    // Stryker disable next-line ConditionalExpression: same rationale as `log_seq_start` above.
    (typeof r["mean_entry_bytes"] !== "number" ||
      !Number.isInteger(r["mean_entry_bytes"]) ||
      r["mean_entry_bytes"] < 0)
  ) {
    throw new BaerlyError(
      "InvalidResponse",
      `current.json at ${key}: mean_entry_bytes must be a non-negative integer if present`,
    );
  }
  if (
    r["generation"] !== undefined &&
    (typeof r["generation"] !== "string" || !GENERATION_RE.test(r["generation"]))
  ) {
    // Charset, not just type. `""` would format a cursor as `.<lsn>`,
    // which `parseCursor` reads as generation `""` rather than as the
    // `NO_GENERATION` sentinel. Anything outside `[0-9a-f]` (a `.`
    // worst of all) would mint a cursor `/v1/since` then refuses on
    // resume — the server rejecting a token it issued, which a client
    // reads as a permanently dead cursor. Matching the wire charset
    // means a manifest that reads clean here always round-trips.
    throw new BaerlyError(
      "InvalidResponse",
      `current.json at ${key}: generation must be a non-empty lowercase-hex string if present`,
    );
  }
  return parsed as CurrentJson;
};

/**
 * Wrap a storage-level error with `current.json at <key>` location
 * context. `Conflict` (the storage layer's CAS-lost signal) is
 * re-thrown with an annotated message; other `BaerlyError`s pass
 * through; non-`BaerlyError` falls through as `InvalidResponse` (in
 * practice unreachable — every in-tree `Storage` impl wraps).
 */
const translateCasError = (e: unknown, key: string): BaerlyError => {
  if (e instanceof BaerlyError && e.code === "Conflict") {
    return new BaerlyError("Conflict", `current.json CAS lost at ${key}: ${e.message}`, e);
  }
  if (e instanceof BaerlyError) {
    return e;
  }
  return new BaerlyError("InvalidResponse", `current.json write at ${key} failed: ${String(e)}`, e);
};
