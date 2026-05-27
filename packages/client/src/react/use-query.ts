import { type BaerlyConfig, BaerlyError, type UnboundConfig } from "@baerly/protocol";
import { useCallback, useReducer, useRef, useSyncExternalStore } from "react";
import type { BaerlyClient } from "../client.ts";
import { useBaerlyClient } from "./provider.ts";
import { stableKey } from "./stable-key.ts";
import { LOADING_SNAPSHOT, poolFor } from "./subscription-pool.ts";

const SKIP: unique symbol = Symbol("baerly.useQuery.skip");

/**
 * Result handed back by {@link useQuery}. Discriminate on `status` —
 * narrowing into `"ok"` / `"refreshing"` gives `data: T`; narrowing
 * into `"loading"` / `"skipped"` gives `data: undefined`; narrowing
 * into `"error"` gives `data: T | undefined` (the prior successful
 * read survives across errors so the UI can keep rendering).
 */
export type UseQueryResult<T> =
  | { readonly status: "loading"; readonly data: undefined; readonly error: undefined }
  | { readonly status: "refreshing"; readonly data: T; readonly error: undefined }
  | { readonly status: "ok"; readonly data: T; readonly error: undefined }
  | { readonly status: "skipped"; readonly data: undefined; readonly error: undefined }
  | { readonly status: "error"; readonly data: T | undefined; readonly error: Error };

const SKIPPED_SNAPSHOT: UseQueryResult<never> = Object.freeze({
  status: "skipped",
  data: undefined,
  error: undefined,
});

