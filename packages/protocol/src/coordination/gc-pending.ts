/**
 * `gc/pending.json` — the per-collection GC candidate ledger. CAS-
 * protected; one per `(tenant, collection)` key — for example
 * `<tenant>/<collection>/gc/pending.json`. The compactor's sweep
 * (ticket 15) is the single writer that adds and removes entries.
 * Stays small in steady state because every candidate is deleted
 * once `due_at` passes.
 *
 * "Mark" appends candidates with a future `due_at`; "sweep" deletes
 * candidates whose `due_at` is in the past. The two phases run in
 * the same compactor pass — see `runGc()` in
 * `packages/server/src/gc.ts`.
 *
 * Lives next to {@link CurrentJson} in `coordination/` — same shape
 * of "CAS-protected small control object." Pure module; no Node
 * imports; Worker-bundleable.
 *
 * @see packages/server/src/gc.ts
 */

import { GC_PENDING_CONTENT_TYPE, GC_PENDING_SCHEMA_VERSION } from "../constants";
import { MPS3Error } from "../errors";
import type { Storage, StoragePutOptions, StoragePutResult } from "../storage/types";

/**
 * On-bucket body of `gc/pending.json`. Bounded by
 * `GC_MAX_PENDING_CANDIDATES`. The shape is forward-compatible:
 * adding a new optional field is non-breaking. Renaming or removing
 * a field requires bumping {@link GC_PENDING_SCHEMA_VERSION} to `2`;
 * readers MUST reject unknown major versions with
 * `MPS3Error{code:"InvalidResponse"}`.
 */
export interface GcPending {
  /** Schema version. Today `1`. Readers MUST reject unknown majors. */
  schema_version: 1;
  /**
   * Candidate deletions. The compactor MUST keep this list bounded —
   * `runGc()` caps the per-run marks and sweeps.
   */
  candidates: ReadonlyArray<GcCandidate>;
  /**
   * Server-clock ISO-8601 timestamp of the last successful sweep
   * completion. Drives the `db.gc.entries_swept_per_second` metric
   * (ticket 17). Empty string `""` before the first sweep.
   */
  last_swept_at: string;
}

/**
 * One pending deletion entry. The `runGc()` mark phase appends these
 * with a future `due_at`; the sweep phase deletes entries whose
 * `due_at` is in the past and prunes them from the list.
 */
export interface GcCandidate {
  /** Full bucket-relative key of the deletion candidate. */
  key: string;
  /** ISO-8601 server-clock time after which the key may be deleted. */
  due_at: string;
  /** Why the key is a candidate. */
  reason: "stale-log" | "orphan-snapshot" | "orphan-content";
}

/**
 * Return shape from {@link readGcPending}: the parsed JSON plus the
 * ETag needed for a follow-up CAS write.
 */
export interface GcPendingRead {
  readonly json: GcPending;
  readonly etag: string;
}

/**
 * Read + parse `gc/pending.json` at `key`. Returns `null` on
 * not-found.
 *
 * @throws MPS3Error{code:"InvalidResponse"} — body is not valid
 *         JSON, or `schema_version` is unknown, or the shape fails
 *         the runtime guard.
 */
export const readGcPending = async (
  storage: Storage,
  key: string,
  opts?: { signal?: AbortSignal },
): Promise<GcPendingRead | null> => {
  const got = await storage.get(key, opts);
  if (got === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(got.body));
  } catch (e) {
    throw new MPS3Error("InvalidResponse", `gc/pending.json at ${key}: body is not valid JSON`, e);
  }
  return { json: assertGcPending(parsed, key), etag: got.etag };
};

/**
 * Create `gc/pending.json` if-and-only-if it does not exist (S3
 * `If-None-Match: "*"`). Use this once per collection at first GC
 * run; subsequent updates go through {@link casUpdateGcPending}.
 *
 * @throws MPS3Error{code:"Conflict"} — the key already exists.
 * @throws MPS3Error{code:"InvalidResponse"} — `initial` fails the
 *         runtime shape guard.
 */
export const createGcPending = async (
  storage: Storage,
  key: string,
  initial: GcPending,
  opts?: { signal?: AbortSignal },
): Promise<GcPendingRead> => {
  assertGcPending(initial, key);
  const body = encodeJson(initial);
  const putOpts: StoragePutOptions = {
    ifNoneMatch: "*",
    contentType: GC_PENDING_CONTENT_TYPE,
    ...(opts?.signal !== undefined && { signal: opts.signal }),
  };
  let result: StoragePutResult;
  try {
    result = await storage.put(key, body, putOpts);
  } catch (e) {
    throw translateCasError(e, key);
  }
  return { json: initial, etag: result.etag };
};

