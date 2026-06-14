/**
 * `current.json` — the per-collection CAS-protected control object — and
 * its embedded {@link WriterFence} epoch token.
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
 * commit to find the snapshot pointer, mint the next integer `seq`, and
 * verify stale-authority fencing.
 *
 * The schema is forward-compatible: adding a new optional field is
 * non-breaking. Renaming or removing a field requires bumping
 * {@link CURRENT_JSON_SCHEMA_VERSION}; readers MUST reject
 * unknown major versions with `BaerlyError{code:"InvalidResponse"}`.
 */
export interface CurrentJson {
  /**
   * Schema version. Today: `2`. Bump on any breaking change to
   * field semantics; readers must reject unknown major versions
   * with `BaerlyError{code:"InvalidResponse"}`.
   */
  schema_version: 2;

  /**
   * Pointer to the current snapshot generation. `null` before the
   * first compaction has produced a snapshot — readers fall back
   * to log-only replay. Shape is opaque-to-this-module; the
   * compactor owns its interpretation.
   */
  snapshot: string | null;

  /**
   * Sequence number of the next log entry. Monotonic per
   * collection. The Writer reads this on commit to mint the
   * next log filename; CAS-write back with `next_seq + 1` ensures
   * no two writers pick the same sequence.
   */
  next_seq: number;

  /**
   * Lowest live log sequence number. Entries with `seq < log_seq_start`
   * have been folded into the snapshot at {@link snapshot} (or, if
   * `snapshot === null`, have been dropped because the collection was
   * truncated). Readers walk `[log_seq_start, next_seq)`. Always
   * present on disk — fresh `current.json` writes via
   * {@link createCurrentJson} set this to `0`; the compactor advances
   * it on every fold.
   *
   * Invariants the compactor maintains:
   *   - `0 <= log_seq_start <= next_seq`
   *   - `log_seq_start` advances monotonically (never decreases)
   *   - `log_seq_start > 0` implies `snapshot !== null` (the snapshot
   *     covers `[0, log_seq_start)`)
   */
  log_seq_start: number;

  /**
   * Embedded write-fence epoch. See {@link WriterFence}.
   */
  writer_fence: WriterFence;

  // New in v2:

  /** EXACT byte size of the live log tail [log_seq_start, next_seq). Maintained exactly
   *  by the full-fence CAS on BOTH paths: each write adds its log bytes; a successful
   *  fold (which proves no concurrent write) resets to 0 from a known-empty tail. */
  tail_bytes: number;

  /** Byte size of the snapshot pointed to by `snapshot`. */
  snapshot_bytes: number;

  /** Row count of the snapshot (= compactor `base.size`, free). With next_seq - log_seq_start
   *  (tail entries) this gives the fold's entry count for the ENTRY ceiling `E`. Seeded 0. */
  snapshot_rows: number;

  /** Baseline for rate-limiting the graduation defer-warn off SHARED durable state, not
   *  per-isolate memory. The warn fires when next_seq - last_warned_seq >=
   *  MAINTENANCE_WARN_INTERVAL_WRITES, and that firing CASes last_warned_seq = next_seq.
   *  Absent → 0. */
  last_warned_seq?: number;
}

/**
 * Fence-token sub-shape embedded in {@link CurrentJson}. The
 * monotonically-bumped `epoch` is the only safety-critical field —
 * `owner` is informational and may be missing in older records;
 * `claimed_at` is the server response date at claim time, NOT the
 * local clock; `lease_until` is reserved for manual rotation and is not
 * consumed by the current kernel. Log entries are not stamped with this
 * epoch; the fence is a writer stale-authority check, not a reader
 * replay filter.
 *
 * Borrowed from FoundationDB's `recoveryCount` on cstate, IsleDB's
 * `writer_fence` on `manifest/CURRENT`, and TigerBeetle's VSR view
 * number. The mechanism is the same in all three: every commit checks
 * the epoch on the control object before continuing under its authority.
 */
