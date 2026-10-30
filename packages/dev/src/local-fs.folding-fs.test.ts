/**
 * `LocalFsStorage` over a simulated case- and normalization-folding
 * filesystem, so the macOS APFS aliasing defect reproduces on Linux CI.
 *
 * `node:fs/promises` is wrapped so every path under a registered root is
 * resolved the way APFS resolves it: case-insensitive and
 * normalization-insensitive, but case-preserving. Each component is
 * matched against the existing entries of its parent directory under an
 * NFD + lowercase fold; a match reuses the stored spelling, and a new name
 * is stored as given. So two spellings that fold together reach one file,
 * `readdir` reports whichever spelling created it, and a `rename` over an
 * existing file keeps the old name. Lives in its own file because
 * `vi.mock` hoists to module scope and would otherwise shim every other
 * local-fs test.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as FsPromises from "node:fs/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LocalFsStorage } from "./local-fs.ts";

const shim = vi.hoisted(() => ({
  roots: new Set<string>(),
  resolve: (p: unknown): unknown => p,
  /** One-shot hook run before the next `readdir`, to interleave a rival. */
  beforeReaddir: undefined as ((path: string) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  const { readdirSync } = await import("node:fs");
  // NFD plus full case folding, as APFS does: the lower→upper→lower round
  // trip takes `ß`/`ẞ` to `ss`, `ſ` to `s`, and `ﬁ` to `fi`, which a single
  // `toLowerCase` does not. It over-folds dotless `ı` to `i` (APFS keeps
  // them apart); no test here uses `ı`.
  const fold = (name: string): string =>
    name.normalize("NFD").toLowerCase().toUpperCase().toLowerCase();
  shim.resolve = (p: unknown): unknown => {
    if (typeof p !== "string") {
      return p;
    }
    for (const root of shim.roots) {
      if (!p.startsWith(`${root}/`)) {
        continue;
      }
      let current = root;
      for (const part of p.slice(root.length + 1).split("/")) {
        let stored = part;
        try {
          stored = readdirSync(current).find((n) => fold(n) === fold(part)) ?? part;
        } catch {
          // Parent does not exist yet: the name is stored as given.
        }
        current = `${current}/${stored}`;
      }
      return current;
    }
    return p;
  };
  // Resolve the first `pathArgs` arguments (the paths); pass the rest through.
  const wrap = <F extends (...args: never[]) => unknown>(fn: F, pathArgs: number): F =>
    ((...args: unknown[]) =>
      (fn as unknown as (...a: unknown[]) => unknown)(
        ...args.map((a, i) => (i < pathArgs ? shim.resolve(a) : a)),
      )) as unknown as F;
  const wrapped = {
    ...real,
    link: wrap(real.link, 2),
    rename: wrap(real.rename, 2),
    mkdir: wrap(real.mkdir, 1),
    readdir: (async (p: string, ...rest: never[]) => {
      const hook = shim.beforeReaddir;
      shim.beforeReaddir = undefined;
      await hook?.(p);
      return (real.readdir as (...a: unknown[]) => unknown)(shim.resolve(p), ...rest);
    }) as typeof real.readdir,
    readFile: wrap(real.readFile, 1),
    writeFile: wrap(real.writeFile, 1),
    rm: wrap(real.rm, 1),
    realpath: wrap(real.realpath, 1),
    stat: wrap(real.stat, 1),
  };
  return { ...wrapped, default: wrapped };
});

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const fromBytes = (b: Uint8Array): string => new TextDecoder().decode(b);

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baerly-localfs-folding-"));
  shim.roots.add(root);
});
afterEach(() => {
  shim.roots.delete(root);
  rmSync(root, { recursive: true, force: true });
});

test("the shim folds: two spellings of one path reach one file", async () => {
  // Guards the harness itself — without this, a shim that silently stopped
  // folding would turn the test below into a pass-for-free.
  const fs = await import("node:fs/promises");
  await fs.writeFile(join(root, "Aé"), "x");
  await expect(fs.readFile(join(root, "aé"), "utf8")).resolves.toBe("x");
});

