/* eslint-disable no-underscore-dangle -- `_id` and `_meta` are the
   locked wire-shape field names (see `packages/protocol/src/collection-api.ts`
   and `packages/server/src/contract.ts`); we mirror them verbatim
   so the typed client stays structurally compatible. */

import {
  assertDocumentValues,
  assertInsertIdType,
  type BaerlyConfig,
  BaerlyError,
  type CollectionNames,
  type DocumentData,
  EMPTY_PREDICATE_WIRE,
  normalizePredicateArg,
  type OrderSpec,
  type PredicateArg,
  type PredicateWire,
  type RowOf,
  type UnboundConfig,
  uuidv7,
} from "@baerly/protocol";
import { CLIENT_CONTEXT, CLIENT_SCOPE } from "./internal/context.ts";
import { type BaerlyWarning, type Fetcher, type RequestContext, request } from "./request.ts";

/**
 * Public options for {@link createBaerlyClient}.
 *
 * @example
 * ```ts
 * const client = createBaerlyClient({
 *   baseUrl: "https://api.example.com",
 *   headers: { Authorization: "Bearer <token>" },
 * });
 * ```
 */
export interface BaerlyClientOptions<TConfig extends BaerlyConfig = UnboundConfig> {
  /**
   * Required. The deployed `baerly` server URL — e.g.
   * `https://acme.example.com`. No trailing slash.
   */
  readonly baseUrl: string;
  /**
   * Optional. Defaults to `globalThis.fetch`. Wrap your own to add
   * logging, retries, tracing, or auth-refresh — the entire client
   * routes every request through this one function. This is the
   * `link` middleware story (tRPC) and the `interceptor` story
   * (axios) without new API surface.
   *
   * @example
   * ```ts
   * // Log every request + response.
   * const withLogging: Fetcher = async (req) => {
   *   const t0 = performance.now();
   *   const res = await globalThis.fetch(req);
   *   console.log(`${req.method} ${req.url} → ${res.status} (${Math.round(performance.now() - t0)}ms)`);
   *   return res;
   * };
   *
   * // Retry idempotent reads on 5xx (max 3 total attempts, 100ms backoff).
   * const withRetry = (next: Fetcher): Fetcher => async (req) => {
   *   for (let i = 0; i < 2; i++) {
   *     const res = await next(req.clone());
   *     if (res.ok || res.status < 500 || req.method !== "GET") return res;
   *     await new Promise((r) => setTimeout(r, 100 * (i + 1)));
   *   }
   *   return next(req);
   * };
   *
   * const client = createBaerlyClient({
   *   baseUrl: "https://api.example.com",
   *   fetch: withRetry(withLogging),
   * });
   * ```
   *
   * See `dist/API.md` → "Recipe — wrapping the client `fetch`"
   * for `onSuccess` / `onError` helpers and a composition pattern.
   */
  readonly fetch?: Fetcher;
  /**
   * Optional. Forwarded on every request. Typically
   * `{ Authorization: "Bearer <token>" }`. For credential refresh
   * (fresh JWT per call, 401-driven re-issue, etc.) wrap
   * {@link BaerlyClientOptions.fetch} instead — see the retry +
   * logging examples above.
   */
  readonly headers?: Headers | Record<string, string>;
  /**
   * Optional. Called once for each successful response that carries a
   * server warning; see {@link BaerlyWarning}. Today that is the
   * capacity warning: a write that committed but left its collection at
   * 90% or more of what the host can hold, so inserts and growing
   * updates will soon be refused with `CapacityExceeded`. The write's
   * own result is unchanged, and a callback that throws (or returns a
   * rejected promise) cannot fail it. Without this option warnings are
   * dropped.
   *
   * Cross-origin browser apps also need the server's CORS layer to list
   * `Baerly-Capacity-Warning` in `Access-Control-Expose-Headers`, or the
   * browser hides the header from the client.
   *
   * @example
   * ```ts
   * const client = createBaerlyClient({
   *   baseUrl: "https://api.example.com",
   *   onWarning: (w) => console.warn(`${w.method} ${w.path}: ${w.message}`),
   * });
   * ```
   */
  readonly onWarning?: (warning: BaerlyWarning) => void;
  /**
   * Optional. **Type-only** — the runtime client does not read this
   * field; it exists so `client.collection(name)` can narrow `name` to
   * declared collection names and infer the row type from
   * `collections[name].schema`. Bind the type via the generic
   * parameter using `import type` so the server-side storage
   * adapter and secrets in `baerly.config.ts` do not enter the
   * browser bundle:
   *
   * ```ts
   * import type config from "./baerly.config.ts";
   * const client = createBaerlyClient<typeof config>({ baseUrl });
   * await client.collection("tickets").first(); // Promise<Ticket | undefined>
   * ```
   *
   * Skip the type parameter to fall back to the per-call generic
   * `client.collection("tickets")` form.
   */
  readonly config?: TConfig;
}

