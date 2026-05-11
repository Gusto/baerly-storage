/**
 * `current.json` — the per-collection CAS-protected control object — and
 * its embedded {@link WriterFence} epoch token.
 *
 * A dedicated `coordination/` namespace (parallel to `storage/`) holds
 * primitives whose contract is "atomic agreement over a small JSON
 * object" rather than "byte I/O." Future siblings (Phase 5 compactor
 * manifest, Phase 6 sweeper checkpoint) join here, not at the top
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
 * Why CAS errors are translated to `Conflict`: every in-tree
 * {@link Storage} impl surfaces a lost CAS as
 * `MPS3Error{code:"InvalidResponse", message:"PreconditionFailed: …"}`.
 * Downstream callers — the Phase 3 ServerWriter, the Phase 5
 * compactor, the Phase 6 sweeper — discriminate by `code` to decide
 * whether to retry, so we translate at this module's boundary rather
 * than asking every caller to string-match `PreconditionFailed:`.
 */

import { CURRENT_JSON_CONTENT_TYPE, CURRENT_JSON_SCHEMA_VERSION } from "../constants";
import { MPS3Error } from "../errors";
import type { Storage, StoragePutOptions, StoragePutResult } from "../storage/types";

/**
 * Per-collection control object. CAS-protected. One per
 * `(tenant, collection)` key — for example
 * `<tenant>/<collection>/current.json`. The Phase 5 compactor swaps
 * snapshot generations by CAS-writing this object; the Phase 3
 * ServerWriter reads it on every commit to find the snapshot
 * pointer; the Phase 6 sweeper reads `writer_fence` to decide
 * which log entries are eligible for GC.
 *
 * The schema is forward-compatible: adding a new optional field is
 * non-breaking. Renaming or removing a field requires bumping
 * {@link CURRENT_JSON_SCHEMA_VERSION} to `2`; readers MUST reject
 * unknown major versions with `MPS3Error{code:"InvalidResponse"}`.
 */
export interface CurrentJson {
  /**
   * Schema version. Today: `1`. Bump on any breaking change to
   * field semantics; readers must reject unknown major versions
   * with `MPS3Error{code:"InvalidResponse"}`.
   */
  schema_version: 1;

  /**
   * Pointer to the current snapshot generation. `null` before the
   * first compaction has produced a snapshot — readers fall back
   * to log-only replay. Shape is opaque-to-this-module; the
   * compactor owns its interpretation.
   */
  snapshot: string | null;

  /**
   * Sequence number of the next log entry. Monotonic per
   * collection. The ServerWriter reads this on commit to mint the
   * next log filename; CAS-write back with `next_seq + 1` ensures
   * no two writers pick the same sequence.
   */
  next_seq: number;

  /**
   * Lowest live log sequence number. Entries with `seq < log_seq_start`
   * have been folded into the snapshot at {@link snapshot} (or, if
   * `snapshot === null`, have been dropped because the collection was
   * truncated). Readers walk `[log_seq_start, next_seq)`. Defaults to
   * `0` when missing (old records pre-Phase-5) — backward-compatible
   * with collections provisioned before this field landed. Always read
   * through {@link logSeqStartOf} rather than destructuring inline.
   *
   * Invariants the compactor maintains:
   *   - `0 <= log_seq_start <= next_seq`
   *   - `log_seq_start` advances monotonically (never decreases)
   *   - `log_seq_start > 0` implies `snapshot !== null` (the snapshot
   *     covers `[0, log_seq_start)`)
   */
  log_seq_start?: number;

  /**
   * Embedded write-fence epoch. See {@link WriterFence}.
   */
  writer_fence: WriterFence;
}

/**
 * Fence-token sub-shape embedded in {@link CurrentJson}. The
 * monotonically-bumped `epoch` is the only safety-critical field —
 * `owner` is informational and may be missing in older records;
 * `claimed_at` is the server response date at claim time, NOT the
 * local clock; `lease_until` is reserved for manual rotation and
 * is not consumed by any ticket in this batch.
 *
 * Borrowed from FoundationDB's `recoveryCount` on cstate, IsleDB's
 * `writer_fence` on `manifest/CURRENT`, and TigerBeetle's VSR view
 * number. The mechanism is the same in all three: every commit
 * checks the epoch on the control object; an entry stamped with
 * a stale epoch is discarded at replay.
 */
