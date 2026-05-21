/* eslint-disable no-underscore-dangle -- `_id` and `_meta` are the
   locked wire-shape field names (see `packages/protocol/src/table-api.ts`
   and `packages/server/src/contract.ts`); we mirror them verbatim
   so the typed client stays structurally compatible. */

import {
  BaerlyError,
  type ConsistencyLevel,
  type DocumentData,
  type OrderSpec,
  type Predicate,
} from "@baerly/protocol";
import type { BaerlyConfig, CollectionNames, RowOf, UnboundConfig } from "@baerly/server";
import type { SinceResponse } from "./contract.ts";
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
   * See `docs/guide/client-middleware.md` for `onSuccess` / `onError`
   * helpers and a composition pattern.
   */
  readonly fetch?: Fetcher;
  /**
   * Optional. Forwarded on every request. Typically
   * `{ Authorization: "Bearer <token>" }`. Pass a function to
   * resolve the header per-call (e.g. fresh JWT from an IdP).
   */
  readonly headers?:
    | Headers
    | Record<string, string>
    | (() => Promise<Headers | Record<string, string>> | Headers | Record<string, string>);
  /**
   * Optional. Lifecycle signal: aborts every in-flight and future
   * request issued by this client when fired. Per-call `signal`
   * options on individual terminals are *merged* with this one —
   * either firing aborts the underlying `fetch`.
   *
   * Canonical use is a React provider that owns the client and wants
   * to cancel everything on unmount:
   *
   * ```ts
   * const ac = new AbortController();
   * const client = createBaerlyClient({ baseUrl, lifecycleSignal: ac.signal });
   * // …on unmount: ac.abort();
   * ```
   *
   * For "cancel *this* request" use the per-call `{ signal }` option
   * on the terminal instead (see {@link TerminalOptions}).
   */
  readonly lifecycleSignal?: AbortSignal;
  /**
   * Optional. **Type-only** — the runtime client does not read this
   * field; it exists so `client.table(name)` can narrow `name` to
   * declared collection names and infer the row type from
   * `collections[name].schema`. Bind the type via the generic
   * parameter using `import type` so the server-side storage
   * adapter and secrets in `baerly.config.ts` do not enter the
   * browser bundle:
   *
   * ```ts
   * import type config from "./baerly.config.ts";
   * const client = createBaerlyClient<typeof config>({ baseUrl });
   * await client.table("tickets").first(); // Promise<Ticket | undefined>
   * ```
   *
   * Skip the type parameter to fall back to the per-call generic
   * `client.table<Ticket>("tickets")` form.
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
   * Cancels this specific request. Merged with
   * {@link BaerlyClientOptions.lifecycleSignal} — either firing
   * aborts the underlying `fetch`. React effect cleanup is the
   * canonical caller:
   *
   * ```ts
   * useEffect(() => {
   *   const ac = new AbortController();
   *   client.table("tickets").where(p).all({ signal: ac.signal }).then(setRows);
   *   return () => ac.abort();
   * }, [predicateKey]);
   * ```
   */
  readonly signal?: AbortSignal;
}

/**
 * Client-side mirror of `Table<T>` from `@baerly/protocol`. Cheap
 * handle; constructs no I/O. Same method names as the in-process
 * `Table<T>`, but every terminal also accepts a trailing
 * {@link TerminalOptions} bag carrying `{ signal }`.
 *
 * @template T — document shape. `_id` is always present on rows
 *               returned from the server.
 */
export interface ClientTable<T extends DocumentData = DocumentData> {
  readonly name: string;
  /** Equality predicate over top-level or dotted-path keys. AND-merge on repeat. */
  where(predicate: Predicate<T>): ClientQuery<T>;
  /** Order modifier; last call wins. */
  order(spec: OrderSpec<T>): ClientQuery<T>;
  /** Limit modifier; last call wins. */
  limit(n: number): ClientQuery<T>;
  /** Read consistency for terminals on the returned query. Default `strong`. */
  consistency(level: ConsistencyLevel): ClientQuery<T>;
  /** Insert a new document. Returns the server-assigned `_id`. */
  insert(doc: Partial<T> & DocumentData, opts?: TerminalOptions): Promise<{ readonly _id: string }>;
  /** Count every row in the table (equivalent to `.where({}).count()`). */
  count(opts?: TerminalOptions): Promise<number>;
}

