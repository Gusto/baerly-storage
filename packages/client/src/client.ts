/* eslint-disable no-underscore-dangle -- `_id` and `_meta` are the
   locked wire-shape field names (see `packages/protocol/src/db.ts`
   and `packages/server/src/contract.ts`); we mirror them verbatim
   so the typed client stays structurally compatible. */

import type { ConsistencyLevel, JSONArraylessObject, OrderSpec, Predicate } from "@baerly/protocol";
import type { SinceResponse } from "./contract";
import { BaerlyClientError } from "./errors";
import { type Fetcher, type RequestContext, request } from "./request";

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
export interface BaerlyClientOptions {
  /**
   * Required. The deployed `baerly` server URL — e.g.
   * `https://acme.example.com`. No trailing slash.
   */
  readonly baseUrl: string;
  /**
   * Optional. Defaults to `globalThis.fetch`. Override for tests
   * (see `@baerly/client/testing`) or to splice in a custom
   * retry / tracing wrapper.
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
   * Optional. AbortSignal merged into every request. Cancels in-
   * flight requests when fired. The per-call `signal` option, if
   * passed, takes precedence.
   */
  readonly signal?: AbortSignal;
}

/**
 * Client-side mirror of `Table<T>` from `@baerly/protocol`. Cheap
 * handle; constructs no I/O. Identical method signatures to the
 * in-process `Table<T>` except for the package they live in — see
 * §3.3 of the ticket for why we do not re-export the protocol type.
 *
 * @template T — document shape. `_id` is always present on rows
 *               returned from the server.
 */
export interface ClientTable<T extends JSONArraylessObject = JSONArraylessObject> {
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
  insert(doc: Partial<T> & JSONArraylessObject): Promise<{ readonly _id: string }>;
  /** Count every row in the table (equivalent to `.where({}).count()`). */
  count(): Promise<number>;
}

/**
 * Client-side mirror of `Query<T>` from `@baerly/protocol`. See
 * {@link ClientTable} for the method-shape contract.
 *
 * Day-one HTTP constraint: `update` / `replace` / `delete` require
 * `.where({ _id: "<id>" })` (single-row by id). Any other predicate
 * shape throws `BaerlyClientError{code:"SchemaError"}`. The
 * constraint lifts when the server grows a multi-row PATCH route.
 */
export interface ClientQuery<T extends JSONArraylessObject = JSONArraylessObject> {
  where(predicate: Predicate<T>): ClientQuery<T>;
  order(spec: OrderSpec<T>): ClientQuery<T>;
  limit(n: number): ClientQuery<T>;
  consistency(level: ConsistencyLevel): ClientQuery<T>;
  /** First match or `undefined`. Issues `GET /v1/t/:table?...&limit=1`. */
  first(): Promise<T | undefined>;
  /** Every matching document. Pair with `.limit(n)` on large tables. */
  all(): Promise<T[]>;
  /** Count matching rows. Issues `GET /v1/t/:table?where=&limit=` then `.length` (Phase-8 simplification). */
  count(): Promise<number>;
  /** JSON-merge-patch applied to the single matching row. Requires `.where({ _id })`. */
  update(patch: Partial<T>): Promise<{ readonly modified: number }>;
  /** Whole-document replace on the single matching row. Requires `.where({ _id })`. */
  replace(doc: T): Promise<void>;
  /** Delete the single matching row. Returns `{ deleted: 0 }` on 404 (not an error). */
  delete(): Promise<{ readonly deleted: number }>;
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
export interface BaerlyClient {
  /** Typed table handle. Cheap; constructs no I/O. */
  table<T extends JSONArraylessObject = JSONArraylessObject>(name: string): ClientTable<T>;
  /**
   * Long-poll for new log events. Returns once events arrive or the
   * server-side budget (25 s default) elapses; in the latter case
   * the response is `{ events: [], next_cursor: <same> }`.
   *
   * @throws BaerlyClientError code="SchemaError" — cursor shape
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
export const createBaerlyClient = (options: BaerlyClientOptions): BaerlyClient => {
  const ctx: RequestContext = {
    baseUrl: options.baseUrl,
    fetch: options.fetch ?? ((req) => globalThis.fetch(req)),
    headers: () => resolveHeaders(options.headers),
    signal: options.signal,
  };
  return {
    table<T extends JSONArraylessObject = JSONArraylessObject>(name: string): ClientTable<T> {
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
      } catch {
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
  if (source === undefined) return new Headers();
  const value = typeof source === "function" ? await source() : source;
  return new Headers(value);
};

/** Query-state carried across the chainable modifiers. */
interface QueryState {
  readonly predicate: Predicate<JSONArraylessObject>;
  readonly order: OrderSpec<JSONArraylessObject> | undefined;
  readonly limit: number | undefined;
  readonly consistency: ConsistencyLevel | undefined;
}

const emptyState: QueryState = {
  predicate: {},
  order: undefined,
  limit: undefined,
  consistency: undefined,
};

const makeClientTable = <T extends JSONArraylessObject>(
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
    async insert(doc): Promise<{ readonly _id: string }> {
      return request<{ _id: string }>(ctx, {
        method: "POST",
        path: `/v1/t/${encodeURIComponent(name)}`,
        body: { doc },
      });
    },
    async count(): Promise<number> {
      return tableForQuery.count();
    },
  };
};

const makeClientQuery = <T extends JSONArraylessObject>(
  ctx: RequestContext,
  tableName: string,
  state: QueryState,
): ClientQuery<T> => {
  const listParams = (): URLSearchParams => {
    const params = new URLSearchParams();
    if (Object.keys(state.predicate).length > 0) {
      params.set("where", JSON.stringify(state.predicate));
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
    if (override?.limit !== undefined) params.set("limit", String(override.limit));
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
          ...(predicate as Predicate<JSONArraylessObject>),
        },
      }),
    order: (spec): ClientQuery<T> =>
      makeClientQuery<T>(ctx, tableName, {
        ...state,
        order: spec as OrderSpec<JSONArraylessObject>,
      }),
    limit: (n): ClientQuery<T> => makeClientQuery<T>(ctx, tableName, { ...state, limit: n }),
    consistency: (level): ClientQuery<T> =>
      makeClientQuery<T>(ctx, tableName, { ...state, consistency: level }),

