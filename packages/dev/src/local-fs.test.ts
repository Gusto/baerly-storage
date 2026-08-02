import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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

/**
 * A writable directory on a filesystem *other* than `os.tmpdir()`'s, or
 * `null` when the host has only one. Identified by a differing `st_dev`,
 * which is exactly the condition `rename(2)` rejects with `EXDEV`.
 *
 * Deliberately a fixed allowlist of the shared-memory tmpfs mounts rather
 * than a scan for any second volume. `/dev/shm` is a separate mount on
 * essentially every Linux distro, so the cross-device arm runs for real on
 * CI — the only platform gating merges. macOS has no equivalent and skips,
 * which the always-runs `TMPDIR` proxy alongside this covers.
 *
 * Enumerating something like `/Volumes` would buy a macOS arm, but at module
 * load it stats a developer's mounted volumes and `mkdtemp`s into the first
 * writable one — so an external SSD or a mounted DMG collects temp
 * directories from a unit test, and a stale network mount blocks the import.
 * Non-deterministic coverage on the platform that does not gate merges is
 * not worth that; skipping honestly is better.
 */
const findForeignFilesystem = (): string | null => {
  const tmpDev = statSync(tmpdir()).dev;
  for (const candidate of ["/dev/shm", "/run/shm"]) {
    try {
      if (statSync(candidate).dev === tmpDev) {
        continue;
      }
      accessSync(candidate, constants.W_OK);
      return candidate;
    } catch {
      // Missing, unreadable, or read-only — not usable as a foreign root.
    }
  }
  return null;
};

