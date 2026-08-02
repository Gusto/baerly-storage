/**
 * A keyed async mutex: serializes async critical sections that share a
 * lock key, while letting different keys run concurrently.
 *
 * Deliberately NOT re-exported from `./index.ts` — this is an internal
 * implementation detail of `LocalFsStorage`, not part of the published
 * `@gusto/baerly-storage/dev` surface.
 */

interface KeyLock {
  /** Resolves when the currently-running holder releases. */
  tail: Promise<void>;
  /** Holders currently running or queued; the entry is evicted at zero. */
  waiters: number;
}

/**
 * Live locks, keyed by caller-supplied string.
 *
 * Module-level rather than per-owner on purpose. `LocalFsStorage` is
 * constructed freely — `localFsStorage()` mints a fresh instance on every
 * call over the same default root, and the randomized cascade builds N
 * instances over one directory specifically to make them contend — so a
 * lock map hanging off the instance would serialize nothing in exactly the
 * cases that need it. Callers key on the resolved root plus the storage
 * key, which is the real identity of the thing being mutated.
 */
const locks = new Map<string, KeyLock>();

/**
 * Run `fn` with exclusive access to `lockKey`, in FIFO order among
 * contenders. Concurrent calls on *different* keys are unaffected.
 *
 * A rejecting `fn` releases the lock like any other completion and the
 * rejection propagates to its own caller only — one failed critical
 * section must not wedge the key or poison the next holder.
 *
 * Scope: one loaded copy of this module, since `locks` is module-level.
 * That is one process in every normal setup. It says nothing about other
 * processes, which need a lock file, a lease, or server-side CAS.
 *
 * `fn` must not itself call `withKeyLock` on the same key — the inner
 * call would wait on the outer call's release and self-deadlock. Nothing
 * in this package does; only one lock is ever held at a time, so there is
 * no lock-ordering cycle either.
 */
export const withKeyLock = async <T>(lockKey: string, fn: () => Promise<T>): Promise<T> => {
  let lock = locks.get(lockKey);
  if (lock === undefined) {
    lock = { tail: Promise.resolve(), waiters: 0 };
    locks.set(lockKey, lock);
  }
  lock.waiters += 1;

  // Take a ticket: wait on the previous holder's release, and publish our
  // own release as what the next arrival waits on. Both happen before any
  // `await`, so tickets are handed out in call order with no interleaving.
  const predecessor = lock.tail;
  let release!: () => void;
  lock.tail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await predecessor;
  try {
    return await fn();
  } finally {
    release();
    lock.waiters -= 1;
    // Evict once the last contender drains, so the map is bounded by
    // in-flight writers rather than growing with the keyspace — a
    // long-lived dev server would otherwise retain an entry per key ever
    // written. `waiters` is incremented synchronously at registration and
    // decremented only here, so zero really does mean nobody is left. The
    // identity check is belt-and-braces: there is no `await` between the
    // release above and this line, so it cannot currently be false.
    if (lock.waiters === 0 && locks.get(lockKey) === lock) {
      locks.delete(lockKey);
    }
  }
};

/** Test-only: number of live lock entries. Pins the eviction path. */
export const keyLockCount = (): number => locks.size;
