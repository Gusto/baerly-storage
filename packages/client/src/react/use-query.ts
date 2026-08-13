import { type BaerlyConfig, BaerlyError, type UnboundConfig } from "@baerly/protocol";
import { useCallback, useReducer, useRef, useSyncExternalStore } from "react";
import type { BaerlyClient } from "../client.ts";
import { useBaerlyClient } from "./provider.ts";
import { stableKey } from "./stable-key.ts";
import { type CachedSnapshot, LOADING_SNAPSHOT, poolFor } from "./subscription-pool.ts";

const SKIP: unique symbol = Symbol("baerly.useQuery.skip");

/**
 * Result handed back by {@link useQuery}. Discriminate on `status` —
 * narrowing into `"ok"` / `"refreshing"` gives `data: T`; narrowing
 * into `"loading"` / `"skipped"` gives `data: undefined`; narrowing
 * into `"error"` gives `data: T | undefined` (the prior successful
 * read survives across errors so the UI can keep rendering).
 * Every state also carries the same stable `refetch()` function, which
 * starts an explicit refresh without changing the declared dependencies.
 */
export type UseQueryResult<T> = (
  | { readonly status: "loading"; readonly data: undefined; readonly error: undefined }
  | { readonly status: "refreshing"; readonly data: T; readonly error: undefined }
  | { readonly status: "ok"; readonly data: T; readonly error: undefined }
  | { readonly status: "skipped"; readonly data: undefined; readonly error: undefined }
  | { readonly status: "error"; readonly data: T | undefined; readonly error: Error }
) & {
  /** Re-run this query without changing its declared dependencies. */
  readonly refetch: () => void;
};

/**
 * A {@link UseQueryResult} before `refetch` is attached. `withRefetch`
 * decorates one of these into the value the hook returns; keeping the
 * un-decorated shape named lets the snapshot literals below be checked
 * against the result type instead of asserted into it.
 */
type UseQuerySnapshot<T> = Omit<UseQueryResult<T>, "refetch">;

const SKIPPED_SNAPSHOT = Object.freeze({
  status: "skipped",
  data: undefined,
  error: undefined,
} satisfies UseQuerySnapshot<never>);

/** Options for a {@link useQuery} read. */
export interface UseQueryOptions {
  /**
   * Subscribe to collection changes through `/v1/since`. Defaults to
   * `true`. Set `false` for an initial/dependency-driven read that only
   * refreshes when {@link UseQueryResult.refetch} is called.
   */
  readonly live?: boolean;
}

interface RecorderState {
  readonly collectionsRead: Set<string>;
  readonly chain: Array<string>;
}

const WRITE_METHODS = new Set(["insert", "update", "replace", "delete"]);

const awaitedError = (prop: string | symbol): BaerlyError =>
  new BaerlyError(
    "UseQueryAwaitedRecorder",
    `useQuery callbacks must not dereference the result of an awaited recorder terminal — property access (${String(prop)}) on the awaited value throws. The recorder is for the synchronous prefix of the callback only. For compound reads, use Promise.all (parallel) or compose two useQuery calls with useQuery.skip (dependent). See the lint rule baerly/no-await-in-use-query for the edit-time check.`,
  );

/**
 * Sentinel handed back when a recorder terminal is awaited. Every
 * own-property access throws `BaerlyError("UseQueryAwaitedRecorder")`;
 * `Symbol.*` accesses (which the JS engine uses internally —
 * Symbol.toPrimitive, Symbol.iterator, etc.) return undefined so the
 * sentinel can flow through engine-side coercions without spurious
 * throws. The single shared instance avoids per-render allocation.
 */
const SENTINEL_SAFE_PROPS = new Set<string | symbol>([
  // The JS engine probes `.then` to test whether a value is a
  // thenable while resolving Promises. Returning undefined makes the
  // sentinel look like a non-thenable so awaiting it yields the
  // sentinel itself (not a chained Promise) — and our error fires on
  // the next, user-visible property access.
  "then",
  // `.catch` and `.finally` are sometimes probed similarly.
  "catch",
  "finally",
  // `Symbol.toStringTag` etc. are probed by `String()` and JSON
  // serialization. The generic `typeof prop === "symbol"` branch
  // already covers these; keep them here for explicit reference.
]);

const AWAITED_SENTINEL: unknown = new Proxy(
  Object.create(null) as Record<string | symbol, unknown>,
  {
    get(_target, prop) {
      if (typeof prop === "symbol" || SENTINEL_SAFE_PROPS.has(prop)) {
        return undefined;
      }
      throw awaitedError(prop);
    },
  },
);

