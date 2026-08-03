import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
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
 * Deliberately limited to the shared-memory tmpfs mounts. `/dev/shm` is a
 * separate mount on essentially every Linux distro, so the cross-device arm
 * runs for real on CI — the only platform gating merges. macOS has no
 * equivalent and skips, which the always-runs `TMPDIR` proxy alongside this
 * covers.
 *
 * An earlier version also enumerated `/Volumes` to find a second filesystem
 * on macOS. Removed: at module load that stats a developer's mounted
 * volumes and `mkdtemp`s into the first writable one, so an external SSD or
 * a mounted DMG collects temp directories from a unit test, and a stale
 * network mount blocks the import. It bought coverage only on the platform
 * that does not gate merges, and only when the machine happens to have a
 * spare volume — i.e. non-deterministically. A fixed allowlist skips
 * honestly instead.
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

/**
 * Whether the filesystem backing `os.tmpdir()` folds case — true on a
 * stock macOS (APFS, case-insensitive by default), false on Linux ext4.
 * Probed rather than assumed from `process.platform`, since either OS can
 * be configured the other way.
 */
const CASE_INSENSITIVE_FS = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), "baerly-case-probe-"));
  try {
    writeFileSync(join(probe, "probe"), "x");
    return existsSync(join(probe, "PROBE"));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

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

  test("list() tolerates a key deleted mid-iteration", async () => {
    // `list` walks names, then reads each file to hash its etag. A delete
    // landing in that window used to escape as a raw Node ENOENT rather
    // than a BaerlyError — reachable in the maintenance fold, where runGc
    // deletes while the compactor walks the same prefixes. A key vanishing
    // mid-listing is legal on a real object store, so it is skipped.
    for (const k of ["a", "b", "c", "d"]) {
      await s.put(k, utf8("v"));
    }
    const seen: string[] = [];
    for await (const entry of s.list("")) {
      seen.push(entry.key);
      if (entry.key === "a") {
        await s.delete("b");
        await s.delete("c");
      }
    }
    expect(seen).toEqual(["a", "d"]);
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

  // --- ifMatch CAS is read-compare-write and must be serialized ---
  //
  // The compare reads the on-disk etag, but the write that follows is two
  // more awaited fs ops away, and `node:fs/promises` yields the event loop
  // at each one. Without a lock, every racer reads the same base etag,
  // every racer passes the compare, and every racer renames — N "successful"
  // CAS writes against one base version, which is the one thing CAS exists
  // to prevent. `Storage`'s contract (and every caller: the compactor's
  // fold, `casUpdateCurrentJson`, `casUpdateGcPending`) requires exactly one.

  test("concurrent ifMatch on the same etag has exactly one winner", async () => {
    const base = await s.put("k", utf8("v0"));
    const RACERS = 16;
    const outcomes = await Promise.allSettled(
      Array.from({ length: RACERS }, (_, i) => s.put("k", utf8(`r${i}`), { ifMatch: base.etag })),
    );
    const winners = outcomes.filter((o) => o.status === "fulfilled").length;
    const conflicts = outcomes.filter(
      (o) => o.status === "rejected" && (o.reason as { code?: string }).code === "Conflict",
    ).length;
    expect(winners).toBe(1);
    expect(conflicts).toBe(RACERS - 1);
  });

  test("concurrent ifMatch across separate instances on one root has exactly one winner", async () => {
    // The load-bearing arm. `localFsStorage()` mints a fresh instance per
    // call over the same default root, and the randomized cascade builds N
    // instances over one `mkdtemp` root specifically to make them contend
    // (`tests/integration/randomized.test.ts` → `makeStorages`). A lock
    // scoped to the instance would serialize nothing in exactly the harness
    // built to catch this, so the lock is keyed by resolved root + key.
    const RACERS = 16;
    const instances = Array.from({ length: RACERS }, () => new LocalFsStorage({ root }));
    const base = await instances[0]!.put("k", utf8("v0"));
    const outcomes = await Promise.allSettled(
      instances.map((inst, i) => inst.put("k", utf8(`r${i}`), { ifMatch: base.etag })),
    );
    const winners = outcomes.filter((o) => o.status === "fulfilled").length;
    const conflicts = outcomes.filter(
      (o) => o.status === "rejected" && (o.reason as { code?: string }).code === "Conflict",
    ).length;
    expect(winners).toBe(1);
    expect(conflicts).toBe(RACERS - 1);
    // The survivor must be one of the racers' bodies, not a torn mix.
    const body = fromBytes((await s.get("k"))!.body);
    expect(body).toMatch(/^r\d+$/);
  });

  test("concurrent ifMatch through a symlinked root has exactly one winner", async () => {
    // Two instances over ONE directory reached by two different path
    // spellings. `resolve()` collapses `.`/`..` but not symlinks, so
    // before the lock keyed on `realpath` these took separate locks and
    // both published over the same base etag — measured, 2 winners.
    //
    // This is the portable arm of the aliasing guard: it needs no
    // case-insensitive filesystem, so unlike the case variant below it
    // actually runs on Linux CI, which is the only platform gating merges.
    // `/tmp` -> `/private/tmp` on macOS makes this an ordinary
    // misconfiguration, not a contrived one.
    const base = await mkdtemp(join(tmpdir(), "baerly-localfs-symlink-"));
    try {
      await mkdir(join(base, "real"));
      await symlink(join(base, "real"), join(base, "link"));
      const viaReal = new LocalFsStorage({ root: join(base, "real") });
      const viaLink = new LocalFsStorage({ root: join(base, "link") });
      const seed = await viaReal.put("k", utf8("v0"));
      const outcomes = await Promise.allSettled([
        ...Array.from({ length: 8 }, (_, i) =>
          viaReal.put("k", utf8(`real-${i}`), { ifMatch: seed.etag }),
        ),
        ...Array.from({ length: 8 }, (_, i) =>
          viaLink.put("k", utf8(`link-${i}`), { ifMatch: seed.etag }),
        ),
      ]);
      const winners = outcomes.filter((o) => o.status === "fulfilled").length;
      const nonConflict = outcomes.filter(
        (o) => o.status === "rejected" && (o.reason as { code?: string }).code !== "Conflict",
      );
      expect(nonConflict).toEqual([]);
      expect(winners).toBe(1);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("a root that cannot be canonicalized fails loudly instead of unlocking", async () => {
    // `#canonicalRoot` swallows a `realpath` failure and falls back to the
    // unresolved spelling. That is correct for exactly one case — a root
    // that does not exist yet — and silently wrong for every other, because
    // the fallback is a *different lock key*: an instance that fails to
    // canonicalize does not serialize against one that succeeds, and the
    // exactly-one-winner guarantee above degrades with nothing logged and
    // nothing thrown. So only ENOENT may be absorbed.
    //
    // A symlink loop is the portable way to make `realpath` fail with
    // something else (ELOOP) without needing a permission bit, which is
    // unsettable under the root-owned containers CI runs in. `delete` is
    // the probe because it is the one mutation that reaches `#lockKey`
    // without first `mkdir`-ing its parent.
    const base = await mkdtemp(join(tmpdir(), "baerly-localfs-eloop-"));
    try {
      await symlink(join(base, "b"), join(base, "a"));
      await symlink(join(base, "a"), join(base, "b"));
      const s2 = new LocalFsStorage({ root: join(base, "a") });
      const err = await s2.delete("k").then(
        () => null,
        (error: unknown) => error as { code?: string; message?: string },
      );
      expect(err).not.toBeNull();
      expect(err?.code).toBe("InvalidResponse");
      // Names the canonicalization, not the `rm` that would have failed
      // downstream anyway — the point is that the lock key is unsound, and
      // an operator reading `delete(k): ELOOP` would not learn that.
      expect(err?.message).toMatch(/canonicalize root/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("a root that does not exist yet is still absorbed", async () => {
    // The one case the fallback exists for, held in place against the
    // narrowing above: `delete` from a bucket that was never created stays
    // an idempotent no-op rather than becoming an ENOENT error.
    const absent = new LocalFsStorage({ root: join(root, "never-created") });
    await expect(absent.delete("k")).resolves.toBeUndefined();
  });

  test.skipIf(!CASE_INSENSITIVE_FS)(
    "concurrent ifMatch on case-variant keys has exactly one winner",
    async () => {
      // The case/normalization arm. It only means anything where the
      // filesystem folds case — on a case-sensitive one these spellings
      // are genuinely different objects and the assertion would hold
      // trivially — so it skips honestly rather than passing for free and
      // looking like coverage it is not providing. The symlink arm above
      // is what guards the same mechanism on Linux CI.
      const seed = await s.put("alias", utf8("v0"));
      const spellings = ["alias", "ALIAS", "Alias", "aLiAs"];
      const outcomes = await Promise.allSettled(
        spellings.flatMap((spelling) =>
          Array.from({ length: 4 }, (_, j) =>
            s.put(spelling, utf8(`w-${spelling}-${j}`), { ifMatch: seed.etag }),
          ),
        ),
      );
      const winners = outcomes.filter((o) => o.status === "fulfilled").length;
      const nonConflict = outcomes.filter(
        (o) => o.status === "rejected" && (o.reason as { code?: string }).code !== "Conflict",
      );
      expect(nonConflict).toEqual([]);
      expect(winners).toBe(1);
    },
  );

  test("distinct keys are not serialized against each other", async () => {
    // The lock must be per key, not global — serializing the whole adapter
    // would be a "correctness fix" that quietly turns the dev server
    // single-file. Asserting that N distinct puts all landed would NOT
    // catch that (they land either way); this deadlocks under a global
    // lock, because neither put can finish until the other has started.
    let releaseA!: () => void;
    let releaseB!: () => void;
    const aStarted = new Promise<void>((r) => {
      releaseA = r;
    });
    const bStarted = new Promise<void>((r) => {
      releaseB = r;
    });
    const bodyA = utf8("a");
    const bodyB = utf8("b");
    await Promise.all([
      (async () => {
        const p = s.put("key-a", bodyA);
        releaseA();
        await bStarted;
        await p;
      })(),
      (async () => {
        const p = s.put("key-b", bodyB);
        releaseB();
        await aStarted;
        await p;
      })(),
    ]);
    expect(fromBytes((await s.get("key-a"))!.body)).toBe("a");
    expect(fromBytes((await s.get("key-b"))!.body)).toBe("b");
  });

  // --- AbortSignal must be re-checked inside the critical section ---
  //
  // `put` / `delete` check the signal on entry and then take the key's lock,
  // which is an unbounded wait behind other writers to the same key. A signal
  // aborted during that wait has already cleared the entry guard, so without
  // the re-check inside the critical section the write lands anyway. Measured
  // before the fix: an aborted queued put and an aborted queued delete both
  // completed, and the key was gone.
  //
  // Aborting AFTER the call returns its promise is what makes these
  // deterministic rather than timing-dependent. The entry guard is a
  // synchronous `throwIfAborted()` at the top of the method, so by the time
  // `abort()` runs it has provably already passed — leaving the
  // in-critical-section re-check as the only guard that can still reject. No
  // reliance on queue depth or on who wins the ticket.
  //
  // This is the gap the shared conformance suite cannot cover: its abort
  // tests use a pre-aborted controller, which trips the entry guard and never
  // reaches the lock at all.

  test("put aborted while queued behind another writer rejects and does not land", async () => {
    const holder = s.put("k", utf8("holder"));
    const ac = new AbortController();
    const queued = s.put("k", utf8("queued"), { signal: ac.signal });
    ac.abort();
    const [held, aborted] = await Promise.allSettled([holder, queued]);
    expect(held.status).toBe("fulfilled");
    expect(aborted.status).toBe("rejected");
    expect((aborted as PromiseRejectedResult).reason).toMatchObject({ name: "AbortError" });
    // Whichever racer took the ticket first, the aborted body must never be
    // the one on disk.
    expect(fromBytes((await s.get("k"))!.body)).toBe("holder");
  });

  test("delete aborted while queued behind another writer rejects and keeps the key", async () => {
    await s.put("k", utf8("v0"));
    const holder = s.put("k", utf8("holder"));
    const ac = new AbortController();
    const queued = s.delete("k", { signal: ac.signal });
    ac.abort();
    const [held, aborted] = await Promise.allSettled([holder, queued]);
    expect(held.status).toBe("fulfilled");
    expect(aborted.status).toBe("rejected");
    expect((aborted as PromiseRejectedResult).reason).toMatchObject({ name: "AbortError" });
    // Order-independent: if the delete had taken the ticket first it would
    // still have to reject before its `rm`, so the key survives either way.
    await expect(s.get("k")).resolves.not.toBeNull();
    expect(fromBytes((await s.get("k"))!.body)).toBe("holder");
  });
});
