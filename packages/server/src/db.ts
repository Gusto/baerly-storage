import {
  type BaerlyConfig,
  type Collection,
  type CollectionNames,
  type DocumentData,
  type RowOf,
  type SchemaValidator,
  type Storage,
  type UnboundConfig,
} from "@baerly/protocol";
import { collectionsToMaps } from "./config.ts";
import { makeCollection } from "./collection.ts";
import { assertKeySegment, collectionReadContext, registerDbInternals } from "./db-read-seams.ts";

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
 * that want the manifest in place before the first request), use
 * {@link "@gusto/baerly-storage/dev".ensureTable}. The two seeds are
 * equivalent, not byte-identical: each mints its own `generation`
 * nonce. Harmless — `If-None-Match` means exactly one lands.
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

  private constructor(
    app: string,
    tenant: string,
    storage: Storage,
    schemas: ReadonlyMap<string, SchemaValidator>,
  ) {
    this.app = app;
    this.tenant = tenant;
    this.#storage = storage;
    this.#schemas = schemas;
  }

  /**
   * Build a tenant-scoped `Db`. Throws
   * `BaerlyError{code:"InvalidConfig"}` if either `app` or `tenant`
   * is empty, contains `/`, is `"."` or `".."`, contains control
   * characters, starts with the reserved `"_"` prefix, exceeds
   * 256 bytes, contains an unpaired UTF-16 surrogate
   * (`!name.isWellFormed()`), or is not in Unicode Normalization Form C
   * (`name !== name.normalize("NFC")`). Names are never normalized for
   * you: pass `name.normalize("NFC")`.
   *
   * @throws BaerlyError code="InvalidConfig" when `app`, `tenant`, or a
   *   `config.collections` key is empty, contains `/`, is `"."` or
   *   `".."`, contains control characters, starts with the reserved
   *   `"_"` prefix, exceeds 256 bytes, contains an unpaired surrogate,
   *   or is not NFC.
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
     * 2. **Runtime.** Schemas are wired from `config.collections`
     *    via {@link collectionsToMaps} — no second hand-off step.
     *    Declared `indexes` are validated here (a malformed one throws
     *    `SchemaError` or `InvalidConfig`) but do not speed up reads
     *    or change their results or costs.
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
    // Config collection keys fail here, not at first use.
    for (const name of Object.keys(config.config?.collections ?? {})) {
      assertKeySegment(name, "collection", "Db.create");
    }
    // Always derive runtime maps from `config.collections` (which also
    // validates every index declaration). Absent config ⇒ no schemas;
    // the kernel behaves the same as a config with `collections: {}`.
    const derived =
      config.config !== undefined ? collectionsToMaps(config.config.collections) : undefined;
    return new Db<TConfig>(app, tenant, storage, derived?.schemas ?? new Map());
  }

  /**
   * Typed handle for a single collection. Cheap; creates no I/O. Same
   * `name` returns a FRESH `Collection<T>` object on each call (chain
   * identity is intentional — modifiers return new objects).
   *
   * @throws BaerlyError code="InvalidConfig" when `name` is empty,
   *   contains `/`, is `"."` or `".."`, contains control characters,
   *   starts with the reserved `"_"` prefix, exceeds 256 bytes, or is
   *   not in Unicode Normalization Form C.
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
    return makeCollection<DocumentData>(collectionReadContext(this, name));
  }

  static {
    // Grants the read seams in `./db-read-seams.ts` access to the private
    // fields without putting them on the public class.
    registerDbInternals((db) => ({ storage: db.#storage, schemas: db.#schemas }));
  }
}
