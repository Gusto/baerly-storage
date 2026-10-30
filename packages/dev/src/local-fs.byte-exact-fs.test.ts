/**
 * `LocalFsStorage` over a simulated byte-exact (case-sensitive,
 * normalization-sensitive) filesystem, so ext4 behavior reproduces on a
 * folding macOS host.
 *
 * `node:fs/promises` is wrapped so every path component under a registered
 * root is stored on the real filesystem as the lowercase hex of its UTF-8
 * bytes, which no case fold or normalization changes, and `readdir` decodes
 * the names back. So `notes` and `Notes` are distinct entries whatever the
 * host does. Hex doubles a name's length, so tests here keep names short.
 * Lives in its own file because `vi.mock` hoists to module scope and would
 * otherwise shim every other local-fs test.
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
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  const hex = (name: string): string => Buffer.from(name, "utf8").toString("hex");
  const unhex = (name: string): string => Buffer.from(name, "hex").toString("utf8");
  shim.resolve = (p: unknown): unknown => {
    if (typeof p !== "string") {
      return p;
    }
    for (const root of shim.roots) {
      if (p.startsWith(`${root}/`)) {
        return [
          root,
          ...p
            .slice(root.length + 1)
            .split("/")
            .map(hex),
        ].join("/");
      }
    }
    return p;
  };
  const isUnderRoot = (p: unknown): boolean =>
    typeof p === "string" && [...shim.roots].some((r) => p === r || p.startsWith(`${r}/`));
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
      const entries = (await (real.readdir as (...a: unknown[]) => Promise<unknown[]>)(
        shim.resolve(p),
        ...rest,
      )) as Array<string | { name: string }>;
      if (!isUnderRoot(p)) {
        return entries;
      }
      return entries.map((e) => {
        if (typeof e === "string") {
          return unhex(e);
        }
        e.name = unhex(e.name);
        return e;
      });
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

const listKeys = async (s: LocalFsStorage): Promise<string[]> => {
  const keys: string[] = [];
  for await (const entry of s.list("")) {
    keys.push(entry.key);
  }
  return keys;
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baerly-localfs-byte-exact-"));
  shim.roots.add(root);
});
afterEach(() => {
  shim.roots.delete(root);
  rmSync(root, { recursive: true, force: true });
});

test("the shim is byte-exact: a file and a directory differing by case coexist", async () => {
  // Guards the harness itself: on a folding host without the shim, the
  // `mkdir` below fails with EEXIST against the file `notes`.
  const fs = await import("node:fs/promises");
  await fs.writeFile(join(root, "notes"), "file");
  await fs.mkdir(join(root, "Notes"));
  await fs.writeFile(join(root, "Notes", "todo"), "nested");
  await expect(fs.readFile(join(root, "notes"), "utf8")).resolves.toBe("file");
  await expect(fs.readFile(join(root, "Notes", "todo"), "utf8")).resolves.toBe("nested");
  const names = await fs.readdir(root);
  expect(names.toSorted()).toEqual(["Notes", "notes"]);
});

test("a stray beside the key it folds to is a separate file and is skipped", async () => {
  // `README.md` folds to the key `readme.md`, whose file exists, but the
  // two are different inodes, so it is not an alias.
  const fs = await import("node:fs/promises");
  const s = new LocalFsStorage({ root });
  await s.put("readme.md", utf8("key"));
  await fs.writeFile(join(root, "README.md"), "dropped in by hand");
  await expect(listKeys(s)).resolves.toEqual(["readme.md"]);
});

test("a stray whose fold runs through a key file is skipped by list", async () => {
  // `Notes/todo` folds to `notes/todo`, which decodes to a key, but `notes`
  // is a key's file, so stat-ing the folded path fails with ENOTDIR. No key
  // can reach the stray, so it is skipped like any other.
  const fs = await import("node:fs/promises");
  const s = new LocalFsStorage({ root });
  await s.put("notes", utf8("v"));
  await fs.mkdir(join(root, "Notes"));
  await fs.writeFile(join(root, "Notes", "todo"), "dropped in by hand");
  await expect(listKeys(s)).resolves.toEqual(["notes"]);
});
