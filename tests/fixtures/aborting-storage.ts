/**
 * `abortingStorage(inner)` — a `Storage` proxy that aborts the K-th
 * operation mid-call, *before* it touches the wrapped storage.
 *
 * The crash fuzzer
 * (`tests/integration/phase5-crash-fuzz.test.ts`) uses this to
 * simulate process death between any two consecutive I/Os in the
 * writer / compactor / GC pipelines. Counting every `get` / `put` /
 * `delete` and the *start* of each `list` iteration makes the trap
 * point deterministic — `armAt(K)` reliably fires before the K-th
 * call into `inner`.
 *
 * Test-only. NOT part of the protocol contract; do not import from
 * `src/` or any package source.
 */
import type { Storage, StorageListEntry } from "@baerly/protocol";

export interface AbortingStorageHandle {
  /** The proxy `Storage`. Pass to `ServerWriter` / `compact` / `runGc`. */
  readonly storage: Storage;
  /** Number of ops issued since the last `resetCount()`. */
  readonly opCount: () => number;
  /**
   * Arm a trap. After this call, the next time the *current* count
   * reaches `nthFromCurrent`, the trap fires once: a synchronous
   * `AbortError`-named `Error` is thrown *before* `inner` is called,
   * and the trap then resets (one abort per `armAt`). Pass
   * `undefined` to clear without rearming.
   *
   * `nthFromCurrent` is 1-based against the current `opCount()` — if
   * `opCount()` is `3` and you call `armAt(2)`, the op that bumps the
   * count to `5` is the one that aborts. Most callers arm
   * pre-operation (`opCount() === 0`), making the value the absolute
   * count-of-ops-to-fire-on.
   */
  readonly armAt: (nthFromCurrent: number | undefined) => void;
  /** Reset the op counter back to 0. Does NOT clear an armed trap. */
  readonly resetCount: () => void;
}

/**
 * Wrap a `Storage` so the K-th-from-now operation aborts mid-call.
 * The wrapped operation does NOT reach the underlying storage —
 * simulating a process death immediately before the I/O issued.
 *
 * For determinism every op increments a single counter; pass
 * `armAt(K)` to make op #K fail.
 */
export const abortingStorage = (inner: Storage): AbortingStorageHandle => {
  let count = 0;
  let trap: number | undefined = undefined;
  const fireIfTrapped = (): void => {
    count += 1;
    if (trap !== undefined && count === trap) {
      trap = undefined;
      const err = new Error("AbortError (injected by abortingStorage)");
      err.name = "AbortError";
      throw err;
    }
  };
  const storage: Storage = {
    async get(key, opts) {
      fireIfTrapped();
      return inner.get(key, opts);
    },
    async put(key, body, opts) {
      fireIfTrapped();
      return inner.put(key, body, opts);
    },
    async delete(key, opts) {
      fireIfTrapped();
      return inner.delete(key, opts);
    },
    list(prefix, opts): AsyncIterable<StorageListEntry> {
      // `list` is special: tick *once* per iteration-start (i.e.
      // each call to `list(...)`) — entries are pulled lazily and a
      // mid-stream abort isn't modellable through the
      // `AsyncIterable` contract without re-implementing the
      // generator. Per-call counting is enough for the writer /
      // compactor / GC pipelines: every call to `list()` is a
      // discrete logical op, and the trap point lands before the
      // first underlying `get`-page fires.
      fireIfTrapped();
      return inner.list(prefix, opts);
    },
  };
  return {
    storage,
    opCount: () => count,
    armAt: (n) => {
      trap = n;
    },
    resetCount: () => {
      count = 0;
    },
  };
};