interface RecorderState {
  readonly tablesRead: Set<string>;
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

const makeTable = (name: string, state: RecorderState): unknown => {
  state.tablesRead.add(name);
  state.chain.push(`table:${name}`);
  const table: Record<string, unknown> = {
    name,
  };
  for (const modifier of ["where", "order", "limit"]) {
    table[modifier] = (): unknown => {
      state.chain.push(modifier);
      return makeQuery(state);
    };
  }
  for (const terminal of ["first", "all", "count", "get"]) {
    table[terminal] = (): unknown => {
      state.chain.push(terminal);
      return makeTerminal();
    };
  }
  for (const write of WRITE_METHODS) {
    table[write] = (): never => {
      throw new BaerlyError(
        "UnexpectedWriteInQuery",
        `useQuery callbacks must not write to the database. .${write}() was called on table "${name}". Use useMutation() instead.`,
      );
    };
  }
  return table;
};

const createRecorder = (): { client: unknown; state: RecorderState } => {
  const state: RecorderState = {
    tablesRead: new Set(),
    chain: [],
  };
  const recorder = {
    table: (name: string): unknown => makeTable(name, state),
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
  readonly tables: ReadonlyArray<string>;
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
    tables: [...state.tablesRead].toSorted(),
    chainShape: stableKey(state.chain),
    callbackResult,
  };
};

/**
 * Reactive read against a `baerly` server. The callback receives a
 * type-compatible `BaerlyClient` proxy that records which tables it
 * touches; the hook subscribes to those tables and re-runs the
 * callback against the real client when any of them mutate.
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
 * @example
 * ```tsx
 * // Single read
 * const note = useQuery((c) => c.table("notes").get(id), [id]);
 * if (note.status === "loading") return <Spinner/>;
 * if (note.status === "error") return <Err e={note.error}/>;
 * return <pre>{note.data?.body}</pre>;  // typed Note | undefined
 *
 * // Deferred read
 * const list = useQuery(
 *   (c) => userId ? c.table("notes").where({ authorId: userId }).all() : useQuery.skip,
 *   [userId],
 * );
 * if (list.status === "skipped") return null;
 *
 * // Dependent read (parent → child)
 * const parent  = useQuery((c) => c.table("notes").get(id), [id]);
 * const replies = useQuery(
 *   (c) => parent.status === "ok"
 *     ? c.table("comments").where({ noteId: parent.data._id }).all()
 *     : useQuery.skip,
 *   [parent.status === "ok" ? parent.data._id : undefined],
 * );
 * ```
 */
const useQueryImpl = <T, TConfig extends BaerlyConfig = UnboundConfig>(
  callback: (client: BaerlyClient<TConfig>) => Promise<T> | typeof SKIP,
  deps?: ReadonlyArray<unknown>,
): UseQueryResult<T> => {
  const client = useBaerlyClient<TConfig>();
  const pool = poolFor(client as unknown as BaerlyClient);

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
      ? stableKey([discovery.chainShape, deps ?? []])
      : `__non_ok__${discovery.kind}__${depsKey}`;

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

  // Subscription channel — stable per (client, tablesRead.join(" ")).
  // Pool's getSnapshot returns the current cached entry for this
  // signature; React polls it on subscribe + on every notify.
  const tablesJoin = discovery.kind === "ok" ? discovery.tables.join("\x00") : "__non_ok__";

  const fetcherRef = useRef<() => Promise<unknown>>(() => Promise.resolve(undefined));
  fetcherRef.current = (): Promise<unknown> => {
    const out = callbackRef.current(client) as Promise<unknown> | typeof SKIP;
    if (out === SKIP) {
      return Promise.resolve(undefined);
    }
    return out as Promise<unknown>;
  };

  const chainTablesRef = useRef<ReadonlySet<string>>(new Set());
  const discoveryKindRef = useRef<DiscoveryResult["kind"]>("ok");
  const discoveryErrorRef = useRef<Error | undefined>(undefined);
  discoveryKindRef.current = discovery.kind;
  if (discovery.kind === "ok") {
    chainTablesRef.current = new Set(discovery.tables);
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
        discovery.tables,
        chainTablesRef.current,
        () => fetcherRef.current(),
        notify,
      );
    },
    // The signature/tables determine the subscription; React
    // re-subscribes when either changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pool, signatureBase, tablesJoin],
  );

  // Stable per-error snapshot cache so repeated getSnapshot polls
  // within a single render return the same reference. React's
  // useSyncExternalStore detects identity changes; constructing a
  // fresh error literal each call drives an infinite re-render.
  const errorSnapshotRef = useRef<
    | {
        error: Error;
        snapshot: UseQueryResult<unknown>;
      }
    | undefined
  >(undefined);
  const snapshotForError = (err: Error): UseQueryResult<T> => {
    if (errorSnapshotRef.current?.error === err) {
      return errorSnapshotRef.current.snapshot as UseQueryResult<T>;
    }
    const snapshot = {
      status: "error" as const,
      data: undefined,
      error: err,
    } satisfies UseQueryResult<unknown>;
    errorSnapshotRef.current = { error: err, snapshot };
    return snapshot as UseQueryResult<T>;
  };

  const getSnapshot = useCallback((): UseQueryResult<T> => {
    if (asyncErrorRef.current) {
      return snapshotForError(asyncErrorRef.current);
    }
    if (discoveryKindRef.current === "skip") {
      return SKIPPED_SNAPSHOT as UseQueryResult<T>;
    }
    if (discoveryKindRef.current === "error") {
      return snapshotForError(
        discoveryErrorRef.current ?? new BaerlyError("Internal", "unknown discovery error"),
      );
    }
    return pool.getSnapshot(signatureBase) as UseQueryResult<T>;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, signatureBase]);

  // discoveryKindRef + discoveryErrorRef carry the latest discovery
  // state into getSnapshot without making it a useCallback dep
  // (avoids re-creating the snapshot callback every render).
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

/**
 * Reactive read hook. See {@link useQueryImpl} JSDoc for usage.
 * The `.skip` property is the sentinel that short-circuits the hook
 * into `status: "skipped"`.
 */
export const useQuery: {
  <T, TConfig extends BaerlyConfig = UnboundConfig>(
    callback: (client: BaerlyClient<TConfig>) => Promise<T> | typeof SKIP,
    deps?: ReadonlyArray<unknown>,
  ): UseQueryResult<T>;
  readonly skip: typeof SKIP;
} = Object.assign(useQueryImpl, { skip: SKIP }) as {
  <T, TConfig extends BaerlyConfig = UnboundConfig>(
    callback: (client: BaerlyClient<TConfig>) => Promise<T> | typeof SKIP,
    deps?: ReadonlyArray<unknown>,
  ): UseQueryResult<T>;
  readonly skip: typeof SKIP;
};

// Quiet `LOADING_SNAPSHOT` as a value-import — referenced by
// generated type for the `loading` branch only; bundled alongside
// `subscription-pool.ts`.
void LOADING_SNAPSHOT;