    async first(): Promise<T | undefined> {
      // Mirrors `Db.first()` which sets `limit: 1` on its underlying
      // list call; override the query-state limit for this terminal
      // only (chained `.limit(n).first()` semantics: `first` wins).
      const data = await request<ReadonlyArray<T>>(ctx, {
        method: "GET",
        path: listPath({ limit: 1 }),
      });
      return data[0];
    },
    async all(): Promise<T[]> {
      const data = await request<ReadonlyArray<T>>(ctx, {
        method: "GET",
        path: listPath(),
      });
      return [...data];
    },
    async count(): Promise<number> {
      // Phase-8 simplification: no dedicated `/v1/count` route exists
      // (router.ts:130 lists only the six locked routes). We issue
      // the list and take `.length`. When/if a count route lands,
      // swap to it here without changing the public signature.
      const data = await request<ReadonlyArray<T>>(ctx, {
        method: "GET",
        path: listPath(),
      });
      return data.length;
    },

    async update(patch): Promise<{ readonly modified: number }> {
      const id = singleIdFromPredicate(state.predicate);
      if (id === undefined) {
        throw new BaerlyClientError(
          "SchemaError",
          "update() requires .where({ _id: ... }) — multi-row update is not yet exposed over HTTP",
        );
      }
      const data = await request<{ modified: number }>(ctx, {
        method: "PATCH",
        path: `/v1/t/${encodeURIComponent(tableName)}/${encodeURIComponent(id)}`,
        body: { patch },
      });
      return data;
    },

    async replace(doc): Promise<void> {
      const id = singleIdFromPredicate(state.predicate);
      if (id === undefined) {
        throw new BaerlyClientError(
          "SchemaError",
          "replace() requires .where({ _id: ... }) — see ClientQuery docstring",
        );
      }
      // PATCH with a full document body behaves as a replace under
      // RFC 7386 merge-patch (every field present overwrites). The
      // server's `Query.replace` cardinality precondition cannot be
      // mirrored client-side; surface a missing-row 404 as a thrown
      // BaerlyClientError per the request-layer policy.
      await request<{ modified: number }>(ctx, {
        method: "PATCH",
        path: `/v1/t/${encodeURIComponent(tableName)}/${encodeURIComponent(id)}`,
        body: { patch: doc },
      });
    },

    async delete(): Promise<{ readonly deleted: number }> {
      const id = singleIdFromPredicate(state.predicate);
      if (id === undefined) {
        throw new BaerlyClientError(
          "SchemaError",
          "delete() requires .where({ _id: ... }) — multi-row delete is not yet exposed over HTTP",
        );
      }
      try {
        await request<undefined>(ctx, {
          method: "DELETE",
          path: `/v1/t/${encodeURIComponent(tableName)}/${encodeURIComponent(id)}`,
        });
        return { deleted: 1 };
      } catch (e) {
        // 404 on DELETE → "no row matched". Mirrors `Query.delete()`
        // which returns `{ deleted: 0 }` rather than throwing.
        if (e instanceof BaerlyClientError && e.code === "Internal" && e.status === 404) {
          return { deleted: 0 };
        }
        throw e;
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
const singleIdFromPredicate = (p: Predicate<JSONArraylessObject>): string | undefined => {
  const keys = Object.keys(p);
  if (keys.length !== 1 || keys[0] !== "_id") return undefined;
  const v = (p as Record<string, unknown>)._id;
  return typeof v === "string" ? v : undefined;
};