/**
 * Trailing-options bag accepted by every terminal. Today this is
 * only `signal`, so the type is split out for readability rather
 * than forcing every call site to ascribe `{ signal?: AbortSignal }`.
 * When other per-call options land (timeout, idempotency key, etc.)
 * they belong here.
 */
export interface TerminalOptions {
  /**
   * Cancels this specific request. React effect cleanup is the
   * canonical caller:
   *
   * ```ts
   * useEffect(() => {
   *   const ac = new AbortController();
   *   client.collection("tickets").where(p).all({ signal: ac.signal }).then(setRows);
   *   return () => ac.abort();
   * }, [predicateKey]);
   * ```
   */
  readonly signal?: AbortSignal;
}

/**
 * Client-side mirror of `Collection<T>` from `@baerly/protocol`. Cheap
 * handle; constructs no I/O. Same method names as the in-process
 * `Collection<T>`, but every terminal also accepts a trailing
 * {@link TerminalOptions} bag carrying `{ signal }`.
 *
 * By-id mutation verbs (`update`, `replace`, `delete`) live here;
 * predicate-aware bulk mutation has no HTTP route today and is
 * intentionally absent from {@link ClientQuery}.
 *
 * @template T — document shape. `_id` is always present on rows
 *               returned from the server.
 */
export interface ClientCollection<T extends DocumentData = DocumentData> {
  readonly name: string;
  /** First document in the whole collection or `undefined`. */
  first(opts?: TerminalOptions): Promise<T | undefined>;
  /** Every document in the whole collection. Pair with `.where(...).limit(n)` on large collections. */
  all(opts?: TerminalOptions): Promise<T[]>;
  /** Count every row in the collection (equivalent to `.where({}).count()`). */
  count(opts?: TerminalOptions): Promise<number>;
  /** Fetch one document by primary key. Returns `undefined` when the id is unknown. */
  get(id: string, opts?: TerminalOptions): Promise<T | undefined>;
  /**
   * Filter rows. Two shapes:
   *
   *  - **Object literal** — equality only.
   *  - **Callback DSL** — `q => q.eq(...).gt(...).in(...)` for the
   *    operator vocabulary.
   *
   * Chained calls AND-merge across shapes.
   */
  where(predicate: PredicateArg<T>): ClientQuery<T>;
  /** Order modifier; last call wins. */
  order(spec: OrderSpec<T>): ClientQuery<T>;
  /** Limit modifier; last call wins. */
  limit(n: number): ClientQuery<T>;
  /**
   * Insert a new document. Returns its `_id`.
   *
   * A non-empty string `_id` is caller-chosen and sent as-is; a second
   * insert of the same `_id` rejects with `AlreadyExists`. When `_id` is
   * omitted (or `""`, or not a string), the client mints a UUIDv7 before
   * the request is sent and flags it as minted, so the server answers a
   * retransmission of that same request with the original `{ _id }` while
   * the stored row still matches, instead of a duplicate row. The client
   * resends an insert only after a `MaintenancePending` refusal, with the
   * same body and so the same minted `_id`; calling `insert(doc)` again
   * mints a new auto-ID and is a new insert.
   * The caller's `doc` is not modified.
   */
  insert(doc: Partial<T> & DocumentData, opts?: TerminalOptions): Promise<{ readonly _id: string }>;
  /** JSON-merge-patch applied to one row by primary key. */
  update(
    id: string,
    patch: Partial<T>,
    opts?: TerminalOptions,
  ): Promise<{ readonly modified: number }>;
  /** Whole-document replace on one row by primary key. */
  replace(id: string, doc: T, opts?: TerminalOptions): Promise<void>;
  /** Delete one row by primary key. Returns `{ deleted: 0 }` on 404 (not an error). */
  delete(id: string, opts?: TerminalOptions): Promise<{ readonly deleted: number }>;
}