/**
 * Client-side mirror of `Query<T>` from `@baerly/protocol`. See
 * {@link ClientTable} for the method-shape contract.
 *
 * Day-one HTTP constraint: `update` / `replace` / `delete` require
 * `.where({ _id: "<id>" })` (single-row by id). Any other predicate
 * shape throws `BaerlyError{code:"SchemaError"}`. The
 * constraint lifts when the server grows a multi-row PATCH route.
 */
export interface ClientQuery<T extends DocumentData = DocumentData> {
  where(predicate: Predicate<T>): ClientQuery<T>;
  order(spec: OrderSpec<T>): ClientQuery<T>;
  limit(n: number): ClientQuery<T>;
  consistency(level: ConsistencyLevel): ClientQuery<T>;
  /** First match or `undefined`. Issues `GET /v1/t/:table?...&limit=1`. */
  first(opts?: TerminalOptions): Promise<T | undefined>;
  /** Every matching document. Pair with `.limit(n)` on large tables. */
  all(opts?: TerminalOptions): Promise<T[]>;
  /** Count matching rows. Issues `GET /v1/count?table=&where=`; server returns a scalar. */
  count(opts?: TerminalOptions): Promise<number>;
  /** JSON-merge-patch applied to the single matching row. Requires `.where({ _id })`. */
  update(patch: Partial<T>, opts?: TerminalOptions): Promise<{ readonly modified: number }>;
  /** Whole-document replace on the single matching row. Requires `.where({ _id })`. */
  replace(doc: T, opts?: TerminalOptions): Promise<void>;
  /** Delete the single matching row. Returns `{ deleted: 0 }` on 404 (not an error). */
  delete(opts?: TerminalOptions): Promise<{ readonly deleted: number }>;
}

/**
 * Returned by {@link createBaerlyClient}. The typed entry point.
 *
 * `BaerlyClient` does NOT expose a `transaction(...)` method:
 * the server has no HTTP route for atomic batch commit today (see
 * `packages/server/src/http/router.ts`). Issuing N HTTP requests
 * from the client would silently break the single-CAS invariant.
 * If you need atomic multi-row mutation today, expose a business-
 * level RPC on the server that calls `db.transaction(...)` in-
 * process.
 *
 * @example
 * ```ts
 * const client = createBaerlyClient({ baseUrl: "https://api.example.com" });
 * const { _id } = await client.table("tickets").insert({ title: "hi" });
 * const row = await client.table("tickets").where({ _id }).first();
 * ```
 */
export interface BaerlyClient<TConfig extends BaerlyConfig = UnboundConfig> {
  /**
   * Typed table handle. Cheap; constructs no I/O.
   *
   * When `TConfig` is bound (via `options.config`) and `name` is one
   * of the declared collection names, the row type is inferred from
   * `TConfig["collections"][name]["schema"]`. Otherwise the legacy
   * per-call `<T>` form applies.
   *
   * A name that is not declared on `TConfig` — or a declared collection
   * with no `schema` — falls through to the legacy overload and yields
   * `ClientTable<DocumentData>` rather than a type error. This
   * matches the in-process `Db.table` shape and preserves the
   * untyped-call DX; pair with a per-call `<T>` when you want a
   * narrower row type.
   */
  table<N extends CollectionNames<TConfig>>(name: N): ClientTable<RowOf<TConfig, N> & DocumentData>;
  table<T extends DocumentData = DocumentData>(name: string): ClientTable<T>;
  /**
   * Long-poll for new log events. Returns once events arrive or the
   * server-side budget (25 s default) elapses; in the latter case
   * the response is `{ events: [], next_cursor: <same> }`.
   *
   * @throws BaerlyError code="SchemaError" — cursor shape
   *   invalid or cursor references a GC'd log entry.
   */
  since(opts: { table: string; cursor?: string; signal?: AbortSignal }): Promise<SinceResponse>;
  /** Liveness probe. Returns `true` on 200, `false` on any other status. Does not throw. */
  healthz(opts?: { signal?: AbortSignal }): Promise<boolean>;
}

