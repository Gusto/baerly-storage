import {
  type BaerlyConfig,
  BaerlyError,
  type Collection,
  type CollectionNames,
  type CurrentJsonRead,
  decodeJsonBytes,
  type DocumentData,
  type IndexDefinition,
  logObjectKey,
  type LogEntry,
  readCurrentJson,
  type RowOf,
  type SchemaValidator,
  type Storage,
  type UnboundConfig,
} from "@baerly/protocol";
import { collectionsToMaps } from "./config.ts";
import { assertPathSegment } from "./path-segment.ts";
import type { CollectionReadContext } from "./query.ts";
import { makeCollection } from "./collection.ts";

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
 * **Collection provisioning.** `Db` provisions collections implicitly on
 * the first commit — the writer auto-creates the per-collection
 * `current.json` manifest with a zero-state seed, costing one extra
 * Class A PUT on the very first write per collection and zero
 * thereafter. There is no `ensureCollection` method on this class. For
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
 * await db.collection("tickets").insert({ title: "first ticket", status: "open" });
 * const open = await db.collection("tickets").where({ status: "open" }).all();
 * ```
 *
 * @remarks
 * **Anti-patterns** (TS compile errors, not runtime rejections):
 * - `db.collection(name).insertOne({...})` / `.insert({...})` —
 *   the Mongo verb. Use `.insert(row)` (returns `{ _id }`).
 * - `db.collection(name).findOne({...})` / `.find({...})` —
 *   the Mongo read verbs. Use `.get(id)` for by-id reads and
 *   `.where({...}).first()` / `.all()` for predicate reads.
 * - `db.collection(name).aggregate([...])` — no pipeline stage
 *   model. Compose via `.where().order().limit()` modifiers.
 * - Raw SQL strings of any shape. The kernel has no SQL parser.
 */
export class Db<TConfig extends BaerlyConfig = UnboundConfig> {
  readonly app: string;
  readonly tenant: string;
  /**
   * Underlying `Storage`, captured so the collection API can issue reads
   * using physical keys directly.
   */
  readonly #storage: Storage;
  /**
   * Per-collection {@link SchemaValidator}s threaded onto every
   * {@link CollectionReadContext} this `Db` mints. Empty map means "no
   * validation declared" — every write proceeds at zero overhead.
   *
   * Derived from `config.collections[*].schema` via
   * {@link collectionsToMaps} at {@link Db.create} time.
   */
  readonly #schemas: ReadonlyMap<string, SchemaValidator>;
  /**
   * Per-collection {@link IndexDefinition}s threaded onto every
   * {@link CollectionReadContext} this `Db` mints. Empty map means "no
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
   * await db.collection("tickets").insert({ title: "hi" });
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
     * 1. **Types.** `db.collection(name)` narrows `name` to declared
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
     * // db.collection("tickets") is typed AND validates writes against
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
   * Typed handle for a single collection. Cheap; creates no I/O. Same
   * `name` returns a FRESH `Collection<T>` object on each call (chain
   * identity is intentional — modifiers return new objects).
   *
   * @throws BaerlyError code="InvalidConfig" when `name` is empty or
   *   contains `/`.
   *
   * @example
   * ```ts
   * // With a baerly.config.ts bound via Db.create({..., config}),
   * // db.collection(name) infers the row type from the declared schema —
   * // no <Ticket> generic needed.
   * const open = await db.collection("tickets")
   *   .where({ status: "open" })
   *   .order({ commit_ts: "desc" })
   *   .limit(50)
   *   .all();
   * ```
   */
  // One signature. When `TConfig` extends `UnboundConfig`,
  // `CollectionNames<UnboundConfig>` widens to `string` so kernel-internal
  // paths against `Db<UnboundConfig>` still resolve without a separate
  // untyped overload. The impl signature stays widened (`Collection<any>`)
  // — the runtime never narrows; `makeCollection<DocumentData>` builds a
  // single row-agnostic handle and TypeScript handles the rest at the
  // call site.
  collection<N extends CollectionNames<TConfig>>(
    name: N,
  ): Collection<RowOf<TConfig, N> & DocumentData>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- impl signature must be wider than the public overload; with Predicate<T> typed, Collection<DocumentData> is no longer assignable to Collection<RowOf<...>&DocumentData> due to contravariance on where(). `any` widens correctly.
  collection(name: string): Collection<any> {
    return makeCollection<DocumentData>(this.collectionReadContext(name));
  }

  /**
   * Build a freshly-seeded {@link CollectionReadContext} for `name`. The
   * HTTP router uses this so it can drive `runAllWithMeta` directly
   * (the return shape carries the manifest-pointer cursor used to
   * pack `_meta` onto the read response envelope). Application
   * callers should keep using
   * {@link Db.collection}; the chainable terminals destructure the cursor
   * out and discard it to keep the locked `Query<T>` signature.
   *
   * Runs the same `name`-validation guard as {@link Db.collection}.
   *
   * @throws BaerlyError code="InvalidConfig" when `name` is empty or
   *   contains `/`.
   * @internal
   */
  collectionReadContext(name: string): CollectionReadContext {
    assertKeySegment(name, "collection", "Db.collection");
    const schema = this.#schemas.get(name);
    return {
      storage: this.#storage,
      collectionPrefix: `${physicalPrefixFor(this.app, this.tenant)}manifests/${name}`,
      collectionName: name,
      indexes: this.#indexes.get(name) ?? [],
      ...(schema !== undefined ? { schema } : {}),
    };
  }

  /**
   * Read + parse this `Db`'s `manifests/<collection>/current.json`. Returns
   * `null` when the collection has not been provisioned yet (no
   * `current.json` exists). Throws `BaerlyError{code:"InvalidResponse"}`
   * on a malformed body — same contract as the underlying
   * {@link readCurrentJson} helper in `@baerly/protocol`.
   *
   * Backs the `/v1/since` long-poll handler in
   * `packages/server/src/http/since.ts`; that handler needs the parsed
   * `CurrentJson` plus an ETag for the follow-up reads.
   *
   * @internal — typed seam for the HTTP handler; app code should use
   *             the collection API.
   */
  async getCurrentJson(
    collection: string,
    opts?: { signal?: AbortSignal },
  ): Promise<CurrentJsonRead | null> {
    const key = `${physicalPrefixFor(this.app, this.tenant)}manifests/${collection}/current.json`;
    return readCurrentJson(this.#storage, key, opts);
  }

  /**
   * Read + parse one `LogEntry` by `seq` from
   * `manifests/<collection>/log/<seq>.json`. Returns `null`
   * when the entry is missing — this typically means the GC sweeper
   * deleted the entry between a `readCurrentJson` and this GET (the
   * `/v1/since` handler treats the race as silent and skips the
   * entry). Throws `BaerlyError{code:"InvalidResponse"}` on a body
   * that isn't valid JSON.
   *
   * @internal — typed seam for the HTTP handler; app code should use
   *             the collection API.
   */
  async getLogEntry(
    collection: string,
    seq: number,
    opts?: { signal?: AbortSignal },
  ): Promise<LogEntry | null> {
    const key = logObjectKey(
      `${physicalPrefixFor(this.app, this.tenant)}manifests/${collection}`,
      seq,
    );
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
 * Routes through the single shared {@link assertPathSegment} rule
 * (empty / `"/"` / `"."`|`".."` / C0-C1 control / leading `"_"` (ADR-007) /
 * overlong), all as `BaerlyError{code:"InvalidConfig"}`. `role` and `verb`
 * are baked into the message so the caller doesn't need to format their own.
 *
 * Used by {@link Db.create} (twice — `app`, `tenant`) and
 * {@link Db.collectionReadContext} (once — `name`).
 *
 * @internal
 */
const assertKeySegment = (value: string, role: string, verb: string): void => {
  assertPathSegment(value, role, verb);
};
