/* eslint-disable no-underscore-dangle -- `_raw` is the locked public-symbol
   name for the Storage escape hatch; marked `@internal`. */

import {
  BaerlyError,
  type CurrentJsonRead,
  decodeJsonBytes,
  type DocumentData,
  LOG_KEY_PREFIX,
  type LogEntry,
  type MetricsRecorder,
  noopMetricsRecorder,
  readCurrentJson,
  type Storage,
  type StorageGetOptions,
  type StorageGetResult,
  type StorageListEntry,
  type StoragePutOptions,
  type StoragePutResult,
  type Table,
} from "@baerly/protocol";
import type { BaerlyConfig, CollectionNames, RowOf, UnboundConfig } from "./config.ts";
import type { IndexDefinition } from "./indexes.ts";
import type { CurrentJsonCacheSlot, TableReadContext } from "./query.ts";
import type { SchemaValidator } from "./schema.ts";
import { Writer, type CommitInput } from "./writer.ts";
import { makeTable } from "./table.ts";

/**
 * In-memory buffer for a single in-flight {@link Db.transaction}
 * call. The `Table<T>` instance passed to the transaction body holds
 * a reference to this object; every mutation verb appends to
 * `mutations` instead of calling `Writer.commit` directly.
 *
 * After the body resolves, `Db.transaction` performs ONE
 * `Writer.commitBatch(...)` to commit every buffered mutation
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
   * each into one `CommitInput` (`Writer`'s single-mutation
   * shape) and passes the array to `Writer.commitBatch`.
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
  readonly body?: DocumentData;
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
 * Escape hatch: a Storage-shaped surface scoped to one
 * `(app, tenant)` pair. Keys callers see are **logical** (e.g.
 * `"docs/123"`); the wrapper composes
 * `app/<app>/tenant/<tenant>/<key>` before touching the underlying
 * `Storage`, and strips the prefix back off when yielding from
 * `list`.
 *
 * Bypasses every higher-level invariant: no `LogEntry` emit, no CAS
 * on `current.json`, no schema check.
 *
 * @internal — public symbol, but the table API is the recommended
 *             surface for app code.
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
 * Runtime entry point. One `Db` per `(app, tenant)` request.
 *
 * Construct via {@link Db.create} — the constructor is private so
 * callers don't accidentally bypass validation.
 *
 * **Table provisioning.** `Db` provisions tables implicitly on first
 * write — there is no `ensureTable` method on this class. For
 * dev-time eager provisioning (e.g. seed scripts), use
 * {@link "baerly-storage/dev".ensureTable}.
 *
 * @example
 * ```ts
 * import { Db } from "baerly-storage";
 * import { MemoryStorage } from "baerly-storage";
 *
 * const db = Db.create({
 *   storage: new MemoryStorage(),
 *   app: "tickets",
 *   tenant: "acme-co",
 * });
 *
 * await db.table("tickets").insert({ title: "first ticket", status: "open" });
 * const open = await db.table("tickets").where({ status: "open" }).all();
 * ```
 */
export class Db<TConfig extends BaerlyConfig = UnboundConfig> {
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
  /**
   * Metrics sink forwarded to every {@link Writer} this `Db`
   * constructs (the single-mutation path in `query.ts:writerFor` and
   * the transaction path below). Defaults to
   * {@link noopMetricsRecorder} so non-instrumented callers see zero
   * behavioural change. Threaded onto every {@link TableReadContext}
   * the table API hands out.
   */
  readonly #metrics: MetricsRecorder;
  /**
   * Per-collection {@link SchemaValidator}s threaded onto every
   * {@link TableReadContext} this `Db` mints. Empty map means "no
   * validation declared" — every write proceeds at zero overhead.
   *
   * Mirrors the shape callers build when flattening
   * `BaerlyConfig.collections[*].schema` into a map keyed by name
   * before constructing the `Db`; we keep the `Db` itself library-
   * agnostic by accepting the pre-flattened map (not the full
   * `BaerlyConfig`).
   */
  readonly #schemas: ReadonlyMap<string, SchemaValidator>;
  /**
   * Per-collection {@link IndexDefinition}s threaded onto every
   * {@link TableReadContext} this `Db` mints. Empty map means "no
   * indexes declared" — every read falls through to the snapshot +
   * log fold path.
   *
   * Mirrors the shape callers build when flattening
   * `BaerlyConfig.collections[*].indexes` into a map keyed by name
   * before constructing the `Db`; we keep the `Db` itself library-
   * agnostic by accepting the pre-flattened map (not the full
   * `BaerlyConfig`).
   */
  readonly #indexes: ReadonlyMap<string, ReadonlyArray<IndexDefinition>>;

