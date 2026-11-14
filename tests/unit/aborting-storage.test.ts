import { describe, expect, test } from "vitest";
import { MemoryStorage } from "@baerly/protocol";
import { abortingStorage } from "../fixtures/aborting-storage.ts";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

const drain = async (it: AsyncIterable<{ key: string }>): Promise<string[]> => {
  const keys: string[] = [];
  for await (const entry of it) {
    keys.push(entry.key);
  }
  return keys;
};

describe("abortingStorage abort trap", () => {
  test("armAt(K) aborts the K-th op before it reaches inner, then clears", async () => {
    const inner = new MemoryStorage();
    const handle = abortingStorage(inner);
    handle.armAt(2);
    await handle.storage.put("a", bytes("1"));
    await expect(handle.storage.put("b", bytes("2"))).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(inner.get("b")).resolves.toBeNull();
    expect(handle.opCount()).toBe(2);
    expect(handle.faultsFired()).toBe(1);
    // One abort per arm: the next op goes through.
    await handle.storage.put("b", bytes("2"));
    await expect(inner.get("b")).resolves.not.toBeNull();
  });

  test("armAt counts from the call, not from opCount zero", async () => {
    const handle = abortingStorage(new MemoryStorage());
    for (let i = 0; i < 3; i++) {
      await handle.storage.get("missing");
    }
    handle.armAt(2);
    await handle.storage.get("missing");
    await expect(handle.storage.get("missing")).rejects.toMatchObject({ name: "AbortError" });
    expect(handle.opCount()).toBe(5);
  });

  test("resetCount keeps an armed trap; armAt(undefined) clears it", async () => {
    const handle = abortingStorage(new MemoryStorage());
    handle.armAt(2);
    await handle.storage.get("k");
    handle.resetCount();
    expect(handle.opCount()).toBe(0);
    await expect(handle.storage.get("k")).rejects.toMatchObject({ name: "AbortError" });

    handle.armAt(1);
    handle.armAt(undefined);
    await expect(handle.storage.get("k")).resolves.toBeNull();
    expect(handle.faultsFired()).toBe(1);
  });

  test("armAt rejects a non-positive count", () => {
    const handle = abortingStorage(new MemoryStorage());
    expect(() => handle.armAt(0)).toThrow(RangeError);
    expect(() => handle.armAt(1.5)).toThrow(RangeError);
  });

  test("a prefix target counts only matching keys; other traffic stays healthy", async () => {
    const inner = new MemoryStorage();
    const handle = abortingStorage(inner);
    handle.armAt(2, { prefix: "t/log/" });
    await handle.storage.put("t/current.json", bytes("c"));
    await handle.storage.put("t/log/0.json", bytes("0"));
    await handle.storage.put("t/snapshot/x.json", bytes("s"));
    await handle.storage.get("t/current.json");
    await expect(handle.storage.put("t/log/1.json", bytes("1"))).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(inner.get("t/log/1.json")).resolves.toBeNull();
    // Non-matching ops still bump the global count.
    expect(handle.opCount()).toBe(5);
  });

  test("an ops target counts only the listed op kinds", async () => {
    const inner = new MemoryStorage();
    await inner.put("t/log/0.json", bytes("0"));
    const handle = abortingStorage(inner);
    handle.armAt(1, { prefix: "t/log/", ops: ["put"] });
    // A GET of the same key does not trip a put-only trap.
    await expect(handle.storage.get("t/log/0.json")).resolves.not.toBeNull();
    await handle.storage.delete("t/log/0.json");
    await expect(handle.storage.put("t/log/1.json", bytes("1"))).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  test("a list matches a target prefix that extends the list prefix", async () => {
    const inner = new MemoryStorage();
    await inner.put("t/log/0.json", bytes("0"));
    const handle = abortingStorage(inner);
    handle.armAt(1, { prefix: "t/log/", ops: ["list"] });
    // A narrower list than the target does not match.
    await expect(drain(handle.storage.list("t/log/0"))).resolves.toEqual(["t/log/0.json"]);
    // The exact prefix and anything wider do.
    expect(() => handle.storage.list("t/")).toThrow(
      expect.objectContaining({ name: "AbortError" }),
    );
  });
});

describe("abortingStorage torn-object trap", () => {
  test("tearAt lands a truncated body at the key, then throws AbortError", async () => {
    const inner = new MemoryStorage();
    const handle = abortingStorage(inner);
    handle.tearAt(1);
    await expect(handle.storage.put("k", bytes("abcdefgh"))).rejects.toMatchObject({
      name: "AbortError",
    });
    const got = await inner.get("k");
    expect(text(got!.body)).toBe("abcd");
    expect(handle.tornKeys()).toEqual(["k"]);
    expect(handle.faultsFired()).toBe(1);
    // One tear per arm.
    await handle.storage.put("k2", bytes("abcdefgh"));
    expect(text((await inner.get("k2"))!.body)).toBe("abcdefgh");
  });

  test("keepBytes takes a number or a function and is clamped so the object is torn", async () => {
    const inner = new MemoryStorage();
    const handle = abortingStorage(inner);
    handle.tearAt(1, undefined, { keepBytes: 3 });
    await handle.storage.put("a", bytes("abcdefgh")).catch(() => {});
    handle.tearAt(1, undefined, { keepBytes: (n) => n - 1 });
    await handle.storage.put("b", bytes("abcdefgh")).catch(() => {});
    handle.tearAt(1, undefined, { keepBytes: 99 });
    await handle.storage.put("c", bytes("abcdefgh")).catch(() => {});
    handle.tearAt(1, undefined, { keepBytes: -4 });
    await handle.storage.put("d", bytes("abcdefgh")).catch(() => {});
    expect(text((await inner.get("a"))!.body)).toBe("abc");
    expect(text((await inner.get("b"))!.body)).toBe("abcdefg");
    expect(text((await inner.get("c"))!.body)).toBe("abcdefg");
    expect(text((await inner.get("d"))!.body)).toBe("");
  });

  test("only matching puts count toward a tear; gets and other keys do not", async () => {
    const inner = new MemoryStorage();
    const handle = abortingStorage(inner);
    handle.tearAt(2, { prefix: "t/snapshot/", ops: ["get"] });
    await handle.storage.put("t/snapshot/1.json", bytes("one!"));
    await handle.storage.get("t/snapshot/1.json");
    await handle.storage.put("t/current.json", bytes("cur!"));
    await expect(handle.storage.put("t/snapshot/2.json", bytes("two!"))).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(text((await inner.get("t/snapshot/1.json"))!.body)).toBe("one!");
    expect(text((await inner.get("t/current.json"))!.body)).toBe("cur!");
    expect(text((await inner.get("t/snapshot/2.json"))!.body)).toBe("tw");
  });

  test("a torn put honors the caller's precondition: a rejected create tears nothing", async () => {
    const inner = new MemoryStorage();
    await inner.put("k", bytes("original"));
    const handle = abortingStorage(inner);
    handle.tearAt(1);
    await expect(
      handle.storage.put("k", bytes("replacement"), { ifNoneMatch: "*" }),
    ).rejects.toMatchObject({
      code: "WriteConflict",
    });
    expect(text((await inner.get("k"))!.body)).toBe("original");
    expect(handle.tornKeys()).toEqual([]);
    expect(handle.faultsFired()).toBe(0);
  });

  test("abort and tear traps are independent; an abort on the same op wins", async () => {
    const inner = new MemoryStorage();
    const handle = abortingStorage(inner);
    handle.tearAt(2);
    handle.armAt(1);
    await expect(handle.storage.put("a", bytes("aaaa"))).rejects.toMatchObject({
      name: "AbortError",
    });
    // The aborted op never reached the tear check, so the tear is still armed.
    await expect(inner.get("a")).resolves.toBeNull();
    await handle.storage.put("b", bytes("bbbb"));
    await expect(handle.storage.put("c", bytes("cccc"))).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(text((await inner.get("c"))!.body)).toBe("cc");
    expect(handle.faultsFired()).toBe(2);

    handle.tearAt(1);
    handle.tearAt(undefined);
    await handle.storage.put("d", bytes("dddd"));
    expect(text((await inner.get("d"))!.body)).toBe("dddd");
  });
});
