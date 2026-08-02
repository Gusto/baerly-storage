import { describe, expect, test } from "vitest";
import { keyLockCount, withKeyLock } from "./key-lock.ts";

/** A promise plus its resolver, so a test can hold a section open. */
const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("withKeyLock", () => {
  test("serializes sections sharing a key", async () => {
    // Each section records enter/exit. If they overlap, an "enter" lands
    // between another section's enter and exit.
    const trace: string[] = [];
    const section = async (id: number): Promise<void> => {
      trace.push(`enter${id}`);
      await Promise.resolve();
      await Promise.resolve();
      trace.push(`exit${id}`);
    };
    await Promise.all([0, 1, 2, 3].map((i) => withKeyLock("k", () => section(i))));
    expect(trace).toEqual([
      "enter0",
      "exit0",
      "enter1",
      "exit1",
      "enter2",
      "exit2",
      "enter3",
      "exit3",
    ]);
  });

  test("admits only one holder at a time", async () => {
    let live = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 16 }, () =>
        withKeyLock("k", async () => {
          live += 1;
          peak = Math.max(peak, live);
          await Promise.resolve();
          live -= 1;
        }),
      ),
    );
    expect(peak).toBe(1);
  });

  test("different keys are not serialized against each other", async () => {
    // Both sections block until the other has entered. Under a global lock
    // this deadlocks; under a per-key lock it completes.
    const aEntered = deferred();
    const bEntered = deferred();
    await Promise.all([
      withKeyLock("a", async () => {
        aEntered.resolve();
        await bEntered.promise;
      }),
      withKeyLock("b", async () => {
        bEntered.resolve();
        await aEntered.promise;
      }),
    ]);
    expect(keyLockCount()).toBe(0);
  });

  test("a throwing section releases the lock and does not poison the next", async () => {
    const outcomes = await Promise.allSettled([
      withKeyLock("k", async () => {
        throw new Error("boom");
      }),
      withKeyLock("k", async () => "ok"),
    ]);
    expect(outcomes[0]).toMatchObject({ status: "rejected" });
    expect(outcomes[1]).toMatchObject({ status: "fulfilled", value: "ok" });
    expect(keyLockCount()).toBe(0);
  });

  test("entries are evicted once contenders drain", async () => {
    // Without eviction the map grows with the keyspace, which on a
    // long-lived dev server means one retained entry per key ever written.
    expect(keyLockCount()).toBe(0);
    const held = deferred();
    const inSection = deferred();
    const running = withKeyLock("k", async () => {
      inSection.resolve();
      await held.promise;
    });
    await inSection.promise;
    expect(keyLockCount()).toBe(1);
    held.resolve();
    await running;
    expect(keyLockCount()).toBe(0);

    await Promise.all(Array.from({ length: 50 }, (_, i) => withKeyLock(`key-${i}`, async () => i)));
    expect(keyLockCount()).toBe(0);
  });

  test("returns the section's value", async () => {
    await expect(withKeyLock("k", async () => 42)).resolves.toBe(42);
  });
});
