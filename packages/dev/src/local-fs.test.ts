import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fc } from "@fast-check/vitest";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { defineStorageConformanceSuite } from "@baerly/protocol/conformance";
import { LocalFsStorage } from "./local-fs.ts";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const fromBytes = (b: Uint8Array): string => new TextDecoder().decode(b);

const collect = async <T>(iter: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const x of iter) {
    out.push(x);
  }
  return out;
};

// sha-256("hello") — quoted to match the wire ETag format.
const ETAG_HELLO = `"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"`;

// LocalFsStorage-specific key arbitrary:
//   - Lowercase only. Case-insensitive filesystems (default macOS
//     HFS+/APFS) collapse two keys differing only in case onto the
//     same file; the PBT would shrink to a case-collision
//     counterexample on darwin. Linux/CI is case-sensitive but we
//     pick the safer subset so the suite passes everywhere.
//   - Excludes `.` and `..` (rejected as path segments by
//     LocalFsStorage's `#pathFor` — see `local-fs.ts`).
// `caseSensitiveKeys: true` is still accurate — under this arb every
// generated key is already unique under case-sensitive comparison.
const LOCALFS_KEY_ARB = fc
  .string({
    minLength: 1,
    maxLength: 32,
    unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-_".split("")),
  })
  .filter((k) => k !== "." && k !== "..");

defineStorageConformanceSuite(
  "LocalFsStorage",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "baerly-localfs-conformance-"));
    return {
      storage: new LocalFsStorage({ root }),
      teardown: async () => rmSync(root, { recursive: true, force: true }),
    };
  },
  { caseSensitiveKeys: true, keyArb: LOCALFS_KEY_ARB },
);

describe("LocalFsStorage — impl-specific", () => {
  let root: string;
  let s: LocalFsStorage;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "baerly-localfs-"));
    s = new LocalFsStorage({ root });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("etag is content-addressed (sha-256 hex, quoted)", async () => {
    const { etag } = await s.put("k", utf8("hello"));
    expect(etag).toBe(ETAG_HELLO);
  });

  test("identical bodies share an etag across keys", async () => {
    const a = await s.put("a", utf8("hello"));
    const b = await s.put("b", utf8("hello"));
    expect(a.etag).toBe(b.etag);
    expect(a.etag).toBe(ETAG_HELLO);
  });

  test("put returns a serverDate inside the call's wall-clock window", async () => {
    const before = Date.now();
    const { serverDate } = await s.put("k", utf8("v"));
    const after = Date.now();
    expect(serverDate).toBeInstanceOf(Date);
    expect(serverDate!.getTime()).toBeGreaterThanOrEqual(before);
    expect(serverDate!.getTime()).toBeLessThanOrEqual(after);
  });

  test("nested keys round-trip through directory hierarchy", async () => {
    await s.put("x/y/z", utf8("hi"));
    const got = await s.get("x/y/z");
    expect(fromBytes(got!.body)).toBe("hi");
    const listed = await collect(s.list("x/"));
    const entries = listed.map((e) => e.key);
    expect(entries).toEqual(["x/y/z"]);
  });

  test("path-traversal keys are rejected", async () => {
    for (const bad of [
      "",
      "..",
      "../etc",
      "x/../y",
      "/leading",
      "back\\slash",
      "trailing/",
      "double//slash",
    ]) {
      await expect(s.put(bad, utf8("v"))).rejects.toMatchObject({
        code: "InvalidConfig",
      });
    }
  });
});