/**
 * Read-modify-write `gc/pending.json` under CAS. The `mutator`
 * receives a deep clone of the current parsed JSON and returns the
 * new state. The new state is written with `If-Match: <currentEtag>`;
 * on conflict, throws `MPS3Error{code:"Conflict"}`.
 *
 * `mutator` MUST be deterministic — it may be called multiple times
 * if the caller wraps this in a retry loop, so it must not have side
 * effects.
 *
 * @throws MPS3Error{code:"Conflict"} — another writer landed a write
 *         between this function's read and write.
 * @throws MPS3Error{code:"InvalidResponse"} — `key` does not exist
 *         (use {@link createGcPending} instead) or body doesn't
 *         parse / fails the shape guard.
 */
export const casUpdateGcPending = async (
  storage: Storage,
  key: string,
  mutator: (current: GcPending) => GcPending,
  opts?: { signal?: AbortSignal },
): Promise<GcPendingRead> => {
  const existing = await readGcPending(storage, key, opts);
  if (existing === null) {
    throw new MPS3Error(
      "InvalidResponse",
      `gc/pending.json at ${key} does not exist; use createGcPending first`,
    );
  }
  const next = mutator(structuredClone(existing.json));
  assertGcPending(next, key);
  const body = encodeJson(next);
  const putOpts: StoragePutOptions = {
    ifMatch: existing.etag,
    contentType: GC_PENDING_CONTENT_TYPE,
    ...(opts?.signal !== undefined && { signal: opts.signal }),
  };
  let result: StoragePutResult;
  try {
    result = await storage.put(key, body, putOpts);
  } catch (e) {
    throw translateCasError(e, key);
  }
  return { json: next, etag: result.etag };
};

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

const encodeJson = (json: GcPending): Uint8Array => new TextEncoder().encode(JSON.stringify(json));

const VALID_REASONS = new Set<GcCandidate["reason"]>([
  "stale-log",
  "orphan-snapshot",
  "orphan-content",
]);

/**
 * Runtime guard for `parsed` to be a {@link GcPending}. Throws
 * `MPS3Error{code:"InvalidResponse"}` rather than coercing.
 */
const assertGcPending = (parsed: unknown, key: string): GcPending => {
  if (parsed === null || typeof parsed !== "object") {
    throw new MPS3Error(
      "InvalidResponse",
      `gc/pending.json at ${key}: parsed body is not an object`,
    );
  }
  const r = parsed as Record<string, unknown>;
  if (r.schema_version !== GC_PENDING_SCHEMA_VERSION) {
    throw new MPS3Error(
      "InvalidResponse",
      `gc/pending.json at ${key}: unsupported schema_version ${String(r.schema_version)}; expected ${GC_PENDING_SCHEMA_VERSION}`,
    );
  }
  if (!Array.isArray(r.candidates)) {
    throw new MPS3Error(
      "InvalidResponse",
      `gc/pending.json at ${key}: candidates must be an array`,
    );
  }
  for (let i = 0; i < r.candidates.length; i++) {
    const c = r.candidates[i];
    if (c === null || typeof c !== "object") {
      throw new MPS3Error(
        "InvalidResponse",
        `gc/pending.json at ${key}: candidates[${String(i)}] is not an object`,
      );
    }
    const cr = c as Record<string, unknown>;
    if (typeof cr.key !== "string" || cr.key.length === 0) {
      throw new MPS3Error(
        "InvalidResponse",
        `gc/pending.json at ${key}: candidates[${String(i)}].key must be a non-empty string`,
      );
    }
    if (typeof cr.due_at !== "string") {
      throw new MPS3Error(
        "InvalidResponse",
        `gc/pending.json at ${key}: candidates[${String(i)}].due_at must be a string`,
      );
    }
    if (typeof cr.reason !== "string" || !VALID_REASONS.has(cr.reason as GcCandidate["reason"])) {
      throw new MPS3Error(
        "InvalidResponse",
        `gc/pending.json at ${key}: candidates[${String(i)}].reason must be one of stale-log|orphan-snapshot|orphan-content`,
      );
    }
  }
  if (typeof r.last_swept_at !== "string") {
    throw new MPS3Error(
      "InvalidResponse",
      `gc/pending.json at ${key}: last_swept_at must be a string`,
    );
  }
  return parsed as GcPending;
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
    return new MPS3Error("Conflict", `gc/pending.json CAS lost at ${key}: ${e.message}`, e);
  }
  if (e instanceof MPS3Error) return e;
  return new MPS3Error(
    "InvalidResponse",
    `gc/pending.json write at ${key} failed: ${String(e)}`,
    e,
  );
};