/**
 * Client-side mirror of `Query<T>` from `@baerly/protocol`. See
 * {@link ClientCollection} for the method-shape contract.
 *
 * Read-only over HTTP: by-id mutation lives on {@link ClientCollection}
 * directly. Predicate-aware bulk mutation is server-only — the HTTP
 * surface has no route for it.
 */
export interface ClientQuery<T extends DocumentData = DocumentData> {
  where(predicate: PredicateArg<T>): ClientQuery<T>;
  order(spec: OrderSpec<T>): ClientQuery<T>;
  limit(n: number): ClientQuery<T>;
  /** First match or `undefined`. Issues `GET /v1/c/:collection?...&limit=1`. */
  first(opts?: TerminalOptions): Promise<T | undefined>;
  /** Every matching document. Pair with `.limit(n)` on large collections. */
  all(opts?: TerminalOptions): Promise<T[]>;
  /** Count matching rows. Issues `GET /v1/count?collection=&where=`; server returns a scalar. */
  count(opts?: TerminalOptions): Promise<number>;
}

/**
 * Returned by {@link createBaerlyClient}. The typed entry point.
 *
 * `BaerlyClient` is read + single-write RPC: reads and by-id
 * mutations (`insert` / `update` / `replace` / `delete`), one
 * document per call. There is no multi-document atomic write — the
 * document is the atomic unit, and the server exposes no batch route.
 * If you need to fan a write across several documents server-side,
 * expose a business-level RPC on the server that drives
 * `db.collection(...)` in-process.
 *
 * @example
 * ```ts
 * const client = createBaerlyClient({ baseUrl: "https://api.example.com" });
 * const { _id } = await client.collection("tickets").insert({ title: "hi" });
 * const row = await client.collection("tickets").get(_id);
 * ```
 */
export interface BaerlyClient<TConfig extends BaerlyConfig = UnboundConfig> {
  /**
   * Typed collection handle. Cheap; constructs no I/O.
   *
   * When `TConfig` is bound (via `options.config`) and `name` is one
   * of the declared collection names, the row type is inferred from
   * `TConfig["collections"][name]["schema"]`. Otherwise the row type
   * defaults to `DocumentData` and the call accepts any string name —
   * matching the in-process `Db.collection` shape.
   */
  collection<N extends CollectionNames<TConfig>>(
    name: N,
  ): ClientCollection<RowOf<TConfig, N> & DocumentData>;
}

/**
 * Construct a typed HTTP client over the locked `/v1/...` routes.
 * Returns a {@link BaerlyClient} with the same surface as the
 * in-process `Db.collection(...)` API.
 *
 * @example
 * ```ts
 * const client = createBaerlyClient({
 *   baseUrl: "https://api.example.com",
 *   headers: { Authorization: "Bearer <token>" },
 * });
 * ```
 */
export const createBaerlyClient = <TConfig extends BaerlyConfig = UnboundConfig>(
  options: BaerlyClientOptions<TConfig>,
): BaerlyClient<TConfig> => {
  const ctx: RequestContext = {
    baseUrl: options.baseUrl,
    fetch: options.fetch ?? ((req) => globalThis.fetch(req)),
    headers: new Headers(options.headers ?? {}),
    onWarning: options.onWarning,
  };
  const build = (scope: RequestContext): BaerlyClient<TConfig> =>
    ({
      [CLIENT_CONTEXT]: scope,
      // A view whose every request is also cancelled by `signal`; see `withSignal`.
      [CLIENT_SCOPE]: (signal: AbortSignal) => build({ ...scope, signal }),
      collection<T extends DocumentData = DocumentData>(name: string): ClientCollection<T> {
        return makeClientCollection<T>(scope, name);
      },
    }) as unknown as BaerlyClient<TConfig>;
  return build(ctx);
};