export interface WriterFence {
  /**
   * Monotonic unsigned integer. Bumped only by an explicit
   * {@link claimWriter} call — do NOT bump on every cold start, do
   * NOT bump on every commit. Triggers per design: (a) detected
   * CAS conflict the writer wants to claim through, (b) admin
   * rotation.
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
  // Catch shape bugs in callers before they hit storage. Cheap.
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
 * Claim ownership of the write fence by bumping `epoch` and stamping
 * `claimed_at` from `StoragePutResult.serverDate`. The common call
 * site is "I detected a CAS conflict during a commit and want to
 * claim the fence before retrying"; admin rotation is the other call
 * site.
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
 *   peer-between-PUTs, bounded clock skew).
 * @see {@link ../../../../docs/spec/writer-fence-adversarial-model.md} —
 *   the "Differentiation from mps3" subsection that frames the §103
 *   non-obviousness story.
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
 * log range `[log_seq_start, next_seq)`. The field is always present
 * on disk (every `createCurrentJson` write seeds it; the compactor
 * advances it on every fold); this helper exists to document intent
 * at call sites that walk the log range or assert the snapshot
 * invariants.
 */
export const logSeqStartOf = (c: CurrentJson): number => c.log_seq_start;

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

const encodeJson = (json: CurrentJson): Uint8Array => encodeJsonBytes(json);

/**
 * Runtime guard for `parsed` to be a {@link CurrentJson}. Throws
 * `BaerlyError{code:"InvalidResponse"}` rather than coercing. Tolerant
 * reader: unknown keys ignored, new required fields bump
 * `schema_version` (move (b), ADR-007).
 */
const assertCurrentJson = (parsed: unknown, key: string): CurrentJson => {
  if (parsed === null || typeof parsed !== "object") {
    throw new BaerlyError(
      "InvalidResponse",
      `current.json at ${key}: parsed body is not an object`,
    );
  }
  const r = parsed as Record<string, unknown>;
  if (r["schema_version"] === 1) {
    throw new BaerlyError(
      "InvalidResponse",
      `current.json at ${key} is schema v1 (pre-maintenance); this build requires v2. Pre-launch, no production buckets — delete and re-seed the local-fs/Minio/Verdaccio scratch bucket, or recreate the R2/S3 bucket.`,
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
  // Stryker disable next-line ConditionalExpression,StringLiteral: three equivalent mutants on this line — (1) `typeof r["next_seq"] !== "number"` → false is subsumed by !Number.isInteger (which rejects all non-numbers); (2) `r["next_seq"] < 0` → false is subsumed by the downstream `log_seq_start > next_seq` cross-check (log_seq_start ≥ 0, so log_seq_start > negative_next_seq always fires); (3) StringLiteral "next_seq" → "" turns r[""] → undefined → !Number.isInteger(undefined) still true → still throws.
  if (typeof r["next_seq"] !== "number" || !Number.isInteger(r["next_seq"]) || r["next_seq"] < 0) {
    throw new BaerlyError(
      "InvalidResponse",
      `current.json at ${key}: next_seq must be a non-negative integer`,
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
  if (r["log_seq_start"] > r["next_seq"]) {
    throw new BaerlyError(
      "InvalidResponse",
      `current.json at ${key}: log_seq_start ${String(r["log_seq_start"])} > next_seq ${String(r["next_seq"])}`,
    );
  }
  const fence = r["writer_fence"];
  if (fence === null || typeof fence !== "object") {
    throw new BaerlyError("InvalidResponse", `current.json at ${key}: writer_fence missing`);
  }
  const f = fence as Record<string, unknown>;
  // Stryker disable next-line ConditionalExpression: `typeof f["epoch"] !== "number"` → false is equivalent — !Number.isInteger rejects all non-numbers, making the typeof guard fully subsumed.
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
    // Stryker disable next-line ConditionalExpression: `typeof r["tail_bytes"] !== "number"` → false is equivalent — !Number.isInteger rejects all non-numbers, making the typeof check fully subsumed.
    typeof r["tail_bytes"] !== "number" ||
    !Number.isInteger(r["tail_bytes"]) ||
    r["tail_bytes"] < 0
  ) {
    throw new BaerlyError(
      "InvalidResponse",
      `current.json at ${key}: tail_bytes must be a non-negative integer`,
    );
  }
  if (
    // Stryker disable next-line ConditionalExpression: `typeof r["snapshot_bytes"] !== "number"` → false is equivalent — !Number.isInteger rejects all non-numbers, making the typeof check fully subsumed.
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
    // Stryker disable next-line ConditionalExpression: `typeof r["snapshot_rows"] !== "number"` → false is equivalent — !Number.isInteger rejects all non-numbers, making the typeof check fully subsumed.
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
    // Stryker disable next-line ConditionalExpression: `typeof r["last_warned_seq"] !== "number"` → false is equivalent — !Number.isInteger rejects all non-numbers, making the typeof check fully subsumed.
    (typeof r["last_warned_seq"] !== "number" ||
      !Number.isInteger(r["last_warned_seq"]) ||
      r["last_warned_seq"] < 0)
  ) {
    throw new BaerlyError(
      "InvalidResponse",
      `current.json at ${key}: last_warned_seq must be a non-negative integer if present`,
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
