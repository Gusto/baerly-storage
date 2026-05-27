import {
  type BaerlyConfig,
  BaerlyError,
  type CollectionNames,
  type CurrentJsonRead,
  decodeJsonBytes,
  type DocumentData,
  type IndexDefinition,
  LOG_KEY_PREFIX,
  type LogEntry,
  readCurrentJson,
  type RowOf,
  type SchemaValidator,
  type Storage,
  type Table,
  type UnboundConfig,
} from "@baerly/protocol";
import { collectionsToMaps } from "./config.ts";
import type { TableReadContext } from "./query.ts";
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
 * Runtime entry point. One `Db` per `(app, tenant)` request.
 *
 * Construct via {@link Db.create} — the constructor is private so
 * callers don't accidentally bypass validation.
 *
 * **Table provisioning.** `Db` provisions tables implicitly on the
 * first commit — the writer auto-creates the per-collection
 * `current.json` manifest with a zero-state seed, costing one extra
 * Class A PUT on the very first write per collection and zero
 * thereafter. There is no `ensureTable` method on this class. For
 * eager pre-warm (seed scripts, deploy-time provisioning, CI fixtures
 * that want byte-identical bytes before the first request), use
 * {@link "@gusto/baerly-storage/dev".ensureTable}.
 *
 * @example
 * ```ts
 * import { Db } from "@gusto/baerly-storage";
 * import { MemoryStorage } from "@gusto/baerly-storage";
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
  /**
   * Underlying `Storage`, captured so the table API can issue reads
   * using physical keys directly.
   */
  readonly #storage: Storage;
  /**
   * Per-collection {@link SchemaValidator}s threaded onto every
   * {@link TableReadContext} this `Db` mints. Empty map means "no
   * validation declared" — every write proceeds at zero overhead.
   *
   * Derived from `config.collections[*].schema` via
   * {@link collectionsToMaps} at {@link Db.create} time.
   */
  readonly #schemas: ReadonlyMap<string, SchemaValidator>;
  /**
   * Per-collection {@link IndexDefinition}s threaded onto every
   * {@link TableReadContext} this `Db` mints. Empty map means "no
   * indexes declared" — every read falls through to the snapshot +
   * log fold path.
   *
   * Derived from `config.collections[*].indexes` via
   * {@link collectionsToMaps} at {@link Db.create} time.
   */
  readonly #indexes: ReadonlyMap<string, ReadonlyArray<IndexDefinition>>;

  private constructor(
    app: string,
    tenant: string,
    storage: Storage,
    schemas: ReadonlyMap<string, SchemaValidator>,
    indexes: ReadonlyMap<string, ReadonlyArray<IndexDefinition>>,
  ) {
    this.app = app;
    this.tenant = tenant;
    this.#storage = storage;
    this.#schemas = schemas;
    this.#indexes = indexes;
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
   * await db.table("tickets").insert({ title: "hi" });
   * ```
   */
  static create<TConfig extends BaerlyConfig = UnboundConfig>(config: {
    storage: Storage;
    app: string;
    tenant: string;
    /**
     * Optional. Pass the value returned by {@link defineConfig} from
     * your `baerly.config.ts`. Two things happen:
     *
     * 1. **Types.** `db.table(name)` narrows `name` to declared
     *    collection names and infers the row type from
     *    `collections[name].schema` via {@link RowOf}.
     * 2. **Runtime.** Schemas and indexes are derived from
     *    `config.collections` via {@link collectionsToMaps}. Schema
     *    validation and index routing are wired automatically — no
     *    second hand-off step.
     *
     * @example
     * ```ts
     * import config from "../baerly.config.ts";
     * const db = Db.create({
     *   storage: new MemoryStorage(),
     *   app: "helpdesk",
     *   tenant: "test",
     *   config,
     * });
     * // db.table("tickets") is typed AND validates writes against
     * // the schema declared in baerly.config.ts.
     * ```
     */
    config?: TConfig;
  }): Db<TConfig> {
    const { storage, app, tenant } = config;
    assertKeySegment(app, "app", "Db.create");
    assertKeySegment(tenant, "tenant", "Db.create");
    // Always derive runtime maps from `config.collections`. Absent
    // config ⇒ empty maps (no schemas, no indexes); the kernel
    // behaves the same as a config with `collections: {}`.
    const derived =
      config.config !== undefined ? collectionsToMaps(config.config.collections) : undefined;
    return new Db<TConfig>(
      app,
      tenant,
      storage,
      derived?.schemas ?? new Map(),
      derived?.indexes ?? new Map(),
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
  // `Table<any>` — so assignable to all overloads despite contravariance
  // on `where()`. The runtime never narrows; `makeTable<DocumentData>`
  // builds a single row-agnostic handle and TypeScript handles the rest
  // at the call site.
  table<N extends CollectionNames<TConfig>>(name: N): Table<RowOf<TConfig, N> & DocumentData>;
  table<T extends DocumentData = DocumentData>(name: string): Table<T>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- impl signature must be wider than all overloads; with Predicate<T> typed, Table<DocumentData> is no longer assignable to Table<RowOf<...>&DocumentData> due to contravariance on where(). `any` widens correctly.
  table(name: string): Table<any> {
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
    assertKeySegment(name, "table", "Db.table");
    const schema = this.#schemas.get(name);
    return {
      storage: this.#storage,
      tablePrefix: `${physicalPrefixFor(this.app, this.tenant)}manifests/${name}`,
      tableName: name,
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
    assertKeySegment(table, "table", "Db.transaction");

    const txCtx: TxContext = { table, mutations: [] };
    const tablePrefix = `${physicalPrefixFor(this.app, this.tenant)}manifests/${table}`;

    // Build a Table<T> whose mutation verbs buffer onto `txCtx`. The
    // read path ignores `txCtx` entirely (locked: no MVCC, no
    // read-your-writes inside a transaction).
    const schema = this.#schemas.get(table);
    const indexes = this.#indexes.get(table) ?? [];
    const tx = makeTable<T>({
      storage: this.#storage,
      tablePrefix,
      tableName: table,
      txCtx,
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
      options: { indexes },
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
   * @internal — typed seam for the HTTP handler; app code should use
   *             the table API.
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
   * @internal — typed seam for the HTTP handler; app code should use
   *             the table API.
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

/**
 * Guard a string used as a path-segment in the bucket-key encoding.
 * Rejects empty and `/`-containing values with
 * `BaerlyError{code:"InvalidConfig"}`. `role` and `verb` are baked
 * into the message so the caller doesn't need to format their own.
 *
 * Used by {@link Db.create} (twice — `app`, `tenant`),
 * {@link Db.tableReadContext} (once — `name`), and
 * {@link Db.transaction} (once — `table`).
 *
 * @internal
 */
const assertKeySegment = (value: string, role: string, verb: string): void => {
  if (value.length === 0) {
    throw new BaerlyError(
      "InvalidConfig",
      `${verb}: ${role} must be non-empty (got ${JSON.stringify(value)})`,
    );
  }
  if (value.includes("/")) {
    throw new BaerlyError(
      "InvalidConfig",
      `${verb}: "/" is reserved as the key-segment separator (got ${role}=${JSON.stringify(value)})`,
    );
  }
};