const TERMINAL_RESULT: Promise<unknown> = Promise.resolve(AWAITED_SENTINEL);

const makeTerminal = (): Promise<unknown> => TERMINAL_RESULT;

const makeQuery = (state: RecorderState): unknown => {
  const query: Record<string, unknown> = {};
  for (const modifier of ["where", "order", "limit"]) {
    query[modifier] = (): unknown => {
      state.chain.push(modifier);
      return query;
    };
  }
  for (const terminal of ["first", "all", "count"]) {
    query[terminal] = (): unknown => {
      state.chain.push(terminal);
      return makeTerminal();
    };
  }
  return query;
};

const makeCollection = (name: string, state: RecorderState): unknown => {
  state.collectionsRead.add(name);
  state.chain.push(`collection:${name}`);
  const collection: Record<string, unknown> = {
    name,
  };
  for (const modifier of ["where", "order", "limit"]) {
    collection[modifier] = (): unknown => {
      state.chain.push(modifier);
      return makeQuery(state);
    };
  }
  for (const terminal of ["first", "all", "count", "get"]) {
    collection[terminal] = (): unknown => {
      state.chain.push(terminal);
      return makeTerminal();
    };
  }
  for (const write of WRITE_METHODS) {
    collection[write] = (): never => {
      throw new BaerlyError(
        "UnexpectedWriteInQuery",
        `useQuery callbacks must not write to the database. .${write}() was called on collection "${name}". Use useMutation() instead.`,
      );
    };
  }
  return collection;
};

const createRecorder = (): { client: unknown; state: RecorderState } => {
  const state: RecorderState = {
    collectionsRead: new Set(),
    chain: [],
  };
  const recorder = {
    collection: (name: string): unknown => makeCollection(name, state),
    healthz: (): never => {
      throw new BaerlyError(
        "UnexpectedWriteInQuery",
        "useQuery callbacks must not call client.healthz(); use useMutation() or the bare client.",
      );
    },
  };
  return { client: recorder, state };
};

interface DiscoveryOk {
  readonly kind: "ok";
  readonly collections: ReadonlyArray<string>;
  readonly chainShape: string;
  readonly callbackResult: unknown;
}
interface DiscoverySkip {
  readonly kind: "skip";
}
interface DiscoveryError {
  readonly kind: "error";
  readonly error: Error;
}
type DiscoveryResult = DiscoveryOk | DiscoverySkip | DiscoveryError;

const discover = (
  callback: (client: BaerlyClient) => Promise<unknown> | typeof SKIP,
): DiscoveryResult => {
  const { client: recorder, state } = createRecorder();
  let callbackResult: unknown;
  try {
    callbackResult = callback(recorder as BaerlyClient);
  } catch (error) {
    return {
      kind: "error",
      error: error instanceof Error ? error : new BaerlyError("Internal", String(error)),
    };
  }
  if (callbackResult === SKIP) {
    return { kind: "skip" };
  }
  return {
    kind: "ok",
    collections: [...state.collectionsRead].toSorted(),
    chainShape: stableKey(state.chain),
    callbackResult,
  };
};

/**
 * Read against a `baerly` server, live by default. The callback receives a
 * type-compatible `BaerlyClient` proxy that records which collections it
 * touches; in live mode, the hook subscribes to those collections and
 * re-runs the callback against the real client when any of them mutate.
 *
 * Re-runs also fire whenever the `deps` array changes between
 * renders (shallow `stableKey` compare). Closure variables read
 * inside the callback must be listed in `deps` — the companion
 * `baerly/exhaustive-deps-use-query` lint rule flags missing
 * entries.
 *
 * Returning {@link useQuery.skip} from the callback yields
 * `{ status: "skipped" }` and registers no subscription — use it
 * for deferred / conditional reads.
 *
 * Pass `{ live: false }` as the third argument to perform the initial
 * read and dependency-driven re-reads without opening `/v1/since`.
 * Every result state includes a stable `refetch()` function for an
 * explicit refresh; successful data remains available while that
 * refresh is running and if it fails.
 *
 * @example
 * ```tsx
 * // Single read
 * const note = useQuery((c) => c.collection("notes").get(id), [id]);
 * if (note.status === "loading") return <Spinner/>;
 * if (note.status === "error") return <Err e={note.error}/>;
 * return <pre>{note.data?.body}</pre>;  // typed Note | undefined
 *
 * // Deferred read
 * const list = useQuery(
 *   (c) => userId ? c.collection("notes").where({ authorId: userId }).all() : useQuery.skip,
 *   [userId],
 * );
 * if (list.status === "skipped") return null;
 *
 * // Non-live read with an explicit refresh
 * const report = useQuery(
 *   (c) => c.collection("notes").all(),
 *   [],
 *   { live: false },
 * );
 * <button onClick={report.refetch}>Refresh</button>;
 *
 * // Dependent read (parent → child)
 * const parent  = useQuery((c) => c.collection("notes").get(id), [id]);
 * const replies = useQuery(
 *   (c) => parent.status === "ok"
 *     ? c.collection("comments").where({ noteId: parent.data._id }).all()
 *     : useQuery.skip,
 *   [parent.status === "ok" ? parent.data._id : undefined],
 * );
 * ```
 */
