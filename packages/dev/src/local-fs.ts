import { createHash } from "node:crypto";
import { link, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

/**
 * Reserved prefix for the in-directory create-if-absent temp (see `put`).
 * `walk`/`list` skip it; it is internal/transient and never a real key.
 */
const TEMP_PREFIX = ".baerly-tmp-";

export interface LocalFsStorageOptions {
  /** Root directory; treated as "the bucket". */
  root: string;
}

const utf8Encoder = new TextEncoder();

/**
 * Compare two keys by their UTF-8 byte sequences — the order S3 and R2
 * use for `list`. JS's default string sort compares UTF-16 code units,
 * which diverges from UTF-8 byte order for supplementary-plane
 * characters; using this keeps `list` ordering faithful to the real
 * adapters. (All kernel keys are ASCII base-32, where both orders
 * coincide.)
 */
const compareKeysUtf8 = (a: string, b: string): number => {
  const ba = utf8Encoder.encode(a);
  const bb = utf8Encoder.encode(b);
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (ba[i] !== bb[i]) {
      return ba[i]! - bb[i]!;
    }
  }
  return ba.length - bb.length;
};

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
 * never see a partially-written file.
 *
 * `ifNoneMatch:"*"` uses a same-dir temp + `link(2)` (atomic exclusive
 * create; `EEXIST` ⇒ key exists) so concurrent creates have exactly one
 * winner. Same-dir avoids `EXDEV`; temp+`link` over `open(…,"wx")` keeps
 * a partially-written new key invisible to a concurrent reader. `ifMatch`
 * keeps the `rename` path (in-process TOCTOU only; cross-process
 * contention uses the S3 / Minio `If-Match` path).
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

    await mkdir(dirname(path), { recursive: true });

    if (opts?.ifNoneMatch === "*") {
      // Atomic exclusive create via link(2) — see class JSDoc.
      const tmp = join(
        dirname(path),
        `${TEMP_PREFIX}${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      try {
        await writeFile(tmp, body);
        await link(tmp, path);
      } catch (error) {
        if (isErrnoException(error) && error.code === "EEXIST") {
          throw new BaerlyError(
            "Conflict",
            `PUT ${key}: precondition failed (ifNoneMatch="*" but key exists)`,
          );
        }
        throw new BaerlyError(
          "InvalidResponse",
          `LocalFsStorage.put(${key}): ${(error as Error).message}`,
          error,
        );
      } finally {
        // Best-effort cleanup — a failed write may leave a partial temp,
        // and a cleanup failure must not mask a Conflict thrown above.
        await rm(tmp, { force: true }).catch(() => {});
      }
      return { etag: newEtag, serverDate: new Date() };
    }

    if (opts?.ifMatch !== undefined) {
      // TOCTOU within a process — fine. Cross-process callers should
      // not rely on these guards (see class JSDoc).
      const existing = await readExisting(path);
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

    // Unconditional PUT (or ifMatch already verified above).
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
    keys.sort(compareKeysUtf8);
    let yielded = 0;
    for (const key of keys) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      if (compareKeysUtf8(key, startAfter) <= 0) {
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
      } else if (entry.isFile() && !entry.name.startsWith(TEMP_PREFIX)) {
        // Skip the transient create-if-absent temps (see TEMP_PREFIX) so a
        // concurrent list during a create never surfaces a half-linked key.
        out.push(relative(root, full).split(sep).join(posix.sep));
      }
    }
  }
};