  private constructor(
    app: string,
    tenant: string,
    storage: Storage,
    metrics: MetricsRecorder,
    schemas: ReadonlyMap<string, SchemaValidator>,
    indexes: ReadonlyMap<string, ReadonlyArray<IndexDefinition>>,
  ) {
    this.app = app;
    this.tenant = tenant;
    this.#storage = storage;
    this.#metrics = metrics;
    this.#schemas = schemas;
    this.#indexes = indexes;
    this._raw = makeRawStorageApi(app, tenant, storage);
  }

  /**
   * Build a tenant-scoped `Db`. Throws
   * `BaerlyError{code:"InvalidConfig"}` if either `app` or `tenant`
   * is empty or contains `/` (the segment separator).
   *
   * `config.metrics` is an optional {@link MetricsRecorder} forwarded
   * to every {@link Writer} the `Db` constructs — both the
   * single-mutation path (`Table.insert` / `Query.update` /
   * `Query.replace` / `Query.delete`) and the transaction path
   * ({@link Db.transaction}). Defaults to {@link noopMetricsRecorder}
   * so non-instrumented callers see zero behavioural change. The
   * observability layer wires its per-request recorder here
   * so writer emissions (`db.write.class_a_ops_per_logical_write`,
   * `db.r2.put.412_total`, etc.) reach the operator's sink.
   *
   * @throws BaerlyError code="InvalidConfig" when `app` or `tenant` is
   *   empty or contains `/`.
   *
   * @example
   * ```ts
   * import { InMemoryMetricsRecorder } from "baerly-storage";
   * const metrics = new InMemoryMetricsRecorder();
   * const db = Db.create({ storage, app: "tickets", tenant: "acme", metrics });
   * await db.table("tickets").insert({ title: "hi" });
   * // metrics.histogramValues("db.write.class_a_ops_per_logical_write")
   * ```
   *
   * @example
   * ```ts
   * // Wire declared indexes through Db.create so the auto-planner
   * // can route reads. The map key is the collection name; the
   * // value is the IndexDefinition array. Mirrors the shape
   * // callers build when flattening BaerlyConfig.collections[*].indexes.
   * import { Db } from "baerly-storage";
   * import { MemoryStorage } from "baerly-storage";
   *
   * const db = Db.create({
   *   storage: new MemoryStorage(),
   *   app: "tickets",
   *   tenant: "acme",
   *   indexes: new Map([
   *     ["tickets", [
   *       { name: "by_status", on: "status" },
   *       { name: "by_status_priority", on: ["status", "priority"] },
   *       { name: "by_open_assignee",
   *         on: "assignee",
   *         predicate: { status: "open" } },
   *     ]],
   *   ]),
   * });
   *
   * // Single-field index routes equality predicates.
   * await db.table("tickets").where({ status: "open" }).all();
   * // Composite index routes left-anchored equality.
   * await db.table("tickets")
   *   .where({ status: "open", priority: "p1" }).all();
   * // Filtered index implies `status: "open"` — preferred over
   * // `by_status` when both match.
   * await db.table("tickets")
   *   .where({ status: "open", assignee: "alice" }).all();
   * ```
   */
  static create<TConfig extends BaerlyConfig = UnboundConfig>(config: {
    storage: Storage;
    app: string;
    tenant: string;
    metrics?: MetricsRecorder;
    /**
     * Optional per-collection {@link SchemaValidator} map. The adapter
     * layer (or app code) flattens `BaerlyConfig.collections[*].schema`
     * into this map before constructing the `Db`; the `Db` itself
     * stays library-agnostic. `undefined` or an empty map means "no
     * validation" — every write proceeds at zero overhead.
     */
    schemas?: ReadonlyMap<string, SchemaValidator>;
    /**
     * Per-collection {@link IndexDefinition} map. Each entry is one
     * collection's declared indexes. The auto-planner
     * ({@link planQuery} in `./query-planner.ts`) consults this map
     * at read time; declaring an index here is the only way to bias
     * the read path — there is no manual-hint API on `Query<T>`.
     * The adapter layer (or app code) flattens
     * `BaerlyConfig.collections[*].indexes` into this map before
     * constructing the `Db`. `undefined` or an empty map means "no
     * indexes declared" — every read falls through to the
     * snapshot+log fold at zero overhead.
     */
    indexes?: ReadonlyMap<string, ReadonlyArray<IndexDefinition>>;
    /**
     * Optional. When passed, `db.table(name)` narrows `name` to declared
     * collection names and infers the row type from
     * `collections[name].schema`. Pass the value returned by
     * {@link defineConfig} from your `baerly.config.ts`.
     *
     * Type-only seam: `Db` does not read `config` at runtime — the
     * runtime path still consults the separately-passed `schemas` /
     * `indexes` maps. The field exists purely so TypeScript can capture
     * a literal-pinned `TConfig`, off of which `db.table("name")` then
     * recovers the row's `_id` / field shape via {@link RowOf}.
     *
     * Adapter authors continue to pass `schemas` + `indexes` maps as
     * today. `config` is for app-side callers who construct `Db`
     * directly with a `baerly.config.ts` in scope.
     */
    config?: TConfig;
  }): Db<TConfig> {
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
    return new Db<TConfig>(
      app,
      tenant,
      storage,
      config.metrics ?? noopMetricsRecorder,
      config.schemas ?? new Map(),
      config.indexes ?? new Map(),
    );
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
   * // With a baerly.config.ts bound via Db.create({..., config}),
   * // db.table(name) infers the row type from the declared schema —
   * // no <Ticket> generic needed.
   * const open = await db.table("tickets")
   *   .where({ status: "open" })
   *   .order({ commit_ts: "desc" })
   *   .limit(50)
   *   .all();
   * ```
   */
  // Resolution order: narrowing overload first (matches declared
  // collection names against bound `TConfig`), legacy generic second
  // (caller picks T; defaults to `DocumentData` to mirror the
  // impl's runtime return shape). The impl signature stays widest —
  // `Table<DocumentData>` — so byte-identical to overload #2's
  // default. The runtime never narrows; `makeTable<DocumentData>`
  // builds a single row-agnostic handle and TypeScript handles the rest
  // at the call site.
  table<N extends CollectionNames<TConfig>>(name: N): Table<RowOf<TConfig, N> & DocumentData>;
  table<T extends DocumentData = DocumentData>(name: string): Table<T>;
  table(name: string): Table<DocumentData> {
    return makeTable<DocumentData>(this.tableReadContext(name));
  }

  /**
   * Build a freshly-seeded {@link TableReadContext} for `name`. The
   * HTTP router uses this so it can drive `runAllWithMeta` directly
   * (the return shape carries the manifest-pointer cursor used to
   * pack `_meta` onto the read response envelope). Application
   * callers should keep using
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
    const schema = this.#schemas.get(name);
    return {
      storage: this.#storage,
      tablePrefix: `${physicalPrefixFor(this.app, this.tenant)}manifests/${name}`,
      tableName: name,
      currentJsonCache: cache,
      metrics: this.#metrics,
      indexes: this.#indexes.get(name) ?? [],
      ...(schema !== undefined ? { schema } : {}),
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
   * @remarks
   * Single-table by design. Cross-table 2PC was rejected on cost
   * grounds — multiple round-trips per commit, no native fencing
   * primitive on S3-compatible storage, no rollback to undo a
   * successful PUT — and because in-doubt-transaction recovery state
   * would contradict the stateless-writer model. Applications that
   * need cross-table atomicity re-express it at the app layer: an
   * idempotent move keyed off source-row state, or a single
   * denormalized table with a `status` column.
   *
   * @example
   * ```ts
   * await db.transaction("tickets", async (tx) => {
   *   const open = await tx.where({ status: "open" }).count();
   *   if (open < 100) await tx.insert({ title: "another", status: "open" });
   * });
   * ```
   */
  async transaction<T extends DocumentData = DocumentData>(
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
    // read-your-writes inside a transaction).
    // Reuse the per-(Db, table) `currentJsonCache` slot so a
    // transaction's reads share the same `eventual`-anchor seen by
    // pre-transaction `Db.table(table)` calls. Allocate one lazily
    // if no `Db.table(table)` ran first.
    let cache = this.#currentJsonCaches.get(table);
    if (cache === undefined) {
      cache = { value: null };
      this.#currentJsonCaches.set(table, cache);
    }
    const schema = this.#schemas.get(table);
    const indexes = this.#indexes.get(table) ?? [];
    const tx = makeTable<T>({
      storage: this.#storage,
      tablePrefix,
      tableName: table,
      txCtx,
      currentJsonCache: cache,
      metrics: this.#metrics,
      indexes,
      ...(schema !== undefined ? { schema } : {}),
    });

    // Run the body. Reads go through Storage live; mutations append
    // to txCtx.mutations. A throw here propagates AS-IS and skips
    // the commit (txCtx.mutations is discarded).
    await body(tx);

    // Empty buffer — nothing to commit, nothing to throw.
    if (txCtx.mutations.length === 0) {
      return;
    }

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

    const writer = new Writer({
      storage: this.#storage,
      currentJsonKey: `${tablePrefix}/current.json`,
      options: { metrics: this.#metrics, indexes },
    });
    await writer.commitBatch(inputs);
  }

  /**
   * Read + parse this `Db`'s `manifests/<table>/current.json`. Returns
   * `null` when the table has not been provisioned yet (no
   * `current.json` exists). Throws `BaerlyError{code:"InvalidResponse"}`
   * on a malformed body — same contract as the underlying
   * {@link readCurrentJson} helper in `@baerly/protocol`.
   *
   * Backs the `/v1/since` long-poll handler in
   * `packages/server/src/http/since.ts`; that handler needs the parsed
   * `CurrentJson` plus an ETag for the follow-up reads.
   *
   * @internal — public symbol, but the table API is the recommended
   *             surface for app code; this is here so the HTTP handler
   *             doesn't have to reach through `_raw` under a
   *             Storage-shaped half-stub.
   */
  async getCurrentJson(
    table: string,
    opts?: { signal?: AbortSignal },
  ): Promise<CurrentJsonRead | null> {
    const key = `${physicalPrefixFor(this.app, this.tenant)}manifests/${table}/current.json`;
    return readCurrentJson(this.#storage, key, opts);
  }

  /**
   * Read + parse one `LogEntry` by `seq` from
   * `manifests/<table>/${LOG_KEY_PREFIX}/<seq>.json`. Returns `null`
   * when the entry is missing — this typically means the GC sweeper
   * deleted the entry between a `readCurrentJson` and this GET (the
   * `/v1/since` handler treats the race as silent and skips the
   * entry). Throws `BaerlyError{code:"InvalidResponse"}` on a body
   * that isn't valid JSON.
   *
   * @internal — public symbol, but the table API is the recommended
   *             surface for app code; this is here so the HTTP handler
   *             doesn't have to reach through `_raw` directly.
   */
  async getLogEntry(
    table: string,
    seq: number,
    opts?: { signal?: AbortSignal },
  ): Promise<LogEntry | null> {
    const key = `${physicalPrefixFor(this.app, this.tenant)}manifests/${table}/${LOG_KEY_PREFIX}/${seq}.json`;
    const got = await this.#storage.get(key, opts);
    if (got === null) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = decodeJsonBytes(got.body);
    } catch (error) {
      throw new BaerlyError(
        "InvalidResponse",
        `log entry at ${key}: body is not valid JSON`,
        error,
      );
    }
    return parsed as LogEntry;
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
      if (opts?.maxKeys !== undefined) {
        passOpts.maxKeys = opts.maxKeys;
      }
      if (opts?.signal !== undefined) {
        passOpts.signal = opts.signal;
      }
      for await (const entry of storage.list(toPhysical(logicalPrefix), passOpts)) {
        yield { ...entry, key: fromPhysical(entry.key) };
      }
    },
  };
};