/**
 * Construct a typed HTTP client over the locked `/v1/...` routes.
 * Returns a {@link BaerlyClient} with the same surface as the
 * in-process `Db.table(...)` API.
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
    headers: () => resolveHeaders(options.headers),
    lifecycleSignal: options.lifecycleSignal,
  };
  return {
    table<T extends DocumentData = DocumentData>(name: string): ClientTable<T> {
      return makeClientTable<T>(ctx, name);
    },
    async since(opts): Promise<SinceResponse> {
      const params = new URLSearchParams();
      params.set("table", opts.table);
      params.set("cursor", opts.cursor ?? "");
      return request<SinceResponse>(ctx, {
        method: "GET",
        path: `/v1/since?${params.toString()}`,
        signal: opts.signal,
      });
    },
    async healthz(opts): Promise<boolean> {
      try {
        await request<{ ok: true }>(ctx, {
          method: "GET",
          path: "/v1/healthz",
          signal: opts?.signal,
        });
        return true;
      } catch (error) {
        // Re-throw caller-driven aborts so a polling health check
        // that cancels on unmount doesn't see `false` and flag the
        // server as down. Everything else (network error, non-200,
        // shape mismatch) maps to "server unhealthy".
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }
        return false;
      }
    },
  };
};

/**
 * Per-call header resolution. Supports `Headers`, plain record,
 * and an (a)sync callback so consumers can refresh JWTs on every
 * request. Always returns a fresh mutable `Headers` instance the
 * request layer can extend with `content-type`.
 */
const resolveHeaders = async (source: BaerlyClientOptions["headers"]): Promise<Headers> => {
  if (source === undefined) {
    return new Headers();
  }
  const value = typeof source === "function" ? await source() : source;
  return new Headers(value);
};

/** Query-state carried across the chainable modifiers. */
interface QueryState {
  readonly predicate: Predicate<DocumentData>;
  readonly order: OrderSpec<DocumentData> | undefined;
  readonly limit: number | undefined;
  readonly consistency: ConsistencyLevel | undefined;
}

const emptyState: QueryState = {
  predicate: {},
  order: undefined,
  limit: undefined,
  consistency: undefined,
};

const makeClientTable = <T extends DocumentData>(
  ctx: RequestContext,
  name: string,
): ClientTable<T> => {
  const tableForQuery = makeClientQuery<T>(ctx, name, emptyState);
  return {
    name,
    where: (predicate) => tableForQuery.where(predicate),
    order: (spec) => tableForQuery.order(spec),
    limit: (n) => tableForQuery.limit(n),
    consistency: (level) => tableForQuery.consistency(level),
    async insert(doc, opts): Promise<{ readonly _id: string }> {
      return request<{ _id: string }>(ctx, {
        method: "POST",
        path: `/v1/t/${encodeURIComponent(name)}`,
        body: { doc },
        signal: opts?.signal,
      });
    },
    async count(opts): Promise<number> {
      return tableForQuery.count(opts);
    },
  };
};