const useQueryImpl = <T, TConfig extends BaerlyConfig = UnboundConfig>(
  callback: (client: BaerlyClient<TConfig>) => Promise<T> | typeof SKIP,
  deps?: ReadonlyArray<unknown>,
  options?: UseQueryOptions,
): UseQueryResult<T> => {
  const client = useBaerlyClient<TConfig>();
  const pool = poolFor(client as unknown as BaerlyClient);
  const live = options?.live !== false;

  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  // Force-update for async-error capture (see below). Used to push
  // a microtask-deferred recorder-await rejection back into a sync
  // render.
  const [, forceUpdate] = useReducer((c: number) => c + 1, 0);
  const asyncErrorRef = useRef<BaerlyError | undefined>(undefined);

  // Recorder pass. Cheap — no I/O.
  const discovery = discover(
    callbackRef.current as (client: BaerlyClient) => Promise<unknown> | typeof SKIP,
  );

  // The signature inputs that need to be stable across the same
  // logical query: chain shape + caller-declared deps.
  const depsKey = stableKey([deps ?? []]);
  const signatureBase =
    discovery.kind === "ok"
      ? stableKey([discovery.chainShape, deps ?? [], live])
      : `__non_ok__${discovery.kind}__${depsKey}__${String(live)}`;

  // Reset the captured async error if the signature changed (the
  // user is on a different query now — give them a fresh chance).
  const lastSignatureRef = useRef<string>("");
  if (lastSignatureRef.current !== signatureBase) {
    lastSignatureRef.current = signatureBase;
    asyncErrorRef.current = undefined;
  }

  // Attach an async-error handler to the callback's returned value
  // so that any microtask-deferred rejection from sentinel access
  // (sequential-await pattern) flows back into render via
  // forceUpdate. Wrap in `Promise.resolve(...)` so a bare recorder
  // terminal (Promise<sentinel>) is observed too — the resolved
  // value carries no `.catch`. Always attach (even if asyncErrorRef
  // is already set) so the per-render discovery invocation's
  // rejection is observed and doesn't surface as an unhandled
  // rejection from vitest or the host runtime.
  if (discovery.kind === "ok") {
    const result = discovery.callbackResult;
    if (
      result !== null &&
      typeof result === "object" &&
      typeof (result as { then?: unknown }).then === "function"
    ) {
      Promise.resolve(result as PromiseLike<unknown>).then(
        () => {
          /* discovery success — value discarded */
        },
        (error: unknown) => {
          if (
            error instanceof BaerlyError &&
            error.code === "UseQueryAwaitedRecorder" &&
            asyncErrorRef.current === undefined
          ) {
            asyncErrorRef.current = error;
            forceUpdate();
          }
          // Any other rejection is silently swallowed here — the
          // pool's real-client fetch path is the canonical surface
          // for non-recorder errors.
        },
      );
    }
  }

  // Subscription channel — stable per (client, collectionsRead.join(" ")).
  // Pool's getSnapshot returns the current cached entry for this
  // signature; React polls it on subscribe + on every notify.
  const collectionsJoin =
    discovery.kind === "ok" ? discovery.collections.join("\x00") : "__non_ok__";

  const fetcherRef = useRef<() => Promise<unknown>>(() => Promise.resolve(undefined));
  fetcherRef.current = (): Promise<unknown> => {
    const out = callbackRef.current(client) as Promise<unknown> | typeof SKIP;
    if (out === SKIP) {
      return Promise.resolve(undefined);
    }
    return out as Promise<unknown>;
  };

  const chainCollectionsRef = useRef<ReadonlySet<string>>(new Set());
  const discoveryKindRef = useRef<DiscoveryResult["kind"]>("ok");
  const discoveryErrorRef = useRef<Error | undefined>(undefined);
  discoveryKindRef.current = discovery.kind;
  if (discovery.kind === "ok") {
    chainCollectionsRef.current = live ? new Set(discovery.collections) : new Set();
    discoveryErrorRef.current = undefined;
  } else if (discovery.kind === "error") {
    discoveryErrorRef.current = discovery.error;
  } else {
    discoveryErrorRef.current = undefined;
  }

  const subscribe = useCallback(
    (notify: () => void): (() => void) => {
      if (discovery.kind !== "ok") {
        return () => {};
      }
      return pool.attach(
        signatureBase,
        live ? discovery.collections : [],
        chainCollectionsRef.current,
        () => fetcherRef.current(),
        notify,
      );
    },
    // The signature/collections determine the subscription; React
    // re-subscribes when either changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pool, signatureBase, collectionsJoin],
  );

  const refetchTargetRef = useRef({
    kind: discovery.kind,
    pool,
    signature: signatureBase,
  });
  refetchTargetRef.current = { kind: discovery.kind, pool, signature: signatureBase };
  const refetch = useCallback((): void => {
    const target = refetchTargetRef.current;
    if (target.kind === "ok") {
      target.pool.refetch(target.signature);
    } else {
      forceUpdate();
    }
  }, []);

  // Stable per-error snapshot cache so repeated getSnapshot polls
  // within a single render return the same reference. React's
  // useSyncExternalStore detects identity changes; constructing a
  // fresh error literal each call drives an infinite re-render.
  const errorSnapshotRef = useRef<
    | {
        error: Error;
        snapshot: { status: "error"; data: undefined; error: Error };
      }
    | undefined
  >(undefined);
  const snapshotForError = (err: Error): UseQuerySnapshot<T> => {
    if (errorSnapshotRef.current?.error === err) {
      return errorSnapshotRef.current.snapshot;
    }
    const snapshot = {
      status: "error" as const,
      data: undefined,
      error: err,
    } satisfies UseQuerySnapshot<T>;
    errorSnapshotRef.current = { error: err, snapshot };
    return snapshot;
  };

  const decoratedSnapshotRef = useRef<
    | {
        base: object;
        snapshot: UseQueryResult<unknown>;
      }
    | undefined
  >(undefined);
  const withRefetch = (base: UseQuerySnapshot<T> | CachedSnapshot): UseQueryResult<T> => {
    if (decoratedSnapshotRef.current?.base === base) {
      return decoratedSnapshotRef.current.snapshot as UseQueryResult<T>;
    }
    const snapshot = { ...base, refetch } as UseQueryResult<unknown>;
    decoratedSnapshotRef.current = { base, snapshot };
    return snapshot as UseQueryResult<T>;
  };

  const getSnapshot = useCallback((): UseQueryResult<T> => {
    if (asyncErrorRef.current) {
      return withRefetch(snapshotForError(asyncErrorRef.current));
    }
    if (discoveryKindRef.current === "skip") {
      return withRefetch(SKIPPED_SNAPSHOT);
    }
    if (discoveryKindRef.current === "error") {
      return withRefetch(
        snapshotForError(
          discoveryErrorRef.current ?? new BaerlyError("Internal", "unknown discovery error"),
        ),
      );
    }
    return withRefetch(pool.getSnapshot(signatureBase));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, signatureBase]);

  // discoveryKindRef + discoveryErrorRef carry the latest discovery
  // state into getSnapshot without making it a useCallback dep
  // (avoids re-creating the snapshot callback every render).
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

/**
 * Read hook, live by default. See {@link useQueryImpl} JSDoc for usage.
 * The `.skip` property is the sentinel that short-circuits the hook
 * into `status: "skipped"`; `{ live: false }` disables `/v1/since`
 * while retaining initial reads, dependency re-runs, and `refetch()`.
 */
export const useQuery: {
  <T, TConfig extends BaerlyConfig = UnboundConfig>(
    callback: (client: BaerlyClient<TConfig>) => Promise<T> | typeof SKIP,
    deps?: ReadonlyArray<unknown>,
    options?: UseQueryOptions,
  ): UseQueryResult<T>;
  readonly skip: typeof SKIP;
} = Object.assign(useQueryImpl, { skip: SKIP }) as {
  <T, TConfig extends BaerlyConfig = UnboundConfig>(
    callback: (client: BaerlyClient<TConfig>) => Promise<T> | typeof SKIP,
    deps?: ReadonlyArray<unknown>,
    options?: UseQueryOptions,
  ): UseQueryResult<T>;
  readonly skip: typeof SKIP;
};

// Quiet `LOADING_SNAPSHOT` as a value-import — referenced by
// generated type for the `loading` branch only; bundled alongside
// `subscription-pool.ts`.
void LOADING_SNAPSHOT;
