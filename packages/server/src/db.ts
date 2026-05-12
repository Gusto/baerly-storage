/* eslint-disable no-underscore-dangle -- `_raw` is the locked public-symbol
   name for the Phase-3 Storage escape hatch; mirrors the Phase-4 `Db._raw`
   declaration in `@baerly/protocol/src/db.ts` and is marked `@internal`. */

import { BaerlyError } from "@baerly/protocol";
import type {
  JSONArraylessObject,
  Storage,
  StorageGetOptions,
  StorageGetResult,
  StorageListEntry,
  StoragePutOptions,
  StoragePutResult,
  Table,
} from "@baerly/protocol";
import type { CurrentJsonCacheSlot, TableReadContext } from "./query";
import { ServerWriter, type CommitInput } from "./server-writer";
import { makeTable } from "./table";

/**
 * In-memory buffer for a single in-flight {@link Db.transaction}
 * call. The `Table<T>` instance passed to the transaction body holds
 * a reference to this object; every mutation verb appends to
 * `mutations` instead of calling `ServerWriter.commit` directly.
 *
 * After the body resolves, `Db.transaction` performs ONE
 * `ServerWriter.commitBatch(...)` to commit every buffered mutation
 * in a single CAS attempt.
 *
 * @internal — referenced by `table.ts` and `query.ts`; not part of
 *   the public API surface for app code.
 */
export interface TxContext {
  /**
   * The table name the transaction is scoped to. Mutation verbs
   * runtime-assert that their `Table<T>`'s `name` matches this
   * field before appending — the type system already prevents the
   * legitimate path, this catches the bug path (a stale `Query<T>`
   * re-attached to a different table's transaction).
   */
  readonly table: string;

  /**
   * Mutations buffered in order of issuance. The commit converts
   * each into one `CommitInput` (`ServerWriter`'s single-mutation
   * shape) and passes the array to `ServerWriter.commitBatch`.
   */
  readonly mutations: BufferedMutation[];
}

/**
 * One buffered mutation. Mirrors {@link CommitInput} minus
 * `collection` (which is constant per transaction and lives on
 * `TxContext.table`).
 *
 * @internal — only used inside the `Db.transaction` path.
 */
export interface BufferedMutation {
  readonly op: "I" | "U" | "D";
  readonly docId: string;
  readonly body?: JSONArraylessObject;
  readonly origin?: string;
}

/**
 * Physical-key prefix for a `(app, tenant)` pair. Trailing slash is
 * part of the prefix so a caller's `list("")` resolves to
 * `list("app/<app>/tenant/<tenant>/")` and cannot enumerate a sibling
 * tenant whose name shares a prefix.
 */
const physicalPrefixFor = (app: string, tenant: string): string => `app/${app}/tenant/${tenant}/`;

/**
 * Phase-3 escape hatch: a Storage-shaped surface scoped to one
 * `(app, tenant)` pair. Keys callers see are **logical** (e.g.
 * `"docs/123"`); the wrapper composes
 * `app/<app>/tenant/<tenant>/<key>` before touching the underlying
 * `Storage`, and strips the prefix back off when yielding from
 * `list`.
 *
 * Bypasses every higher-level invariant: no `LogEntry` emit, no CAS
 * on `current.json`, no schema check. Phase 4 adds the
 * LogEntry-based `RawApi` (declared in
 * `@baerly/protocol/src/db.ts`) on top, likely as a separate `_log`
 * field on `Db`.
 *
 * @internal — public symbol, but the table API (Phase 4) is the
 *             recommended surface for app code.
 */
export interface RawStorageApi {
  get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null>;
  put(key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult>;
  delete(key: string, opts?: { signal?: AbortSignal }): Promise<void>;
  list(
    prefix: string,
    opts?: { startAfter?: string; maxKeys?: number; signal?: AbortSignal },
  ): AsyncIterable<StorageListEntry>;
}

/**
 * Phase-3 runtime entry point. One `Db` per `(app, tenant)` request.
 *
 * Construct via {@link Db.create} — the constructor is private so
 * callers don't accidentally bypass validation.
 *
 * @example
 * ```ts
 * import { Db } from "@baerly/server";
 * import { MemoryStorage } from "@baerly/protocol";
 *
 * const db = Db.create({
 *   storage: new MemoryStorage(),
 *   app: "tickets",
 *   tenant: "acme-co",
 * });
 *
 * await db._raw.put("docs/123", new TextEncoder().encode("hi"));
 * const got = await db._raw.get("docs/123");
 * ```
 */
export class Db {
  readonly app: string;
  readonly tenant: string;
  /** @internal — Storage-shaped escape hatch; prefer the table API. */
  readonly _raw: RawStorageApi;
  /**
   * Underlying `Storage`, captured so the table API can issue reads
   * using physical keys directly. The reader must NOT route through
   * `_raw` — `_raw` re-applies the `app/<app>/tenant/<tenant>/`
   * prefix, and the table-API code already composes the full
   * physical prefix. Two prefix-rewriters on one key would be a
   * latent bug class.
   */
  readonly #storage: Storage;
  /**
   * Per-table `current.json` cache slots for the `eventual` read
   * path. Allocated lazily by {@link Db.tableReadContext}; two
   * `Table` handles over the same name share one slot so a
   * `consistency('strong')` call on one handle anchors the cache
   * the other reuses. Per-`Db`, NOT per-process — two `Db` instances
   * over the same bucket do NOT share cache.
   */
  readonly #currentJsonCaches: Map<string, CurrentJsonCacheSlot> = new Map();

