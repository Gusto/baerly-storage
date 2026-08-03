/**
 * Timer-free semantic journals over the `Storage` seam.
 *
 * Two journals are produced from one decorator: an ordered **operation
 * journal** (method, key, semantically-relevant request options, PUT byte
 * length and digest, result/error class, attempt id) and an exact **namespace
 * journal** (known key/byte-length state from benchmark-owned provisioning plus
 * observed PUT/DELETE outcomes).
 *
 * This module holds no wall-clock field and issues no wall-clock or timer call.
 * Latency is a separate observation so a semantics comparison can ignore clock
 * noise; `bench/storage.ts`'s latency wrapper and
 * `bench/measurement/fold-ceiling-probe.ts` are deliberately outside this
 * contract and must never be imported here.
 *
 * It also imports nothing at runtime — only types plus the global Web Crypto
 * digest — so it stays loadable outside Node.
 */
import type {
  Branded,
  Storage,
  StorageGetResult,
  StorageListEntry,
  StoragePutResult,
} from "@baerly/protocol";

/** Contract version of {@link StorageOperationRecord}. */
export const OPERATION_JOURNAL_VERSION = "baerly.storage-operation-journal/v1" as const;
/** Contract version of {@link NamespaceSnapshot}. */
export const NAMESPACE_JOURNAL_VERSION = "baerly.namespace-journal/v1" as const;

/** Identity of one measurement attempt. Every journal row carries it. */
export type AttemptId = Branded<string, "AttemptId">;

/**
 * Attempt ids reach filenames, directory names, and JSON keys in downstream
 * lanes, so the charset is narrow on purpose: ASCII alphanumerics plus `.`,
 * `_`, `:`, and `-`, 1-128 characters. No slash, no whitespace, no non-ASCII.
 */
export const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export class InvalidAttemptIdError extends Error {
  readonly value: string;
  constructor(value: string) {
    super(`invalid attempt id ${JSON.stringify(value)}: expected ${String(ATTEMPT_ID_PATTERN)}`);
    this.name = "InvalidAttemptIdError";
    this.value = value;
  }
}

/**
 * Single deliberate boundary for minting an {@link AttemptId}. Validates rather
 * than casting: an unchecked cast makes the brand decorative, and this repo's
 * convention is that branded types are load-bearing.
 */
export const asAttemptId = (value: string): AttemptId => {
  if (!ATTEMPT_ID_PATTERN.test(value)) {
    throw new InvalidAttemptIdError(value);
  }
  return value as AttemptId;
};

export type StorageMethod = "get" | "put" | "delete" | "list";

/**
 * Billing class of one storage verb.
 *
 * `docs/about/cost-model.md` and coordination design §4.5 both define the
 * billable set as `puts + lists`; DeleteObject is $0 on both S3 and R2, so
 * `delete` is neither A nor B. `bench/storage.ts`'s `billableClassAOps` getter
 * already agrees.
 *
 * This is ONE definition, not a resolution. Two other definitions are live in
 * the tree (see the `billing class` describe block in the test file). Their
 * owner is the Protocol/product owner named in the integration manifest's open
 * contradictions table.
 */
export type BillingClass = "A" | "B" | "free";

export const billingClassOf = (method: StorageMethod): BillingClass => {
  if (method === "put" || method === "list") {
    return "A";
  }
  return method === "get" ? "B" : "free";
};

export interface BillingSummary {
  readonly class_a: number;
  readonly class_b: number;
  readonly free: number;
}

export type StorageErrorClass =
  | "aborted"
  | "conflict"
  | "network_error"
  | "invalid_response"
  | "internal"
  | "invalid_config"
  | "unknown";

export interface ThrownDescription {
  readonly name: string;
  readonly code?: string;
  readonly message: string;
}

const stringField = (error: unknown, field: "name" | "message" | "code"): string | undefined => {
  if (typeof error !== "object" || error === null || !(field in error)) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
};

const CODE_TO_CLASS: Readonly<Record<string, StorageErrorClass>> = {
  Conflict: "conflict",
  NetworkError: "network_error",
  InvalidResponse: "invalid_response",
  Internal: "internal",
  InvalidConfig: "invalid_config",
};

