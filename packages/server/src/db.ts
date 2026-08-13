import {
  type BaerlyConfig,
  BaerlyError,
  type Collection,
  type CollectionNames,
  type CurrentJson,
  type CurrentJsonRead,
  decodeJsonBytes,
  type DocumentData,
  type IndexDefinition,
  logDeleteFloorOf,
  logObjectKey,
  type LogEntry,
  logSeqStartOf,
  readCurrentJson,
  type RowOf,
  type SchemaValidator,
  type Storage,
  type UnboundConfig,
} from "@baerly/protocol";
import { collectionsToMaps } from "./config.ts";
import { probeTailFrom } from "./log-tail.ts";
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
   * is empty, contains `/`, is `"."` or `".."`, contains control
   * characters, starts with the reserved `"_"` prefix, or exceeds
   * 256 bytes.
   *
   * @throws BaerlyError code="InvalidConfig" when `app` or `tenant` is
   *   empty, contains `/`, is `"."` or `".."`, contains control
   *   characters, starts with the reserved `"_"` prefix, or exceeds
   *   256 bytes.
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
   * @throws BaerlyError code="InvalidConfig" when `name` is empty,
   *   contains `/`, is `"."` or `".."`, contains control characters,
   *   starts with the reserved `"_"` prefix, or exceeds 256 bytes.
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
   * @throws BaerlyError code="InvalidConfig" when `name` is empty,
   *   contains `/`, is `"."` or `".."`, contains control characters,
   *   starts with the reserved `"_"` prefix, or exceeds 256 bytes.
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
    // Defensive at the db layer so ALL callers are covered — including
    // the `/v1/since` handler, whose only inline screen catches empty /
    // `/` and lets `..` / control bytes through into this key.
    assertPathSegment(collection, "collection");
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
   * `current` is the manifest this read is floored against — pass the
   * same one the `seq` was derived from. It is a parameter rather than
   * caller-enforced discipline so a new caller cannot introduce a
   * sub-floor read: entries below `current.log_seq_start` are folded
   * into the snapshot and may already be reclaimed (invariant 5 in
   * `docs/spec/sync-protocol.md`).
   *
   * @throws BaerlyError code="Internal" — `seq` is below
   *         `current.log_seq_start`, or below the certified prefix bound
   *         `current.log_delete_floor` (a distinct message: the object is
   *         gone, not merely reclaimable).
   *
   * @internal — typed seam for the HTTP handler; app code should use
   *             the collection API.
   */
  async getLogEntry(
    collection: string,
    seq: number,
    current: CurrentJson,
    opts?: { signal?: AbortSignal },
  ): Promise<LogEntry | null> {
    // Defensive at the db layer so ALL callers are covered — same
    // rationale as `getCurrentJson`; the `/v1/since` poll reaches here.
    // Path validation runs FIRST: a traversal attempt is a security
    // boundary and must not be reclassified as an invariant violation.
    assertPathSegment(collection, "collection");
    assertAtOrAboveLogFloor("getLogEntry", seq, current);
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

  /**
   * Forward-probe the TRUE committed log tail from `hint` (a lower
   * bound, typically `tail_hint`). Backs the `/v1/since` end-bound.
   *
   * `hint` stays a caller-chosen lower bound — the probe is defined
   * from an arbitrary starting point at or above the floor, and every
   * other consumer starts at `max(log_seq_start, tail_hint)`. What
   * `current` adds is that the floor cannot be forgotten (invariant 5
   * in `docs/spec/sync-protocol.md`).
   *
   * @throws BaerlyError code="Internal" — `hint` is below
   *         `current.log_seq_start`, or below the certified prefix bound
   *         `current.log_delete_floor` (a distinct message: the object is
   *         gone, not merely reclaimable).
   *
   * @internal — typed seam for the HTTP handler.
   */
  async probeLogTail(
    collection: string,
    hint: number,
    current: CurrentJson,
    opts?: { signal?: AbortSignal },
  ): Promise<number> {
    assertPathSegment(collection, "collection");
    assertAtOrAboveLogFloor("probeLogTail", hint, current);
    const logPrefix = `${physicalPrefixFor(this.app, this.tenant)}manifests/${collection}`;
    const { tail } = await probeTailFrom(this.#storage, logPrefix, hint, opts);
    return tail;
  }
}

/**
 * Guard a log-read seq against both floors on the manifest it was
 * derived from.
 *
 * Entries below `log_seq_start` have been folded into the snapshot
 * (invariant 5 in `docs/spec/sync-protocol.md`) and may be reclaimed at
 * any time, so a sub-floor read is never a legitimate request — it is
 * either a stale seq the caller failed to screen, or a caller that
 * never screened at all. Both are protocol-invariant violations by
 * internal code, hence `Internal` rather than `InvalidConfig`: no
 * client input reaches these seams unscreened (`/v1/since` rejects a
 * sub-floor cursor with `SchemaError` before ever getting here).
 *
 * Below `log_delete_floor` the contiguous prefix is certified deleted,
 * so the object is not merely *reclaimable* but already *reclaimed*.
 * The two floors get distinct messages. Same code, because both are the
 * same class of caller bug; different wording, because an operator
 * reading the throw has to know whether the bytes are recoverable.
 *
 * The floors arrive as the whole `CurrentJson` rather than as bare
 * numbers so neither can be invented independently of the manifest.
 *
 * Loud on purpose. PostgreSQL removed `old_snapshot_threshold` in PG17
 * because a fixed reclamation window that let a reader proceed
 * *silently* produced wrong answers; Oracle's `ORA-01555` is the same
 * trade and survives because it throws.
 */
const assertAtOrAboveLogFloor = (seam: string, seq: number, current: CurrentJson): void => {
  const floor = logSeqStartOf(current);
  // The delete floor is checked FIRST, and clamped.
  //
  // First, because `log_delete_floor <= log_seq_start` is a transition
  // invariant: any seq below the delete floor is also below the fold
  // floor, so an arm appended after the check below would be unreachable
  // dead code. Ordering it here changes no accept/reject outcome — only
  // which diagnostic wins — and lets the more specific one win.
  //
  // Clamped, because that `<= log_seq_start` bound is transition-scoped
  // and NOT enforced by the single-state read guard (deliberately: the
  // guard sits on `admin restore`'s own path, so failing it would leave
  // an out-of-bound floor unrepairable). An out-of-bound value therefore
  // arrives here off disk, and unclamped it would report an entry that is
  // present as already deleted.
  const storedDeleteFloor = logDeleteFloorOf(current);
  const deleteFloor = Math.min(storedDeleteFloor, floor);
  // `deleteFloor === 0` means no deleted prefix is certified, so this arm
  // has nothing to say and must stay silent: a negative seq against a
  // zero floor is a fold-floor rejection, and claiming its nonexistent
  // object was reclaimed would be the misdiagnosis this floor prevents.
  if (deleteFloor > 0 && seq < deleteFloor) {
    // Render the stored value too when the clamp bit, so an operator is
    // not told the field holds a number it does not hold.
    const clamped =
      storedDeleteFloor === deleteFloor
        ? ""
        : ` (stored log_delete_floor=${storedDeleteFloor}, clamped to log_seq_start=${floor})`;
    throw new BaerlyError(
      "Internal",
      `${seam}: seq ${seq} is below the certified delete floor ${deleteFloor}${clamped}; the log object is GONE — it has been reclaimed, not merely made reclaimable`,
    );
  }
  if (seq < floor) {
    throw new BaerlyError(
      "Internal",
      `${seam}: seq ${seq} is below the fold floor log_seq_start=${floor}; entries beneath the floor are folded into the snapshot and may already be reclaimed`,
    );
  }
};

/**
 * Guard a string used as a path-segment in the bucket-key encoding.
 * Routes through the single shared {@link assertPathSegment} rule
 * (empty / `"/"` / `"."`|`".."` / C0-C1 control / leading `"_"` (ADR-003) /
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
