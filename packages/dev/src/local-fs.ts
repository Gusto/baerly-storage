import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import {
  BaerlyError,
  type Storage,
  type StorageGetOptions,
  type StorageGetResult,
  type StorageListEntry,
  type StoragePutOptions,
  type StoragePutResult,
} from "@baerly/protocol";

export interface LocalFsStorageOptions {
  /** Root directory; treated as "the bucket". */
  root: string;
}

/**
 * `Storage` backed by a directory tree. Keys may contain `/` and map
 * to nested directories on disk so `ls`/`cat` work as expected.
 *
 * ETags are content-addressed: `"<sha-256-hex>"` (the surrounding
 * double-quotes match S3's wire format for non-multipart objects).
 * Identical bodies share an ETag across runs — the property that
 * makes this adapter useful for fixture-based tests.
 *
 * Writes are atomic via `writeFile(temp) + rename(final)`; readers
 * never see a partially-written file. The adapter does NOT coordinate
 * cross-process `ifMatch`/`ifNoneMatch` checks (a TOCTOU race is
 * possible if two processes write the same key concurrently).
 * Single-process `baerly dev` is the design center; multi-process
 * scenarios use the S3 / Minio path.
 *
 * Node-only — imports `node:fs`, `node:path`, `node:crypto`. Lives in
 * `@baerly/dev` because the protocol kernel is pure-modules / no I/O
 * and must remain Worker-bundleable.
 */
export class LocalFsStorage implements Storage {
  readonly #root: string;

  constructor(opts: LocalFsStorageOptions) {
    this.#root = resolve(opts.root);
  }

  async get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> {
    opts?.signal?.throwIfAborted();
    const path = this.#pathFor(key);
    let body: Buffer;
    try {
      body = await readFile(path);
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return null;
      }
      throw new BaerlyError(
        "InvalidResponse",
        `LocalFsStorage.get(${key}): ${(error as Error).message}`,
        error,
      );
    }
    const etag = etagOf(body);
    if (opts?.ifNoneMatch !== undefined && opts.ifNoneMatch === etag) {
      // 304 Not Modified — caller's cached copy is current.
      return null;
    }
    return { body: toUint8Array(body), etag };
  }

  async put(key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult> {
    opts?.signal?.throwIfAborted();
    const path = this.#pathFor(key);
    const newEtag = etagOf(body);

    if (opts?.ifMatch !== undefined || opts?.ifNoneMatch === "*") {
      // TOCTOU within a process — fine. Cross-process callers should
      // not rely on these guards (see class JSDoc).
      const existing = await readExisting(path);
      if (opts?.ifNoneMatch === "*" && existing !== null) {
        throw new BaerlyError(
          "Conflict",
          `PUT ${key}: precondition failed (ifNoneMatch="*" but key exists)`,
        );
      }
      if (opts?.ifMatch !== undefined) {
        if (existing === null) {
          throw new BaerlyError(
            "Conflict",
            `PUT ${key}: precondition failed (ifMatch=${opts.ifMatch} but key does not exist)`,
          );
        }
        const currentEtag = etagOf(existing);
        if (currentEtag !== opts.ifMatch) {
          throw new BaerlyError(
            "Conflict",
            `PUT ${key}: precondition failed (ifMatch=${opts.ifMatch} but current ETag is ${currentEtag})`,
          );
        }
      }
    }

    await mkdir(dirname(path), { recursive: true });
    // Write to a unique temp path then rename for atomicity. Temp lives
    // in `os.tmpdir()` so a half-written file never appears under the
    // bucket root where `list` might see it. PID + timestamp + random
    // tail makes the name unique across concurrent writers in the same
    // process.
    const tmp = join(
      tmpdir(),
      `baerly-localfs-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await writeFile(tmp, body);
    try {
      await rename(tmp, path);
    } catch (error) {
      // Best-effort cleanup of the temp file; swallow any error there
      // so the original failure surfaces unchanged.
      await rm(tmp, { force: true }).catch(() => {});
      throw new BaerlyError(
        "InvalidResponse",
        `LocalFsStorage.put(${key}): ${(error as Error).message}`,
        error,
      );
    }
    return { etag: newEtag, serverDate: new Date() };
  }

  async delete(key: string, opts?: { signal?: AbortSignal }): Promise<void> {
    opts?.signal?.throwIfAborted();
    const path = this.#pathFor(key);
    try {
      await rm(path);
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return;
      } // idempotent
      throw new BaerlyError(
        "InvalidResponse",
        `LocalFsStorage.delete(${key}): ${(error as Error).message}`,
        error,
      );
    }
  }

  async *list(
    prefix: string,
    opts?: {
      startAfter?: string;
      maxKeys?: number;
      signal?: AbortSignal;
    },
  ): AsyncIterable<StorageListEntry> {
    opts?.signal?.throwIfAborted();
    const startAfter = opts?.startAfter ?? "";
    const maxKeys = opts?.maxKeys ?? Infinity;
    const keys: string[] = [];
    await walk(this.#root, keys);
    keys.sort();
    let yielded = 0;
    for (const key of keys) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      if (key <= startAfter) {
        continue;
      }
      if (yielded >= maxKeys) {
        return;
      }
      opts?.signal?.throwIfAborted();
      const buf = await readFile(this.#pathFor(key));
      yield { key, etag: etagOf(buf) };
      yielded += 1;
    }
  }

  /**
   * Map an S3-style key to a filesystem path under `#root`, rejecting
   * anything that could escape the root (path traversal, absolute
   * paths, empty segments, backslashes). All rejections throw
   * `BaerlyError("InvalidConfig", …)`.
   */
  #pathFor(key: string): string {
    if (key.length === 0) {
      throw new BaerlyError("InvalidConfig", "LocalFsStorage: empty key");
    }
    if (key.startsWith("/")) {
      throw new BaerlyError("InvalidConfig", `LocalFsStorage: leading "/" in key: ${key}`);
    }
    if (key.includes("\\")) {
      throw new BaerlyError("InvalidConfig", `LocalFsStorage: backslash in key: ${key}`);
    }
    const segments = key.split("/");
    if (segments.some((s) => s === "" || s === "." || s === "..")) {
      throw new BaerlyError("InvalidConfig", `LocalFsStorage: illegal segment in key: ${key}`);
    }
    const path = join(this.#root, ...segments);
    if (path !== this.#root && !path.startsWith(this.#root + sep)) {
      throw new BaerlyError("InvalidConfig", `LocalFsStorage: resolved path escapes root: ${key}`);
    }
    return path;
  }
}

const etagOf = (body: Uint8Array): string => {
  const h = createHash("sha256").update(body).digest("hex");
  return `"${h}"`;
};

const toUint8Array = (buf: Buffer): Uint8Array =>
  new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

const isErrnoException = (e: unknown): e is NodeJS.ErrnoException =>
  typeof e === "object" && e !== null && "code" in e;

const readExisting = async (path: string): Promise<Buffer | null> => {
  try {
    return await readFile(path);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

/**
 * Recursive directory walk. Yields filesystem-relative paths in
 * forward-slash form so callers can use them as S3-style keys
 * regardless of the host's path separator.
 */
const walk = async (root: string, out: string[]): Promise<void> => {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(relative(root, full).split(sep).join(posix.sep));
      }
    }
  }
};