/**
 * Map a thrown value onto the journal's closed error vocabulary.
 *
 * Abort is detected by `name`, never by `code`: a `DOMException` exposes a
 * legacy **numeric** `code` (`AbortError` is `20`), which is why
 * {@link stringField} discards non-string values instead of forwarding them.
 */
export const classifyStorageError = (error: unknown): StorageErrorClass => {
  const name = stringField(error, "name");
  if (name === "AbortError" || name === "TimeoutError") {
    return "aborted";
  }
  const code = stringField(error, "code");
  if (code === undefined) {
    return "unknown";
  }
  return CODE_TO_CLASS[code] ?? "unknown";
};

/** Structured, string-safe description of a thrown value. */
export const describeThrown = (error: unknown): ThrownDescription => {
  const code = stringField(error, "code");
  return {
    name: stringField(error, "name") ?? "UnknownError",
    ...(code !== undefined && { code }),
    message: stringField(error, "message") ?? String(error),
  };
};

export interface JournalSignal {
  readonly id: string;
  readonly present: true;
  readonly aborted_at_dispatch: boolean;
}

export interface JournalRequestOptions {
  readonly if_match?: string;
  readonly if_none_match?: string;
  readonly content_type?: string;
  readonly version_id?: string;
  readonly start_after?: string;
  readonly max_keys?: number;
  readonly signal?: JournalSignal;
}

export type StorageOperationResult =
  | {
      readonly status: "returned";
      readonly classification: "found" | "not_found" | "put_ok" | "delete_ok" | "list_ok";
      readonly etag?: string;
      readonly version_id?: string;
      readonly listed_entries?: number;
    }
  | {
      readonly status: "threw";
      readonly classification: StorageErrorClass;
      readonly name: string;
      readonly code?: string;
    };

export interface StorageOperationRecord {
  readonly schema: typeof OPERATION_JOURNAL_VERSION;
  readonly attempt_id: AttemptId;
  readonly operation_index: number;
  readonly method: StorageMethod;
  readonly key: string;
  readonly options: JournalRequestOptions;
  readonly put?: { readonly byte_length: number; readonly sha256: string };
  readonly result: StorageOperationResult;
}

export interface NamespaceEntry {
  readonly key: string;
  readonly byte_length: number;
  readonly last_operation_index: number | null;
  readonly source: "provisioned" | "put";
}

/**
 * Why one key is uncertain. `uncertain_keys` stays the fail-closed answer; this
 * carries the evidence so a downstream consumer can narrow WITHOUT assuming
 * anything about adapter behavior. In particular `aborted_at_dispatch === true`
 * means the signal was already aborted when the wrapper was called.
 */
export interface NamespaceUncertainty {
  readonly key: string;
  readonly operation_index: number;
  readonly method: "put" | "delete";
  readonly classification: StorageErrorClass;
  readonly aborted_at_dispatch: boolean;
}

export interface NamespaceSnapshot {
  readonly schema: typeof NAMESPACE_JOURNAL_VERSION;
  readonly exact: boolean;
  readonly entries: readonly NamespaceEntry[];
  readonly uncertain_keys: readonly string[];
  readonly uncertainty: readonly NamespaceUncertainty[];
}

export interface PendingOperation {
  readonly operation_index: number;
  readonly method: StorageMethod;
  readonly key: string;
}

export class JournalNotQuiescentError extends Error {
  readonly pending: readonly PendingOperation[];
  constructor(pending: readonly PendingOperation[]) {
    const names = pending.map((p) => `${p.operation_index}:${p.method} ${p.key}`).join(", ");
    super(
      `journal is not quiescent: ${pending.length} operation(s) dispatched but unsettled ` +
        `[${names}]. Await them, or call snapshotSettledOperations() if a mid-flight ` +
        `view is what you actually want.`,
    );
    this.name = "JournalNotQuiescentError";
    this.pending = pending;
  }
}