  private constructor(app: string, tenant: string, storage: Storage) {
    this.app = app;
    this.tenant = tenant;
    this.#storage = storage;
    this._raw = makeRawStorageApi(app, tenant, storage);
  }

  /**
   * Build a tenant-scoped `Db`. Throws
   * `BaerlyError{code:"InvalidConfig"}` if either `app` or `tenant`
   * is empty or contains `/` (the segment separator).
   *
   * @throws BaerlyError code="InvalidConfig" when `app` or `tenant` is
   *   empty or contains `/`.
   *
   * @example
   * ```ts
   * const db = Db.create({ storage, app: "tickets", tenant: "acme" });
   * ```
   */
  static create(config: { storage: Storage; app: string; tenant: string }): Db {
    const { storage, app, tenant } = config;
    if (app.length === 0 || tenant.length === 0) {
      throw new BaerlyError(
        "InvalidConfig",
        `Db.create requires non-empty app and tenant (got app=${JSON.stringify(app)}, tenant=${JSON.stringify(tenant)})`,
      );
    }
    if (app.includes("/") || tenant.includes("/")) {
      throw new BaerlyError(
        "InvalidConfig",
        `Db.create: "/" is reserved as the key-segment separator (got app=${JSON.stringify(app)}, tenant=${JSON.stringify(tenant)})`,
      );
    }
    return new Db(app, tenant, storage);
  }

  /**
   * Typed handle for a single table. Cheap; creates no I/O. Same
   * `name` returns a FRESH `Table<T>` object on each call (chain
   * identity is intentional — modifiers return new objects).
   *
   * @throws BaerlyError code="InvalidConfig" when `name` is empty or
   *   contains `/`.
   *
   * @example
   * ```ts
   * const open = await db.table<Ticket>("tickets")
   *   .where({ status: "open" })
   *   .order({ commit_ts: "desc" })
   *   .limit(50)
   *   .all();
   * ```
   */
  table<T extends JSONArraylessObject = JSONArraylessObject>(name: string): Table<T> {
    return makeTable<T>(this.tableReadContext(name));
  }

  /**
   * Build a freshly-seeded {@link TableReadContext} for `name`. The
   * HTTP router uses this so it can drive `runFirstWithMeta` /
   * `runAllWithMeta` directly (whose return shapes carry the
   * manifest-pointer cursor used to pack `_meta` onto the read
   * response envelope). Application callers should keep using
   * {@link Db.table}; the chainable terminals destructure the cursor
   * out and discard it to keep the locked `Query<T>` signature.
   *
   * Runs the same `name`-validation guard as {@link Db.table}.
   *
   * @throws BaerlyError code="InvalidConfig" when `name` is empty or
   *   contains `/`.
   * @internal
   */
  tableReadContext(name: string): TableReadContext {
    if (name.length === 0 || name.includes("/")) {
      throw new BaerlyError(
        "InvalidConfig",
        `Db.table: name must be non-empty and must not contain "/" (got ${JSON.stringify(name)})`,
      );
    }
    let cache = this.#currentJsonCaches.get(name);
    if (cache === undefined) {
      cache = { value: null };
      this.#currentJsonCaches.set(name, cache);
    }
    return {
      storage: this.#storage,
      tablePrefix: `${physicalPrefixFor(this.app, this.tenant)}manifests/${name}`,
      tableName: name,
      currentJsonCache: cache,
    };
  }