const makeClientQuery = <T extends DocumentData>(
  ctx: RequestContext,
  tableName: string,
  state: QueryState,
): ClientQuery<T> => {
  const listParams = (): URLSearchParams => {
    const params = new URLSearchParams();
    if (Object.keys(state.predicate).length > 0) {
      params.set("where", JSON.stringify(state.predicate));
    }
    if (state.order !== undefined && Object.keys(state.order).length > 0) {
      params.set("order", JSON.stringify(state.order));
    }
    if (state.limit !== undefined) {
      params.set("limit", String(state.limit));
    }
    if (state.consistency !== undefined) {
      params.set("consistency", state.consistency);
    }
    return params;
  };

  const listPath = (override?: { limit?: number }): string => {
    const params = listParams();
    if (override?.limit !== undefined) {
      params.set("limit", String(override.limit));
    }
    const qs = params.toString();
    return `/v1/t/${encodeURIComponent(tableName)}${qs.length > 0 ? `?${qs}` : ""}`;
  };

  return {
    where: (predicate): ClientQuery<T> =>
      makeClientQuery<T>(ctx, tableName, {
        ...state,
        // AND-merge with prior predicates, matching `Table<T>.where`
        // composition semantics (later keys win on collision —
        // mirrors `Query.where` in `Db`).
        predicate: {
          ...state.predicate,
          ...(predicate as Predicate<DocumentData>),
        },
      }),
    order: (spec): ClientQuery<T> =>
      makeClientQuery<T>(ctx, tableName, {
        ...state,
        order: spec as OrderSpec<DocumentData>,
      }),
    limit: (n): ClientQuery<T> => makeClientQuery<T>(ctx, tableName, { ...state, limit: n }),
    consistency: (level): ClientQuery<T> =>
      makeClientQuery<T>(ctx, tableName, { ...state, consistency: level }),

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
      params.set("table", tableName);
      if (Object.keys(state.predicate).length > 0) {
        params.set("where", JSON.stringify(state.predicate));
      }
      if (state.consistency !== undefined) {
        params.set("consistency", state.consistency);
      }
      const { count } = await request<{ count: number }>(ctx, {
        method: "GET",
        path: `/v1/count?${params.toString()}`,
        signal: opts?.signal,
      });
      return count;
    },

    async update(patch, opts): Promise<{ readonly modified: number }> {
      const id = singleIdFromPredicate(state.predicate);
      if (id === undefined) {
        throw new BaerlyError(
          "SchemaError",
          "update() requires .where({ _id: ... }) — multi-row update is not yet exposed over HTTP",
        );
      }
      const data = await request<{ modified: number }>(ctx, {
        method: "PATCH",
        path: `/v1/t/${encodeURIComponent(tableName)}/${encodeURIComponent(id)}`,
        body: { patch },
        signal: opts?.signal,
      });
      return data;
    },

    async replace(doc, opts): Promise<void> {
      const id = singleIdFromPredicate(state.predicate);
      if (id === undefined) {
        throw new BaerlyError(
          "SchemaError",
          "replace() requires .where({ _id: ... }) — see ClientQuery docstring",
        );
      }
      // PUT carries whole-document overwrite semantics and maps to the
      // server's `Query.replace` (single-row strict cardinality:
      // missing row → 404 here, multi-match → Conflict). NOT PATCH —
      // PATCH would be RFC 7386 merge-patch and silently retain
      // omitted fields from the prior doc.
      await request<{ modified: number }>(ctx, {
        method: "PUT",
        path: `/v1/t/${encodeURIComponent(tableName)}/${encodeURIComponent(id)}`,
        body: { doc },
        signal: opts?.signal,
      });
    },

    async delete(opts): Promise<{ readonly deleted: number }> {
      const id = singleIdFromPredicate(state.predicate);
      if (id === undefined) {
        throw new BaerlyError(
          "SchemaError",
          "delete() requires .where({ _id: ... }) — multi-row delete is not yet exposed over HTTP",
        );
      }
      try {
        await request<undefined>(ctx, {
          method: "DELETE",
          path: `/v1/t/${encodeURIComponent(tableName)}/${encodeURIComponent(id)}`,
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

/**
 * Predicate-shape probe. Returns the bare id when the predicate is
 * exactly `{ _id: "<string>" }`; `undefined` otherwise. Used by the
 * update / replace / delete terminals to enforce the day-one
 * "single row by id" HTTP constraint.
 */
const singleIdFromPredicate = (p: Predicate<DocumentData>): string | undefined => {
  const keys = Object.keys(p);
  if (keys.length !== 1 || keys[0] !== "_id") {
    return undefined;
  }
  const v = (p as Record<string, unknown>)["_id"];
  return typeof v === "string" ? v : undefined;
};
