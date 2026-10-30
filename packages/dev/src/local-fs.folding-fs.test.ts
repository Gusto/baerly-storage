/**
 * `LocalFsStorage` over a simulated case- and normalization-folding
 * filesystem, so the macOS APFS aliasing defect reproduces on Linux CI.
 *
 * `node:fs/promises` is wrapped so every path under a registered root has
 * its part below the root folded (NFD + lowercase) before it reaches the
 * real filesystem. Two spellings that fold together therefore land on one
 * file, exactly as on a default APFS volume, and `readdir` reports the
 * folded spelling. Lives in its own file because `vi.mock` hoists to module
 * scope and would otherwise shim every other local-fs test.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as FsPromises from "node:fs/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LocalFsStorage } from "./local-fs.ts";

const shim = vi.hoisted(() => {
  const roots = new Set<string>();
  const fold = (p: unknown): unknown => {
    if (typeof p !== "string") {
      return p;
    }
    for (const root of roots) {
      if (p.startsWith(`${root}/`)) {
        return root + p.slice(root.length).normalize("NFD").toLowerCase();
      }
    }
    return p;
  };
  return { roots, fold };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  const { fold } = shim;
  // Fold the first `pathArgs` arguments (the paths); pass the rest through.
  const wrap = <F extends (...args: never[]) => unknown>(fn: F, pathArgs: number): F =>
    ((...args: unknown[]) =>
      (fn as unknown as (...a: unknown[]) => unknown)(
        ...args.map((a, i) => (i < pathArgs ? fold(a) : a)),
      )) as unknown as F;
  const wrapped = {
    ...real,
    link: wrap(real.link, 2),
    rename: wrap(real.rename, 2),
    mkdir: wrap(real.mkdir, 1),
    readdir: wrap(real.readdir, 1),
    readFile: wrap(real.readFile, 1),
    writeFile: wrap(real.writeFile, 1),
    rm: wrap(real.rm, 1),
    realpath: wrap(real.realpath, 1),
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