export interface WriterFence {
  /**
   * Monotonic unsigned integer. Bumped only by an explicit
   * {@link claimWriter} call — do NOT bump on every cold start, do
   * NOT bump on every commit. Triggers per design: (a) detected
   * CAS conflict the writer wants to claim through, (b) admin
   * rotation. The Phase 6 sweeper discards log entries whose
   * stamped epoch is `< current.writer_fence.epoch`.
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
   * Phase 6+ manual rotation workflows; this ticket only writes
   * the field through if a caller supplies it. No code in this
   * batch reads it.
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
 * @throws MPS3Error{code:"InvalidResponse"} — body is not valid
 *         JSON, or `schema_version` is unknown, or the shape fails
 *         the runtime guard.
 */
export async function readCurrentJson(
  storage: Storage,
  key: string,
  opts?: { signal?: AbortSignal },
): Promise<CurrentJsonRead | null> {
  const got = await storage.get(key, opts);
  if (got === null) return null;
  const text = new TextDecoder().decode(got.body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new MPS3Error("InvalidResponse", `current.json at ${key}: body is not valid JSON`, e);
  }
  return { json: assertCurrentJson(parsed, key), etag: got.etag };
}

/**
 * Create `current.json` if-and-only-if it does not exist (S3
 * `If-None-Match: "*"`). Use this once per collection at provisioning
 * time; subsequent updates go through {@link casUpdateCurrentJson}.
 *
 * @throws MPS3Error{code:"Conflict"} — the key already exists.
 *         Caller decides whether to read + reconcile or surface.
 * @throws MPS3Error{code:"InvalidResponse"} — `initial` fails the
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
  } catch (e) {
    throw translateCasError(e, key);
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
 * @throws MPS3Error{code:"Conflict"} — another writer landed a write
 *         between this function's read and write. Caller decides
 *         whether to retry (read + remutate + rewrite).
 * @throws MPS3Error{code:"InvalidResponse"} — `key` does not exist
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
    throw new MPS3Error(
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
  } catch (e) {
    throw translateCasError(e, key);
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
 * @throws MPS3Error{code:"Conflict"} — another writer claimed the
 *         fence between this call's read and write. Caller decides
 *         whether to retry.
 * @throws MPS3Error{code:"InvalidResponse"} — `key` does not exist.
 */
export async function claimWriter(
  storage: Storage,
  key: string,
  owner: string,
  opts?: { signal?: AbortSignal },
): Promise<CurrentJsonRead> {
  const existing = await readCurrentJson(storage, key, opts);
  if (existing === null) {
    throw new MPS3Error(
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
  } catch (e) {
    throw translateCasError(e, key);
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
  } catch (e) {
    throw translateCasError(e, key);
  }
  return { json: stamped, etag: stampResult.etag };
}

/**
 * Read `current.json.log_seq_start`, treating the missing-field case
 * as `0`. Callers should always go through this helper rather than
 * destructuring `c.log_seq_start ?? 0` inline — the helper centralises
 * the "no snapshot yet" / "old record" contract in one place, and is
 * the single read-side seam ticket 14 (compactor write) and ticket 15
 * (log GC sweep) will share with the reader and writer paths.
 */
export const logSeqStartOf = (c: CurrentJson): number => c.log_seq_start ?? 0;

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

const encodeJson = (json: CurrentJson): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(json));

/**
 * Runtime guard for `parsed` to be a {@link CurrentJson}. Throws
 * `MPS3Error{code:"InvalidResponse"}` rather than coercing — readers
 * never silently accept an unknown shape.
 */
const assertCurrentJson = (parsed: unknown, key: string): CurrentJson => {
  if (parsed === null || typeof parsed !== "object") {
    throw new MPS3Error("InvalidResponse", `current.json at ${key}: parsed body is not an object`);
  }
  const r = parsed as Record<string, unknown>;
  if (r.schema_version !== CURRENT_JSON_SCHEMA_VERSION) {
    throw new MPS3Error(
      "InvalidResponse",
      `current.json at ${key}: unsupported schema_version ${String(r.schema_version)}; expected ${CURRENT_JSON_SCHEMA_VERSION}`,
    );
  }
  if (!(typeof r.snapshot === "string" || r.snapshot === null)) {
    throw new MPS3Error("InvalidResponse", `current.json at ${key}: snapshot must be string|null`);
  }
  if (typeof r.next_seq !== "number" || !Number.isInteger(r.next_seq) || r.next_seq < 0) {
    throw new MPS3Error(
      "InvalidResponse",
      `current.json at ${key}: next_seq must be a non-negative integer`,
    );
  }
  if (
    r.log_seq_start !== undefined &&
    (typeof r.log_seq_start !== "number" ||
      !Number.isInteger(r.log_seq_start) ||
      r.log_seq_start < 0)
  ) {
    throw new MPS3Error(
      "InvalidResponse",
      `current.json at ${key}: log_seq_start must be a non-negative integer if present`,
    );
  }
  if (
    typeof r.log_seq_start === "number" &&
    typeof r.next_seq === "number" &&
    r.log_seq_start > r.next_seq
  ) {
    throw new MPS3Error(
      "InvalidResponse",
      `current.json at ${key}: log_seq_start ${String(r.log_seq_start)} > next_seq ${String(r.next_seq)}`,
    );
  }
  const fence = r.writer_fence;
  if (fence === null || typeof fence !== "object") {
    throw new MPS3Error("InvalidResponse", `current.json at ${key}: writer_fence missing`);
  }
  const f = fence as Record<string, unknown>;
  if (typeof f.epoch !== "number" || !Number.isInteger(f.epoch) || f.epoch < 0) {
    throw new MPS3Error(
      "InvalidResponse",
      `current.json at ${key}: writer_fence.epoch must be a non-negative integer`,
    );
  }
  if (typeof f.owner !== "string") {
    throw new MPS3Error(
      "InvalidResponse",
      `current.json at ${key}: writer_fence.owner must be a string`,
    );
  }
  if (typeof f.claimed_at !== "string") {
    throw new MPS3Error(
      "InvalidResponse",
      `current.json at ${key}: writer_fence.claimed_at must be a string`,
    );
  }
  if (f.lease_until !== undefined && typeof f.lease_until !== "string") {
    throw new MPS3Error(
      "InvalidResponse",
      `current.json at ${key}: writer_fence.lease_until must be string if present`,
    );
  }
  return parsed as CurrentJson;
};

/**
 * Translate a storage-level CAS guard failure
 * (`InvalidResponse / "PreconditionFailed: …"`) into `Conflict` so
 * downstream callers can discriminate by `code` without string-
 * matching. Other errors pass through unchanged.
 */
const translateCasError = (e: unknown, key: string): MPS3Error => {
  if (
    e instanceof MPS3Error &&
    e.code === "InvalidResponse" &&
    e.message.startsWith("PreconditionFailed:")
  ) {
    return new MPS3Error("Conflict", `current.json CAS lost at ${key}: ${e.message}`, e);
  }
  if (e instanceof MPS3Error) return e;
  return new MPS3Error("InvalidResponse", `current.json write at ${key} failed: ${String(e)}`, e);
};