export interface StorageJournal {
  readonly attemptId: AttemptId;
  /**
   * THROWS `JournalNotQuiescentError` when any dispatched row is unsettled,
   * instead of silently omitting it. Journal equality is this lane's primary
   * consumer and a silently short list is the failure mode that passes green.
   */
  snapshotOperations(): readonly StorageOperationRecord[];
  /** Settled rows only, never throws. For deliberate mid-flight inspection. */
  snapshotSettledOperations(): readonly StorageOperationRecord[];
  pendingOperations(): readonly PendingOperation[];
  /** Count of rows dispatched but not yet settled. Zero means quiescent. */
  pendingOperationCount(): number;
  snapshotNamespace(): NamespaceSnapshot;
  recordProvisioned(entries: readonly { key: string; byte_length: number }[]): void;
  /** Derived from settled rows only. */
  billingSummary(): BillingSummary;
}

export interface JournaledStorage {
  readonly storage: Storage;
  readonly journal: StorageJournal;
}

const HEX = "0123456789abcdef";

// `Uint8Array.prototype.toHex` type-checks under `ESNext.TypedArrays` but
// throws at run time on Node 24 and workerd (gated behind a V8 flag), so the
// hex loop is hand-rolled on purpose.
const toHex = (bytes: Uint8Array): string => {
  let out = "";
  for (const byte of bytes) {
    out += HEX.charAt(byte >> 4);
    out += HEX.charAt(byte & 15);
  }
  return out;
};

const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => {
  // `bytes` is already the dispatch-time copy, allocated over a fresh
  // `ArrayBuffer` — tsgo narrows a bare `Uint8Array` to
  // `Uint8Array<ArrayBufferLike>`, which `crypto.subtle.digest` rejects (it
  // wants `ArrayBufferView<ArrayBuffer>`). Same constraint, and the same
  // workaround, as `packages/protocol/src/sha256.ts`.
  // See microsoft/TypeScript#61375.
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
};

interface MutableRow {
  readonly index: number;
  readonly method: StorageMethod;
  readonly key: string;
  readonly options: JournalRequestOptions;
  put?: { readonly byte_length: number; readonly sha256: string };
  result?: StorageOperationResult;
}

interface MutableUncertainty {
  readonly key: string;
  readonly operation_index: number;
  readonly method: "put" | "delete";
  readonly classification: StorageErrorClass;
  readonly aborted_at_dispatch: boolean;
}

/**
 * Record ordering for `entries` / `uncertainty` — plain string comparison on
 * the key, NOT the S3 UTF-8 list-order contract. Written as an if/return block
 * because `.oxlintrc.json` sets `eslint/no-nested-ternary` to `error`; do not
 * "simplify" it back to a nested ternary.
 */
const byKeyAsc = (a: { key: string }, b: { key: string }): number => {
  if (a.key < b.key) {
    return -1;
  }
  return a.key > b.key ? 1 : 0;
};

interface CapturableOptions {
  ifMatch?: string;
  ifNoneMatch?: string;
  contentType?: string;
  versionId?: string;
  startAfter?: string;
  maxKeys?: number;
  signal?: AbortSignal;
}

