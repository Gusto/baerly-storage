/**
 * `abortingStorage(inner)` — a `Storage` proxy that injects one-shot
 * faults into the operations it forwards.
 *
 * Two fault kinds, each with its own trap slot:
 *
 * - **Abort** (`armAt`): the chosen op throws an `AbortError`-named
 *   `Error` *before* it touches the wrapped storage, simulating process
 *   death between two consecutive I/Os.
 * - **Torn object** (`tearAt`): the chosen `put` writes only a prefix of
 *   its body to the wrapped storage (at the requested key, with the
 *   caller's preconditions), then throws the same `AbortError`. This
 *   models a backend without atomic object writes (a crashed local-fs
 *   write, a non-atomic gateway): a truncated object at a valid key.
 *
 * Either trap can target a key prefix and a set of op kinds
 * ({@link FaultTarget}), so a test can fault the `log/<seq>` create while
 * snapshot and `current.json` traffic stays healthy. An untargeted trap
 * counts every op, which is what the crash fuzzer
 * (`tests/integration/maintenance-crash-fuzz.test.ts`) uses to kill the
 * writer / compactor / GC pipelines at every op boundary.
 *
 * Counting: every `get` / `put` / `delete` and the *start* of each
 * `list` iteration is one op, so the trap point is deterministic.
 *
 * Test-only. NOT part of the protocol contract; do not import from
 * `src/` or any package source.
 */
import type { Storage, StorageListEntry } from "@baerly/protocol";

/** The four `Storage` methods, as fault-target op kinds. */
export type StorageOpKind = "get" | "put" | "delete" | "list";

/**
 * Which ops a trap counts. Both fields narrow; an omitted field matches
 * everything.
 */
export interface FaultTarget {
  /**
   * Match ops whose key starts with this prefix. For `list` the key is the
   * list prefix, so a `list("…/log/")` matches the target prefix `…/log/`
   * and anything shorter; it does not match `…/log/7.json`.
   */
  readonly prefix?: string;
  /** Match only these op kinds. */
  readonly ops?: readonly StorageOpKind[];
}

export interface TearOptions {
  /**
   * Bytes of the body that reach the wrapped storage. A number is clamped
   * to `[0, body.length - 1]` so the object is always torn (a body of
   * length 0 or 1 lands empty); a function receives the body length.
   * Defaults to half the body, rounded down.
   */
  readonly keepBytes?: number | ((length: number) => number);
}

export interface AbortingStorageHandle {
  /** The proxy `Storage`. Pass to `Writer` / `compact` / `runGc`. */
  readonly storage: Storage;
  /** Number of ops issued since the last `resetCount()`. */
  readonly opCount: () => number;
  /**
   * Arm the abort trap, replacing any armed abort. The `nthFromCurrent`-th
   * op from now that matches `target` (every op when `target` is omitted)
   * throws an `AbortError`-named `Error` *before* `inner` is called, then
   * the trap clears (one abort per `armAt`). Pass `undefined` to clear
   * without rearming.
   *
   * `nthFromCurrent` is 1-based and relative to the call: `armAt(2)` after
   * three ops aborts the fifth.
   */
  readonly armAt: (nthFromCurrent: number | undefined, target?: FaultTarget) => void;
  /**
   * Arm the torn-object trap, replacing any armed tear. The
   * `nthFromCurrent`-th `put` from now that matches `target` lands a prefix
   * of its body (see {@link TearOptions.keepBytes}) and then throws an
   * `AbortError`-named `Error`. If the wrapped `put` itself rejects (a
   * failed precondition), that error surfaces instead and nothing is torn.
   * Only `put` ops count, whatever `target.ops` says. Pass `undefined` to
   * clear without rearming.
   */
  readonly tearAt: (
    nthFromCurrent: number | undefined,
    target?: FaultTarget,
    opts?: TearOptions,
  ) => void;
  /** Keys of the objects torn so far, in order. */
  readonly tornKeys: () => readonly string[];
  /** Number of faults (aborts and tears) that have fired. */
  readonly faultsFired: () => number;
  /** Reset the op counter back to 0. Does NOT clear an armed trap. */
  readonly resetCount: () => void;
}

