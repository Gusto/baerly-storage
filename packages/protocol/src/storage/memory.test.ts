import { describe, expect, test } from "vitest";
import { MPS3Error } from "../errors";
import { MemoryStorage } from "./memory";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const fromBytes = (b: Uint8Array): string => new TextDecoder().decode(b);

const collect = async <T>(iter: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
};

describe("MemoryStorage", () => {
  test("put then get round-trips body and etag", async () => {
    const s = new MemoryStorage();
    const { etag } = await s.put("k", utf8("hello"));
    const got = await s.get("k");
    expect(got).not.toBeNull();
    expect(fromBytes(got!.body)).toBe("hello");
    expect(got!.etag).toBe(etag);
  });

  test("get of missing key returns null", async () => {
    const s = new MemoryStorage();
    expect(await s.get("missing")).toBeNull();
  });

  test("get with ifNoneMatch matching current etag returns null", async () => {
    const s = new MemoryStorage();
    const { etag } = await s.put("k", utf8("v"));
    expect(await s.get("k", { ifNoneMatch: etag })).toBeNull();
    const stale = await s.get("k", { ifNoneMatch: '"deadbeef"' });
    expect(stale).not.toBeNull();
    expect(stale!.etag).toBe(etag);
  });

  test("put with ifNoneMatch=\"*\" fails when key exists", async () => {
    const s = new MemoryStorage();
    await s.put("k", utf8("v"));
    await expect(s.put("k", utf8("v2"), { ifNoneMatch: "*" })).rejects.toMatchObject({
      code: "InvalidResponse",
    });
  });

  test("put with ifNoneMatch=\"*\" succeeds when key is absent", async () => {
    const s = new MemoryStorage();
    const { etag } = await s.put("k", utf8("v"), { ifNoneMatch: "*" });
    expect(etag).toBeTruthy();
  });

  test("put with ifMatch fails on stale etag", async () => {
    const s = new MemoryStorage();
    await s.put("k", utf8("v1"));
    await expect(s.put("k", utf8("v2"), { ifMatch: '"deadbeef"' })).rejects.toBeInstanceOf(
      MPS3Error,
    );
  });

  test("put with ifMatch fails when key is absent", async () => {
    const s = new MemoryStorage();
    await expect(s.put("k", utf8("v"), { ifMatch: '"1"' })).rejects.toMatchObject({
      code: "InvalidResponse",
    });
  });

  test("put with ifMatch succeeds on current etag and rotates etag", async () => {
    const s = new MemoryStorage();
    const first = await s.put("k", utf8("v1"));
    const second = await s.put("k", utf8("v2"), { ifMatch: first.etag });
    expect(second.etag).not.toBe(first.etag);
    const got = await s.get("k");
    expect(fromBytes(got!.body)).toBe("v2");
    expect(got!.etag).toBe(second.etag);
  });

  test("delete then get returns null; delete of missing key is a no-op", async () => {
    const s = new MemoryStorage();
    await s.put("k", utf8("v"));
    await s.delete("k");
    expect(await s.get("k")).toBeNull();
    // Idempotent.
    await expect(s.delete("k")).resolves.toBeUndefined();
  });

  test("list yields keys lex-asc and filtered by prefix", async () => {
    const s = new MemoryStorage();
    await s.put("b/2", utf8("b2"));
    await s.put("a/1", utf8("a1"));
    await s.put("a/3", utf8("a3"));
    await s.put("a/2", utf8("a2"));
    await s.put("c/0", utf8("c0"));
    const all = (await collect(s.list("a/"))).map((e) => e.key);
    expect(all).toEqual(["a/1", "a/2", "a/3"]);
  });

  test("list with startAfter is exclusive", async () => {
    const s = new MemoryStorage();
    await s.put("a/1", utf8("a1"));
    await s.put("a/2", utf8("a2"));
    await s.put("a/3", utf8("a3"));
    const after = (await collect(s.list("a/", { startAfter: "a/1" }))).map((e) => e.key);
    expect(after).toEqual(["a/2", "a/3"]);
  });

  test("list respects maxKeys cap", async () => {
    const s = new MemoryStorage();
    await s.put("a/1", utf8("a1"));
    await s.put("a/2", utf8("a2"));
    await s.put("a/3", utf8("a3"));
    const capped = (await collect(s.list("a/", { maxKeys: 2 }))).map((e) => e.key);
    expect(capped).toEqual(["a/1", "a/2"]);
  });

  test("list returns the current etag for each entry", async () => {
    const s = new MemoryStorage();
    const a = await s.put("a", utf8("v"));
    const b = await s.put("b", utf8("v"));
    const entries = await collect(s.list(""));
    expect(entries).toEqual([
      { key: "a", etag: a.etag },
      { key: "b", etag: b.etag },
    ]);
  });

  test("AbortSignal pre-aborted on get/put/delete throws", async () => {
    const s = new MemoryStorage();
    const ac = new AbortController();
    ac.abort();
    await expect(s.get("k", { signal: ac.signal })).rejects.toThrow();
    await expect(s.put("k", utf8("v"), { signal: ac.signal })).rejects.toThrow();
    await expect(s.delete("k", { signal: ac.signal })).rejects.toThrow();
  });
});