export const wrapJournaledStorage = (input: {
  readonly attemptId: AttemptId;
  readonly storage: Storage;
  readonly signalIds?: ReadonlyMap<AbortSignal, string>;
}): JournaledStorage => {
  const inner = input.storage;
  const rows: MutableRow[] = [];
  const entries = new Map<
    string,
    { byte_length: number; last_operation_index: number | null; source: "provisioned" | "put" }
  >();
  const uncertain = new Map<string, MutableUncertainty>();
  const anonymousNames = new WeakMap<AbortSignal, string>();
  let anonymousCount = 0;
  let nextIndex = 0;

  const nameSignal = (signal: AbortSignal): string => {
    const provided = input.signalIds?.get(signal);
    if (provided !== undefined) {
      return provided;
    }
    const known = anonymousNames.get(signal);
    if (known !== undefined) {
      return known;
    }
    anonymousCount += 1;
    const generated = `signal-${anonymousCount}`;
    anonymousNames.set(signal, generated);
    return generated;
  };

  const capture = (opts?: CapturableOptions): JournalRequestOptions => ({
    ...(opts?.ifMatch !== undefined && { if_match: opts.ifMatch }),
    ...(opts?.ifNoneMatch !== undefined && { if_none_match: opts.ifNoneMatch }),
    ...(opts?.contentType !== undefined && { content_type: opts.contentType }),
    ...(opts?.versionId !== undefined && { version_id: opts.versionId }),
    ...(opts?.startAfter !== undefined && { start_after: opts.startAfter }),
    ...(opts?.maxKeys !== undefined && { max_keys: opts.maxKeys }),
    ...(opts?.signal !== undefined && {
      signal: {
        id: nameSignal(opts.signal),
        present: true as const,
        aborted_at_dispatch: opts.signal.aborted,
      },
    }),
  });

  const openRow = (
    method: StorageMethod,
    key: string,
    options: JournalRequestOptions,
  ): MutableRow => {
    const row: MutableRow = { index: nextIndex, method, key, options };
    nextIndex += 1;
    rows.push(row);
    return row;
  };

  const threwResult = (error: unknown): StorageOperationResult => {
    const described = describeThrown(error);
    return {
      status: "threw",
      classification: classifyStorageError(error),
      name: described.name,
      ...(described.code !== undefined && { code: described.code }),
    };
  };

  /**
   * Conflict leaves prior state unchanged; any other failure class removes the
   * key from the exactly-known set and records WHY. The evidence row is what
   * lets a downstream consumer narrow (see `aborted_at_dispatch`) without this
   * module assuming anything the `Storage` contract does not state.
   */
  const markUncertain = (row: MutableRow, method: "put" | "delete", error: unknown): void => {
    const classification = classifyStorageError(error);
    if (classification === "conflict") {
      return;
    }
    entries.delete(row.key);
    uncertain.set(row.key, {
      key: row.key,
      operation_index: row.index,
      method,
      classification,
      aborted_at_dispatch: row.options.signal?.aborted_at_dispatch ?? false,
    });
  };

  const storage: Storage = {
    get: async (key, opts) => {
      const row = openRow("get", key, capture(opts));
      try {
        const result: StorageGetResult | null = await inner.get(key, opts);
        row.result =
          result === null
            ? { status: "returned", classification: "not_found" }
            : {
                status: "returned",
                classification: "found",
                etag: result.etag,
                ...(result.versionId !== undefined && { version_id: result.versionId }),
              };
        return result;
      } catch (error: unknown) {
        row.result = threwResult(error);
        throw error;
      }
    },

    put: async (key, body, opts) => {
      const row = openRow("put", key, capture(opts));
      // Copy at dispatch so later caller mutation cannot alter the journal.
      // The ORIGINAL `body` is handed to the inner storage: `MemoryStorage`
      // stores the caller's array by reference, and substituting a copy would
      // change what the system under test observes.
      const copy = new Uint8Array(body.byteLength);
      copy.set(body);
      // Settle the digest to an option rather than awaiting it bare: a digest
      // rejection must never replace the storage error, which is the outcome
      // the caller actually needs.
      const digest = sha256Hex(copy).then(
        (sha256) => ({ ok: true, sha256 }) as const,
        () => ({ ok: false }) as const,
      );
      const settled = await inner.put(key, body, opts).then(
        (value: StoragePutResult) => ({ ok: true, value }) as const,
        (error: unknown) => ({ ok: false, error }) as const,
      );
      const digested = await digest;
      if (digested.ok) {
        row.put = { byte_length: copy.byteLength, sha256: digested.sha256 };
      }
      if (!settled.ok) {
        row.result = threwResult(settled.error);
        markUncertain(row, "put", settled.error);
        throw settled.error;
      }
      row.result = {
        status: "returned",
        classification: "put_ok",
        etag: settled.value.etag,
        ...(settled.value.versionId !== undefined && { version_id: settled.value.versionId }),
      };
      uncertain.delete(key);
      entries.set(key, {
        byte_length: copy.byteLength,
        last_operation_index: row.index,
        source: "put",
      });
      return settled.value;
    },

    delete: async (key, opts) => {
      const row = openRow("delete", key, capture(opts));
      try {
        await inner.delete(key, opts);
        row.result = { status: "returned", classification: "delete_ok" };
        entries.delete(key);
        uncertain.delete(key);
      } catch (error: unknown) {
        row.result = threwResult(error);
        markUncertain(row, "delete", error);
        throw error;
      }
    },

    // The generator body does not run until the first `next()`, so the row is
    // opened when ITERATION begins, per the parent plan. That is a different
    // clock from the other three verbs — see Semantics §2 and Open question 6.
    list: async function* (prefix, opts): AsyncIterable<StorageListEntry> {
      const row = openRow("list", prefix, capture(opts));
      let listed = 0;
      try {
        for await (const entry of inner.list(prefix, opts)) {
          listed += 1;
          yield entry;
        }
        row.result = { status: "returned", classification: "list_ok", listed_entries: listed };
      } catch (error: unknown) {
        row.result = threwResult(error);
        throw error;
      } finally {
        // An early `break` disposes the generator without reaching either
        // branch above; settle with the partial count so the row never leaks.
        row.result ??= {
          status: "returned",
          classification: "list_ok",
          listed_entries: listed,
        };
      }
    },
  };

  const settledRows = (): (MutableRow & { result: StorageOperationResult })[] =>
    rows
      .filter(
        (row): row is MutableRow & { result: StorageOperationResult } => row.result !== undefined,
      )
      .toSorted((a, b) => a.index - b.index);

  const toRecord = (row: MutableRow & { result: StorageOperationResult }): StorageOperationRecord =>
    Object.freeze<StorageOperationRecord>({
      schema: OPERATION_JOURNAL_VERSION,
      attempt_id: input.attemptId,
      operation_index: row.index,
      method: row.method,
      key: row.key,
      options: row.options,
      ...(row.put !== undefined && { put: row.put }),
      result: row.result,
    });

  const pending = (): PendingOperation[] =>
    rows
      .filter((row) => row.result === undefined)
      .toSorted((a, b) => a.index - b.index)
      .map((row) => ({ operation_index: row.index, method: row.method, key: row.key }));

  const journal: StorageJournal = {
    attemptId: input.attemptId,

    /**
     * Throws when the journal is not quiescent. Journal EQUALITY is this
     * contract's primary consumer, and two silently-truncated lists compare
     * equal to each other — the exact failure that passes green.
     */
    snapshotOperations: (): readonly StorageOperationRecord[] => {
      const unsettled = pending();
      if (unsettled.length > 0) {
        throw new JournalNotQuiescentError(unsettled);
      }
      return settledRows().map(toRecord);
    },

    snapshotSettledOperations: (): readonly StorageOperationRecord[] => settledRows().map(toRecord),

    pendingOperations: (): readonly PendingOperation[] => pending(),

    pendingOperationCount: (): number =>
      rows.reduce((count, row) => (row.result === undefined ? count + 1 : count), 0),

    snapshotNamespace: (): NamespaceSnapshot =>
      Object.freeze<NamespaceSnapshot>({
        schema: NAMESPACE_JOURNAL_VERSION,
        exact: uncertain.size === 0,
        entries: [...entries]
          .map(([key, value]) => ({
            key,
            byte_length: value.byte_length,
            last_operation_index: value.last_operation_index,
            source: value.source,
          }))
          .toSorted(byKeyAsc),
        uncertain_keys: [...uncertain.keys()].toSorted(),
        uncertainty: [...uncertain.values()].toSorted(byKeyAsc),
      }),

    recordProvisioned: (provisioned): void => {
      for (const entry of provisioned) {
        uncertain.delete(entry.key);
        entries.set(entry.key, {
          byte_length: entry.byte_length,
          last_operation_index: null,
          source: "provisioned",
        });
      }
    },

    billingSummary: (): BillingSummary => {
      let classA = 0;
      let classB = 0;
      let free = 0;
      for (const row of settledRows()) {
        const cls = billingClassOf(row.method);
        if (cls === "A") {
          classA += 1;
        } else if (cls === "B") {
          classB += 1;
        } else {
          free += 1;
        }
      }
      return { class_a: classA, class_b: classB, free };
    },
  };

  return { storage, journal };
};