test("keys differing only by case or Unicode normalization stay distinct objects", async () => {
  const s = new LocalFsStorage({ root });
  const prefix = "p/index/i/x/";
  const ids = ["é", "é", "A", "a"];
  for (const id of ids) {
    await s.put(`${prefix}${id}.json`, utf8(`body:${id}`));
  }
  const listed: string[] = [];
  for await (const entry of s.list(prefix)) {
    listed.push(entry.key);
  }
  // UTF-8 byte order of the ids: "A" < "a" < "é" < "é".
  expect(listed).toEqual(["A", "a", "é", "é"].map((id) => `${prefix}${id}.json`));
  for (const id of ids) {
    const got = await s.get(`${prefix}${id}.json`);
    expect(fromBytes(got!.body)).toBe(`body:${id}`);
  }
  // Deleting two spellings leaves their twins intact.
  await s.delete(`${prefix}é.json`);
  await s.delete(`${prefix}a.json`);
  expect(fromBytes((await s.get(`${prefix}é.json`))!.body)).toBe("body:é");
  expect(fromBytes((await s.get(`${prefix}A.json`))!.body)).toBe("body:A");
});

test("collection names differing only by case stay distinct", async () => {
  // `Users` and `users` interpolate raw into `manifests/<name>/…`; on a
  // folding filesystem they would share one `current.json`.
  const s = new LocalFsStorage({ root });
  await s.put("app/a/tenant/t/manifests/Users/current.json", utf8("upper"));
  await s.put("app/a/tenant/t/manifests/users/current.json", utf8("lower"));
  expect(fromBytes((await s.get("app/a/tenant/t/manifests/Users/current.json"))!.body)).toBe(
    "upper",
  );
  expect(fromBytes((await s.get("app/a/tenant/t/manifests/users/current.json"))!.body)).toBe(
    "lower",
  );
});

test("a stray file that aliases a real key is reported, not hidden", async () => {
  // On a folding filesystem `c/%4A` is the file `get("c/J")` reads (its
  // encoding is `c/%4a`), and `README.md` is the file `get("readme.md")`
  // reads. Skipping them in `list` would let get/put see a key that list
  // never returns — and a later `put("c/J")` renames over the stray and
  // keeps its spelling, so the real key stays invisible.
  const fs = await import("node:fs/promises");
  const s = new LocalFsStorage({ root });
  await s.put("app/x/current.json", utf8("v"));
  await fs.mkdir(join(root, "c"));
  await fs.writeFile(join(root, "c", "%4A"), "stray");
  await expect(s.get("c/J")).resolves.not.toBeNull(); // the alias is real
  await expect(
    (async () => {
      for await (const _ of s.list("")) {
        // drain
      }
    })(),
  ).rejects.toMatchObject({
    code: "InvalidResponse",
    message: expect.stringContaining("c/J"),
  });
});

test("a stray that full-case-folds onto a key is reported, not hidden", async () => {
  // `Straße` and `ﬁle` are the files `get("strasse")` / `get("file")` read
  // under full case folding, though no `toLowerCase` of them is a key.
  const fs = await import("node:fs/promises");
  for (const [stray, key] of [
    ["Straße", "strasse"],
    ["ﬁle", "file"],
  ] as const) {
    const dir = join(root, key);
    const s = new LocalFsStorage({ root: dir });
    await s.put("app/x/current.json", utf8("v"));
    await fs.writeFile(join(dir, stray), "stray");
    await expect(s.get(key)).resolves.not.toBeNull(); // the alias is real
    await expect(
      (async () => {
        for await (const _ of s.list("")) {
          // drain
        }
      })(),
    ).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringContaining(JSON.stringify(key)),
    });
  }
});

test("a stray file that aliases no key is skipped by list", async () => {
  const fs = await import("node:fs/promises");
  const s = new LocalFsStorage({ root });
  await s.put("app/x/current.json", utf8("v"));
  // `~` is never literal and `%zz` is not an escape, under any fold.
  await fs.writeFile(join(root, "notes~"), "stray");
  await fs.writeFile(join(root, "100%zz"), "stray");
  const listed: string[] = [];
  for await (const entry of s.list("")) {
    listed.push(entry.key);
  }
  expect(listed).toEqual(["app/x/current.json"]);
});

test("a marker stamped by a rival mid-scan is accepted, not refused", async () => {
  // Two openers on an unstamped directory: this one reads the marker as
  // absent, then a rival stamps it before this one's scan lists the root.
  // The scan therefore sees the marker as an unrecognized name, and only
  // the re-read of the marker before refusing keeps the open from failing.
  const fs = await import("node:fs/promises");
  await fs.mkdir(join(root, "app"));
  await fs.writeFile(join(root, "app", "current.json"), "{}");
  shim.beforeReaddir = async () => {
    await new LocalFsStorage({ root }).put("rival", utf8("v"));
  };
  const s = new LocalFsStorage({ root });
  const listed: string[] = [];
  for await (const entry of s.list("")) {
    listed.push(entry.key);
  }
  expect(listed).toEqual(["app/current.json", "rival"]);
});