interface Trap {
  remaining: number;
  readonly target: FaultTarget | undefined;
}

const matches = (target: FaultTarget | undefined, op: StorageOpKind, key: string): boolean => {
  if (target === undefined) {
    return true;
  }
  if (target.ops !== undefined && !target.ops.includes(op)) {
    return false;
  }
  if (target.prefix === undefined) {
    return true;
  }
  return op === "list" ? target.prefix.startsWith(key) : key.startsWith(target.prefix);
};

/** Step `trap` for one op; true when this op is the one it fires on. */
const step = (trap: Trap | undefined, op: StorageOpKind, key: string): boolean => {
  if (trap === undefined || !matches(trap.target, op, key)) {
    return false;
  }
  trap.remaining -= 1;
  return trap.remaining === 0;
};

const abortError = (): Error => {
  const err = new Error("AbortError (injected by abortingStorage)");
  err.name = "AbortError";
  return err;
};

const keptLength = (length: number, opts: TearOptions | undefined): number => {
  const keep = opts?.keepBytes;
  let raw = Math.floor(length / 2);
  if (typeof keep === "function") {
    raw = keep(length);
  } else if (keep !== undefined) {
    raw = keep;
  }
  return Math.max(0, Math.min(Math.floor(raw), length - 1));
};

const armed = (nth: number | undefined, target: FaultTarget | undefined): Trap | undefined => {
  if (nth === undefined) {
    return undefined;
  }
  if (!Number.isInteger(nth) || nth < 1) {
    throw new RangeError(`abortingStorage: nthFromCurrent must be a positive integer, got ${nth}`);
  }
  return { remaining: nth, target };
};

/**
 * Wrap a `Storage` so armed faults fire on chosen operations. The
 * aborted operation does NOT reach the underlying storage; a torn `put`
 * reaches it with a truncated body.
 */
export const abortingStorage = (inner: Storage): AbortingStorageHandle => {
  let count = 0;
  let fired = 0;
  let abortTrap: Trap | undefined = undefined;
  let tearTrap: Trap | undefined = undefined;
  let tearOpts: TearOptions | undefined = undefined;
  const torn: string[] = [];

  const before = (op: StorageOpKind, key: string): void => {
    count += 1;
    if (step(abortTrap, op, key)) {
      abortTrap = undefined;
      fired += 1;
      throw abortError();
    }
  };

  const storage: Storage = {
    async get(key, opts) {
      before("get", key);
      return inner.get(key, opts);
    },
    async put(key, body, opts) {
      before("put", key);
      if (tearTrap !== undefined && step(tearTrap, "put", key)) {
        const keep = keptLength(body.length, tearOpts);
        tearTrap = undefined;
        tearOpts = undefined;
        await inner.put(key, body.slice(0, keep), opts);
        torn.push(key);
        fired += 1;
        throw abortError();
      }
      return inner.put(key, body, opts);
    },
    async delete(key, opts) {
      before("delete", key);
      return inner.delete(key, opts);
    },
    list(prefix, opts): AsyncIterable<StorageListEntry> {
      // `list` ticks *once* per call: entries are pulled lazily and a
      // mid-stream abort isn't modellable through the `AsyncIterable`
      // contract without re-implementing the generator. Every `list()`
      // call is a discrete logical op in the writer / compactor / GC
      // pipelines, and the trap lands before the first page is fetched.
      before("list", prefix);
      return inner.list(prefix, opts);
    },
  };
  return {
    storage,
    opCount: () => count,
    armAt: (n, target) => {
      abortTrap = armed(n, target);
    },
    tearAt: (n, target, opts) => {
      // Only puts tear, so the op-kind filter is dropped; the prefix stays.
      tearTrap = armed(n, target?.prefix === undefined ? undefined : { prefix: target.prefix });
      tearOpts = tearTrap === undefined ? undefined : opts;
    },
    tornKeys: () => [...torn],
    faultsFired: () => fired,
    resetCount: () => {
      count = 0;
    },
  };
};
