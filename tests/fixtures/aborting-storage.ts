/**
 * `abortingStorage(inner)` — a `Storage` proxy that injects one-shot
 * faults into the operations it forwards.
 *
 * Three fault kinds, each with its own trap slot:
 *
 * - **Abort** (`armAt`): the chosen op throws an `AbortError`-named
 *   `Error` *before* it touches the wrapped storage, simulating process
 *   death between two consecutive I/Os.
 * - **Torn object** (`tearAt`): the chosen `put` writes only a prefix of
 *   its body to the wrapped storage (at the requested key, with the
 *   caller's preconditions), then throws the same `AbortError`. This
 *   models a backend without atomic object writes (a crashed local-fs
 *   write, a non-atomic gateway): a truncated object at a valid key.
 * - **Post-apply** (`armPostApplyAt`): the chosen op is applied to the
 *   wrapped storage with the caller's arguments and preconditions, then a
 *   retryable `BaerlyError("NetworkError")` is thrown in place of the
 *   result: the request landed but the response was lost (a dropped
 *   connection after the server committed). The caller sees a failure
 *   for a write that took effect, which is what exercises
 *   create-conflict adoption and resume-after-lost-ack paths. For `put`
 *   (including `ifNoneMatch: "*"` creates and `ifMatch` CAS) and
 *   `delete` the state change is real. A `get` is issued and its result
 *   discarded; a `list` is lazy and effect-free, so its post-apply form
 *   is the same synchronous throw as the abort, after `inner.list` is
 *   called. Reads therefore never change state under any arm; the arm
 *   only differs from `armAt` in whether `inner` saw the call.
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
import { BaerlyError, type Storage, type StorageListEntry } from "@baerly/protocol";

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
  /**
   * Arm the post-apply trap, replacing any armed post-apply. The
   * `nthFromCurrent`-th op from now that matches `target` (every op when
   * `target` is omitted) is forwarded to `inner` unchanged, then a
   * `BaerlyError("NetworkError")` (retryable) is thrown instead of the
   * result, and the trap clears. Works for `put`, `delete`, `get` and
   * `list` (see the file header for what post-apply means for reads).
   *
   * If `inner` itself rejects (a failed precondition), that error
   * surfaces instead and no fault fires; the trap is still consumed, so
   * op K is deterministic whatever the outcome. A pre-apply abort or a
   * tear on the same op wins and leaves this trap un-stepped. Pass
   * `undefined` to clear without rearming.
   */
  readonly armPostApplyAt: (nthFromCurrent: number | undefined, target?: FaultTarget) => void;
  /** Op kind and key of each post-apply fault fired so far, in order. */
  readonly postApplied: () => readonly { readonly op: StorageOpKind; readonly key: string }[];
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

const lostResponseError = (op: StorageOpKind, key: string): BaerlyError =>
  new BaerlyError(
    "NetworkError",
    `${op} ${key}: response lost after the op was applied (injected by abortingStorage)`,
  );

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
 * reaches it with a truncated body; a post-apply op reaches it intact
 * and then fails.
 */
export const abortingStorage = (inner: Storage): AbortingStorageHandle => {
  let count = 0;
  let fired = 0;
  let abortTrap: Trap | undefined = undefined;
  let tearTrap: Trap | undefined = undefined;
  let tearOpts: TearOptions | undefined = undefined;
  let postApplyTrap: Trap | undefined = undefined;
  const torn: string[] = [];
  const postApplyLog: { op: StorageOpKind; key: string }[] = [];

  /** Step the post-apply trap; true when this op must throw after applying. */
  const postApplyDue = (op: StorageOpKind, key: string): boolean => {
    if (!step(postApplyTrap, op, key)) {
      return false;
    }
    postApplyTrap = undefined;
    return true;
  };
  const lost = (op: StorageOpKind, key: string): never => {
    postApplyLog.push({ op, key });
    fired += 1;
    throw lostResponseError(op, key);
  };

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
      if (postApplyDue("get", key)) {
        await inner.get(key, opts);
        return lost("get", key);
      }
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
      if (postApplyDue("put", key)) {
        await inner.put(key, body, opts);
        return lost("put", key);
      }
      return inner.put(key, body, opts);
    },
    async delete(key, opts) {
      before("delete", key);
      if (postApplyDue("delete", key)) {
        await inner.delete(key, opts);
        return lost("delete", key);
      }
      return inner.delete(key, opts);
    },
    list(prefix, opts): AsyncIterable<StorageListEntry> {
      // `list` ticks *once* per call: entries are pulled lazily and a
      // mid-stream abort isn't modellable through the `AsyncIterable`
      // contract without re-implementing the generator. Every `list()`
      // call is a discrete logical op in the writer / compactor / GC
      // pipelines, and the trap lands before the first page is fetched.
      before("list", prefix);
      if (postApplyDue("list", prefix)) {
        inner.list(prefix, opts);
        return lost("list", prefix);
      }
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
    armPostApplyAt: (n, target) => {
      postApplyTrap = armed(n, target);
    },
    postApplied: () => [...postApplyLog],
    tornKeys: () => [...torn],
    faultsFired: () => fired,
    resetCount: () => {
      count = 0;
    },
  };
};