  /**
   * Atomic mutation over a single table. The callback receives a
   * `Table<T>` (not a `Db`) so cross-table writes inside a
   * transaction are a TypeScript error at compile time — not a
   * runtime trap. Mutation verbs (`insert`, `update`, `replace`,
   * `delete`) buffer; reads (`first`, `all`, `count`) go through
   * `Storage` live (no MVCC snapshot, no read-your-writes).
   *
   * Single-attempt: on CAS conflict throws
   * `BaerlyError{code:"Conflict"}`. The body MAY have already run its
   * read side-effects (no rollback of in-memory state); the write
   * side-effects either all landed or none did. Wrap in a retry
   * loop you wrote if you want one.
   *
   * Empty body (or a body that buffers nothing) resolves without
   * touching `current.json`.
   *
   * @throws BaerlyError code="Conflict" — CAS lost on the table's
   *   `current.json`. Caller decides whether to re-run the body.
   * @throws Whatever the body throws — re-thrown as-is. The commit
   *   is skipped when the body throws.
   * @throws BaerlyError code="InvalidConfig" — `table` is empty or
   *   contains `/`.
   *
   * @example
   * ```ts
   * await db.transaction("tickets", async (tx) => {
   *   const open = await tx.where({ status: "open" }).count();
   *   if (open < 100) await tx.insert({ title: "another", status: "open" });
   * });
   * ```
   */
  async transaction<T extends JSONArraylessObject = JSONArraylessObject>(
    table: string,
    body: (tx: Table<T>) => Promise<void>,
  ): Promise<void> {
    if (table.length === 0 || table.includes("/")) {
      throw new BaerlyError(
        "InvalidConfig",
        `Db.transaction: name must be non-empty and must not contain "/" (got ${JSON.stringify(table)})`,
      );
    }

    const txCtx: TxContext = { table, mutations: [] };
    const tablePrefix = `${physicalPrefixFor(this.app, this.tenant)}manifests/${table}`;

    // Build a Table<T> whose mutation verbs buffer onto `txCtx`. The
    // read path ignores `txCtx` entirely (locked: no MVCC, no
    // read-your-writes — ticket 11 §1).
    // Reuse the per-(Db, table) `currentJsonCache` slot so a
    // transaction's reads share the same `eventual`-anchor seen by
    // pre-transaction `Db.table(table)` calls. Allocate one lazily
    // if no `Db.table(table)` ran first.
    let cache = this.#currentJsonCaches.get(table);
    if (cache === undefined) {
      cache = { value: null };
      this.#currentJsonCaches.set(table, cache);
    }
    const tx = makeTable<T>({
      storage: this.#storage,
      tablePrefix,
      tableName: table,
      txCtx,
      currentJsonCache: cache,
    });

    // Run the body. Reads go through Storage live; mutations append
    // to txCtx.mutations. A throw here propagates AS-IS and skips
    // the commit (txCtx.mutations is discarded).
    await body(tx);

    // Empty buffer — nothing to commit, nothing to throw.
    if (txCtx.mutations.length === 0) return;

    // Map BufferedMutations -> CommitInputs and fire one
    // single-attempt commitBatch. On CAS loss commitBatch throws
    // `Conflict` and we surface it unchanged.
    const inputs: CommitInput[] = [];
    for (const m of txCtx.mutations) {
      const input: CommitInput = {
        op: m.op,
        collection: table,
        docId: m.docId,
        ...(m.body !== undefined ? { body: m.body } : {}),
        ...(m.origin !== undefined ? { origin: m.origin } : {}),
      };
      inputs.push(input);
    }

    const writer = new ServerWriter({
      storage: this.#storage,
      currentJsonKey: `${tablePrefix}/current.json`,
    });
    await writer.commitBatch(inputs);
  }
}

const makeRawStorageApi = (app: string, tenant: string, storage: Storage): RawStorageApi => {
  const prefix = physicalPrefixFor(app, tenant);
  const toPhysical = (logical: string): string => `${prefix}${logical}`;
  const fromPhysical = (physical: string): string => {
    if (!physical.startsWith(prefix)) {
      // Underlying storage yielded a key outside our tenant's
      // prefix. Unreachable under a correct `Storage` impl (we
      // asked it to list our prefix), so an `Internal` invariant
      // violation is the right shape.
      throw new BaerlyError(
        "Internal",
        `Db._raw.list: storage yielded key ${JSON.stringify(physical)} outside expected prefix ${JSON.stringify(prefix)}`,
      );
    }
    return physical.slice(prefix.length);
  };

  return {
    get: (key, opts) => storage.get(toPhysical(key), opts),
    put: (key, body, opts) => storage.put(toPhysical(key), body, opts),
    delete: (key, opts) => storage.delete(toPhysical(key), opts),
    list: async function* (logicalPrefix, opts) {
      const passOpts: {
        startAfter?: string;
        maxKeys?: number;
        signal?: AbortSignal;
      } = {};
      if (opts?.startAfter !== undefined) {
        // The cursor must also be rewritten to physical — otherwise
        // the underlying storage compares a logical-keyed cursor
        // against physical-keyed entries and the cursor is
        // effectively ignored.
        passOpts.startAfter = toPhysical(opts.startAfter);
      }
      if (opts?.maxKeys !== undefined) passOpts.maxKeys = opts.maxKeys;
      if (opts?.signal !== undefined) passOpts.signal = opts.signal;
      for await (const entry of storage.list(toPhysical(logicalPrefix), passOpts)) {
        yield { ...entry, key: fromPhysical(entry.key) };
      }
    },
  };
};