/** Query-state carried across the chainable modifiers. */
interface QueryState {
  readonly wire: PredicateWire;
  readonly order: OrderSpec<DocumentData> | undefined;
  readonly limit: number | undefined;
}

const emptyState: QueryState = {
  wire: EMPTY_PREDICATE_WIRE,
  order: undefined,
  limit: undefined,
};

/**
 * `encodeURIComponent(value)` for one URL path segment, refusing an
 * unpaired UTF-16 surrogate as the server does: `encodeURIComponent`
 * would throw a `URIError` on one.
 */
const encodeSegment = (value: string, role: string): string => {
  if (!value.isWellFormed()) {
    throw new BaerlyError(
      "InvalidConfig",
      `${role} may not contain an unpaired UTF-16 surrogate: ${JSON.stringify(value)}`,
      {
        resolution:
          "Pass a string with no unpaired UTF-16 surrogate (value.isWellFormed() is true).",
      },
    );
  }
  return encodeURIComponent(value);
};

const makeClientCollection = <T extends DocumentData>(
  ctx: RequestContext,
  name: string,
): ClientCollection<T> => {
  const collectionForQuery = makeClientQuery<T>(ctx, name, emptyState);
  // `""`, `"."` and `".."` are never stored ids, and URL resolution would
  // collapse them onto the list route or the parent path, so they are
  // refused here; the server checks every other id rule. Non-string ids
  // must not be coerced by encodeURIComponent into another row's id.
  const idPath = (id: string): string => {
    if (typeof id !== "string") {
      throw new BaerlyError("InvalidConfig", `_id must be a string, got ${typeof id}`, {
        resolution: "Pass the _id string of a stored row.",
      });
    }
    if (id === "" || id === "." || id === "..") {
      throw new BaerlyError("InvalidConfig", `_id may not be ${JSON.stringify(id)}`, {
        resolution: 'Pass the _id string of a stored row; an _id is never empty, "." or "..".',
      });
    }
    return `/v1/c/${encodeSegment(name, "collection")}/${encodeSegment(id, "_id")}`;
  };
  return {
    name,
    where: (predicate) => collectionForQuery.where(predicate),
    order: (spec) => collectionForQuery.order(spec),
    limit: (n) => collectionForQuery.limit(n),
    first: (opts) => collectionForQuery.first(opts),
    all: (opts) => collectionForQuery.all(opts),
    count: (opts) => collectionForQuery.count(opts),
    async get(id, opts): Promise<T | undefined> {
      try {
        return await request<T>(ctx, {
          method: "GET",
          path: idPath(id),
          signal: opts?.signal,
        });
      } catch (error) {
        // 404 on GET → unknown id. Mirrors `Db.collection().get(id)` which
        // resolves `undefined` rather than throwing.
        if (error instanceof BaerlyError && error.code === "NotFound") {
          return undefined;
        }
        throw error;
      }
    },
    async insert(doc, opts): Promise<{ readonly _id: string }> {
      // Same rule as the server's `runInsert`: a present non-string `_id`
      // throws; an absent or empty one is replaced by a minted id there, so
      // it must be here too for a retransmitted request to carry a stable
      // id. The body is serialized once, so a `fetch` wrapper that resends
      // the request resends the same minted id.
      const supplied: unknown = doc["_id"];
      assertInsertIdType(supplied);
      assertDocumentValues(doc, "insert");
      const body =
        typeof supplied !== "string" || supplied.length === 0
          ? (() => {
              const minted = uuidv7();
              return { doc: { ...doc, _id: minted }, mintedId: minted };
            })()
          : { doc };
      return request<{ _id: string }>(ctx, {
        method: "POST",
        path: `/v1/c/${encodeSegment(name, "collection")}`,
        body,
        signal: opts?.signal,
        ...("mintedId" in body && { mintedInsert: true as const }),
      });
    },
    async update(id, patch, opts): Promise<{ readonly modified: number }> {
      // Checked here: `JSON.stringify` would coerce these values, so the
      // server would never see them. It drops an `undefined` member, which
      // leaves that field unchanged, so that one stays allowed.
      assertDocumentValues(patch, "update", { undefinedMembersAbsent: true });
      return request<{ modified: number }>(ctx, {
        method: "PATCH",
        path: idPath(id),
        body: { patch },
        signal: opts?.signal,
      });
    },
    async replace(id, doc, opts): Promise<void> {
      assertDocumentValues(doc, "replace");
      // PUT = whole-document overwrite. NOT PATCH — PATCH would be
      // RFC 7386 merge-patch and silently retain omitted fields from
      // the prior doc.
      await request<{ modified: number }>(ctx, {
        method: "PUT",
        path: idPath(id),
        body: { doc },
        signal: opts?.signal,
      });
    },
    async delete(id, opts): Promise<{ readonly deleted: number }> {
      try {
        await request<undefined>(ctx, {
          method: "DELETE",
          path: idPath(id),
          signal: opts?.signal,
        });
        return { deleted: 1 };
      } catch (error) {
        // 404 on DELETE → "no row matched". Mirrors `Query.delete()`
        // which returns `{ deleted: 0 }` rather than throwing.
        if (error instanceof BaerlyError && error.code === "NotFound") {
          return { deleted: 0 };
        }
        throw error;
      }
    },
  };
};

