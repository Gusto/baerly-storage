/* eslint-disable no-underscore-dangle -- `_id` and `_meta` are the
   locked wire-shape field names (see `packages/protocol/src/collection-api.ts`
   and `packages/server/src/contract.ts`); we mirror them verbatim
   so the typed client stays structurally compatible. */

import {
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
} from "@baerly/protocol";
import { CLIENT_CONTEXT } from "./internal/context.ts";
import { type Fetcher, type RequestContext, request } from "./request.ts";

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
  /** Insert a new document. Returns the server-assigned `_id`. */
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
  };
  const client = {
    [CLIENT_CONTEXT]: ctx,
    collection<T extends DocumentData = DocumentData>(name: string): ClientCollection<T> {
      return makeClientCollection<T>(ctx, name);
    },
  };
  return client as BaerlyClient<TConfig>;
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

const makeClientCollection = <T extends DocumentData>(
  ctx: RequestContext,
  name: string,
): ClientCollection<T> => {
  const collectionForQuery = makeClientQuery<T>(ctx, name, emptyState);
  const idPath = (id: string): string =>
    `/v1/c/${encodeURIComponent(name)}/${encodeURIComponent(id)}`;
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
      return request<{ _id: string }>(ctx, {
        method: "POST",
        path: `/v1/c/${encodeURIComponent(name)}`,
        body: { doc },
        signal: opts?.signal,
      });
    },
    async update(id, patch, opts): Promise<{ readonly modified: number }> {
      return request<{ modified: number }>(ctx, {
        method: "PATCH",
        path: idPath(id),
        body: { patch },
        signal: opts?.signal,
      });
    },
    async replace(id, doc, opts): Promise<void> {
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
    return `/v1/c/${encodeURIComponent(collectionName)}${qs.length > 0 ? `?${qs}` : ""}`;
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