const FOREIGN_FS = findForeignFilesystem();

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

  test("list() yields keys in UTF-8 byte order, not UTF-16", async () => {
    // Same discriminating set as the MemoryStorage test: U+E000 (BMP,
    // UTF-8 first byte 0xEE) sorts before U+1F600 (emoji, 0xF0) in byte
    // order, but after it under UTF-16. U+E000 is Private-Use with no
    // decomposition, so it survives filesystem normalization verbatim.
    const BMP = "\uE000";
    const EMOJI = "\u{1F600}";
    await s.put(EMOJI, utf8("emoji"));
    await s.put(BMP, utf8("bmp"));
    await s.put("a", utf8("ascii"));
    const listed = await collect(s.list(""));
    expect(listed.map((e) => e.key)).toEqual(["a", BMP, EMOJI]);
    const afterA = await collect(s.list("", { startAfter: "a" }));
    expect(afterA.map((e) => e.key)).toEqual([BMP, EMOJI]);
  });

  test("nested keys round-trip through directory hierarchy", async () => {
    await s.put("x/y/z", utf8("hi"));
    const got = await s.get("x/y/z");
    expect(fromBytes(got!.body)).toBe("hi");
    const listed = await collect(s.list("x/"));
    const entries = listed.map((e) => e.key);
    expect(entries).toEqual(["x/y/z"]);
  });

  test("list() excludes internal temp files at every depth", async () => {
    // BOTH write paths stage a `.baerly-tmp-*` file next to their
    // destination — the link(2) create-if-absent and the write+rename that
    // serves unconditional and `ifMatch` puts. A crash between staging and
    // publishing (or a concurrent list during one) can leave one behind at
    // any depth, and it must never surface as a key. This is what makes
    // staging inside the bucket root safe; see `tempPathFor`.
    await s.put("real", utf8("v"));
    await s.put("nested/real", utf8("v"));
    writeFileSync(join(root, ".baerly-tmp-99999-0-deadbeef"), "leftover");
    writeFileSync(join(root, "nested", ".baerly-tmp-99999-0-cafebabe"), "leftover");
    // A *directory* in the reserved namespace is skipped wholesale rather
    // than descended into. Nothing here creates one, but were its children
    // yielded they would be keys that `#pathFor` rejects, and `list` would
    // throw part-way through iteration instead of returning.
    mkdirSync(join(root, ".baerly-tmp-99999-0-straydir"));
    writeFileSync(join(root, ".baerly-tmp-99999-0-straydir", "child"), "leftover");
    const listed = await collect(s.list(""));
    expect(listed.map((e) => e.key)).toEqual(["nested/real", "real"]);
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

  test("keys in the reserved temp namespace are rejected", async () => {
    // `walk` skips TEMP_PREFIX so staging temps never surface as keys —
    // which means a real key there would be writable and readable but
    // invisible to list(), silently violating put-then-list. The namespace
    // is reserved rather than left as a hole for `tempPathFor` alone to
    // avoid.
    for (const bad of [".baerly-tmp-mine", "nested/.baerly-tmp-mine", ".baerly-tmp-"]) {
      await expect(s.put(bad, utf8("v"))).rejects.toMatchObject({ code: "InvalidConfig" });
      await expect(s.get(bad)).rejects.toMatchObject({ code: "InvalidConfig" });
      await expect(s.delete(bad)).rejects.toMatchObject({ code: "InvalidConfig" });
    }
  });

  // --- The write path must never leave the bucket root (EXDEV) ---
  //
  // `rename(2)` and `link(2)` fail with `EXDEV` across filesystems, so a
  // temp staged outside the root breaks every write whenever the root and
  // `os.tmpdir()` are on different volumes. That is the *normal* production
  // shape, not an exotic one: the default root is `<cwd>/.baerly-data`
  // (`packages/adapter-node/src/local-fs-storage.ts`), which in a container
  // is a mounted data volume while `/tmp` is a tmpfs or the image layer.
  //
  // A genuine EXDEV needs a second filesystem, which no test can assume, so
  // the guard is split: the first test always runs and pins the invariant
  // that actually matters (the write path does not depend on `os.tmpdir()`),
  // and the second exercises real EXDEV wherever a second volume exists.

  test("put does not depend on os.tmpdir() being usable", async () => {
    // The portable proxy for EXDEV. If `put` stages its temp outside the
    // bucket root, it inherits every failure mode of that other directory —
    // a different volume (EXDEV), a read-only `/tmp`, a tmpfs too small for
    // the body, or, as here, a `TMPDIR` that does not resolve. A `put` that
    // stages same-dir is immune to all of them, so pointing `TMPDIR` at a
    // missing directory is a deterministic, dependency-free stand-in for
    // "the temp escaped the root". `os.tmpdir()` re-reads `TMPDIR` on every
    // call, so this takes effect without reloading the module.
    const original = process.env["TMPDIR"];
    process.env["TMPDIR"] = join(root, "..", "baerly-tmpdir-does-not-exist");
    try {
      await expect(s.put("unconditional", utf8("v1"))).resolves.toMatchObject({
        etag: expect.any(String),
      });
      const created = await s.put("cas", utf8("v1"), { ifNoneMatch: "*" });
      await expect(s.put("cas", utf8("v2"), { ifMatch: created.etag })).resolves.toMatchObject({
        etag: expect.any(String),
      });
      expect(fromBytes((await s.get("unconditional"))!.body)).toBe("v1");
      expect(fromBytes((await s.get("cas"))!.body)).toBe("v2");
    } finally {
      if (original === undefined) {
        delete process.env["TMPDIR"];
      } else {
        process.env["TMPDIR"] = original;
      }
    }
  });

  test.skipIf(FOREIGN_FS === null)(
    "put succeeds when the bucket root is on a different filesystem",
    async () => {
      // The real thing. Skips rather than lies when the host has only one
      // writable filesystem — on Linux CI `/dev/shm` is a separate tmpfs mount
      // (hence a distinct `st_dev`, hence a genuine EXDEV against `/tmp`), so
      // this arm does run where it counts.
      const foreignRoot = mkdtempSync(join(FOREIGN_FS!, "baerly-localfs-exdev-"));
      try {
        const storage = new LocalFsStorage({ root: foreignRoot });
        expect(statSync(foreignRoot).dev).not.toBe(statSync(tmpdir()).dev);
        await expect(storage.put("k", utf8("v1"))).resolves.toMatchObject({
          etag: expect.any(String),
        });
        const created = await storage.put("cas", utf8("v1"), { ifNoneMatch: "*" });
        await expect(
          storage.put("cas", utf8("v2"), { ifMatch: created.etag }),
        ).resolves.toMatchObject({ etag: expect.any(String) });
        expect(fromBytes((await storage.get("k"))!.body)).toBe("v1");
        expect(fromBytes((await storage.get("cas"))!.body)).toBe("v2");
      } finally {
        rmSync(foreignRoot, { recursive: true, force: true });
      }
    },
  );

  test("concurrent create-if-absent on a fresh key has exactly one winner", async () => {
    const concRoot = await mkdtemp(join(tmpdir(), "baerly-localfs-race-"));
    try {
      const storage = new LocalFsStorage({ root: concRoot });
      const key = "race/key";
      const RACERS = 16;
      const outcomes = await Promise.allSettled(
        Array.from({ length: RACERS }, (_, i) =>
          storage.put(key, utf8(String(i)), { ifNoneMatch: "*" }),
        ),
      );
      const winners = outcomes.filter((o) => o.status === "fulfilled").length;
      const conflicts = outcomes.filter(
        (o) => o.status === "rejected" && (o.reason as { code?: string }).code === "Conflict",
      ).length;
      expect(winners).toBe(1);
      expect(conflicts).toBe(RACERS - 1);
    } finally {
      await rm(concRoot, { recursive: true, force: true });
    }
  });
});