const makeClientQuery = <T extends DocumentData>(
  ctx: RequestContext,
  collectionName: string,
  state: QueryState,
): ClientQuery<T> => {
  const listParams = (): URLSearchParams => {
    const params = new URLSearchParams();
    if (state.wire.clauses.length > 0) {
      params.set("where", JSON.stringify(state.wire));
    }
    if (state.order !== undefined && Object.keys(state.order).length > 0) {
      params.set("order", JSON.stringify(state.order));
    }
    if (state.limit !== undefined) {
      params.set("limit", String(state.limit));
    }
    return params;
  };

  const listPath = (override?: { limit?: number }): string => {
    const params = listParams();
    if (override?.limit !== undefined) {
      params.set("limit", String(override.limit));
    }
    const qs = params.toString();
    return `/v1/c/${encodeSegment(collectionName, "collection")}${qs.length > 0 ? `?${qs}` : ""}`;
  };

  return {
    where: (predicate): ClientQuery<T> => {
      // Normalise the incoming arg (object or callback) to a wire and
      // concatenate clauses with any prior wire. The server's
      // `parseWhereParam` runs `validateWire` on arrival, so empty
      // `in` / conflicting `eq` / unsatisfiable interval surface as
      // a 400 `InvalidConfig` / `UnsatisfiablePredicate` from the
      // HTTP layer — no client-side merger needed. Skipping the
      // satisfiability check here keeps the SPA bundle out of the
      // wire-merger / per-field-fold code path.
      const incoming = normalizePredicateArg<T>(predicate);
      const merged: PredicateWire =
        state.wire.clauses.length === 0
          ? incoming
          : { clauses: [...state.wire.clauses, ...incoming.clauses] };
      return makeClientQuery<T>(ctx, collectionName, { ...state, wire: merged });
    },
    order: (spec): ClientQuery<T> =>
      makeClientQuery<T>(ctx, collectionName, {
        ...state,
        order: spec as OrderSpec<DocumentData>,
      }),
    limit: (n): ClientQuery<T> => makeClientQuery<T>(ctx, collectionName, { ...state, limit: n }),

    async first(opts): Promise<T | undefined> {
      // Mirrors `Db.first()` which sets `limit: 1` on its underlying
      // list call; override the query-state limit for this terminal
      // only (chained `.limit(n).first()` semantics: `first` wins).
      const data = await request<ReadonlyArray<T>>(ctx, {
        method: "GET",
        path: listPath({ limit: 1 }),
        signal: opts?.signal,
      });
      return data[0];
    },
    async all(opts): Promise<T[]> {
      const data = await request<ReadonlyArray<T>>(ctx, {
        method: "GET",
        path: listPath(),
        signal: opts?.signal,
      });
      return [...data];
    },
    async count(opts): Promise<number> {
      const params = new URLSearchParams();
      params.set("collection", collectionName);
      if (state.wire.clauses.length > 0) {
        params.set("where", JSON.stringify(state.wire));
      }
      const { count } = await request<{ count: number }>(ctx, {
        method: "GET",
        path: `/v1/count?${params.toString()}`,
        signal: opts?.signal,
      });
      return count;
    },
  };
};
