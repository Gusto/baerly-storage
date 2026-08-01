import { createHash } from "node:crypto";
import { link, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import {
  BaerlyError,
  assertValidStorageKey,
  type Storage,
  type StorageGetOptions,
  type StorageGetResult,
  type StorageListEntry,
  type StoragePutOptions,
  type StoragePutResult,
} from "@baerly/protocol";
import { withKeyLock } from "./key-lock.ts";

/**
 * Reserved prefix for the in-directory staging temps (see `put`).
 * `walk`/`list` skip it; it is internal/transient and never a real key.
 */
const TEMP_PREFIX = ".baerly-tmp-";

/**
 * Staging path for a two-phase (write → publish) `put`. Always a sibling
 * of the destination: `rename(2)`/`link(2)` refuse to cross filesystems
 * (`EXDEV`), and the bucket root is routinely on a different volume from
 * `os.tmpdir()`. `TEMP_PREFIX` is what makes staging in-bucket safe —
 * `walk` filters it at every depth, so a crash before the publish leaves
 * a file invisible to `list` rather than a bogus key.
 *
 * The trade-off that invisibility buys: a temp stranded by a hard crash
 * now sits inside the bucket, and because every enumerator goes through
 * `list`, nothing — not `runGc`, not `admin fsck` — will ever reclaim it.
 * Staging in `os.tmpdir()` at least let the OS reap it. Repeated crashes
 * therefore grow the data directory, and clearing that is a manual
 * `find . -name '.baerly-tmp-*' -delete`. Non-crash failures are cleaned
 * up by `put`'s `finally`.
 */
const tempPathFor = (finalPath: string): string =>
  join(
    dirname(finalPath),
    `${TEMP_PREFIX}${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

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
 * never see a partially-written file. The temp is always a sibling of
 * its destination — `rename(2)`/`link(2)` fail with `EXDEV` across
 * filesystems, and the bucket root is routinely on a different volume
 * from `os.tmpdir()` (see `tempPathFor`).
 *
 * `ifNoneMatch:"*"` uses `link(2)` (atomic exclusive create; `EEXIST` ⇒
 * key exists) so concurrent creates have exactly one winner. temp+`link`
 * over `open(…,"wx")` keeps a partially-written new key invisible to a
 * concurrent reader.
 *
 * `ifMatch` is a read-compare-write, so it is made atomic by serializing
 * every mutation of a key against every other — see `#lockKey`.
 *
 * Scope of that guarantee, precisely: **one loaded copy of this module**.
 * Within it, concurrent CAS on one key admits exactly one winner and the
 * losers get `Conflict`, across any number of `LocalFsStorage` instances
 * whose roots resolve — through symlinks — to the same directory. That is
 * one process in every normal setup, but the lock lives in a module-level
 * map, so a process that somehow loads both this source and the bundled
 * copy has two of them.
 *
 * Across processes it guarantees nothing: two `baerly` CLI runs, or two
 * servers, sharing a directory can both win, because nothing in POSIX
 * makes read-compare-write atomic without a lock file or a lease. That is
 * why this adapter is for single-process dev and self-hosting;
 * horizontally-scaled deploys need S3 / R2, whose server-side conditional
 * write is what the no-lease maintenance fold actually relies on.
 *
 * Node-only — imports `node:fs`, `node:path`, `node:crypto`. Lives in
 * `@baerly/dev` because the protocol kernel is pure-modules / no I/O
 * and must remain Worker-bundleable.
 */
export class LocalFsStorage implements Storage {
  readonly #root: string;
  /** Memoized `realpath` of {@link #root} — see {@link #canonicalRoot}. */
  #realRoot: string | undefined;

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
    // Create the parent before taking the lock, so the `realpath` behind
    // `#lockKey` has a directory to canonicalize.
    await mkdir(dirname(path), { recursive: true });
    // Every mutation of a key is serialized against every other. `ifMatch`
    // is the reason: it reads the current body, compares etags, and only
    // then publishes, with awaited fs ops in between — so unguarded, two
    // callers both read the base etag, both pass the compare, and both
    // publish, yielding N winners for one base version. Guarding the
    // unconditional and create-if-absent paths too is not incidental: an
    // unconditional put landing inside another caller's compare→publish
    // window is the same lost update reached from the other side.
    return withKeyLock(await this.#lockKey(path), () => this.#putSerialized(key, path, body, opts));
  }

  async #putSerialized(
    key: string,
    path: string,
    body: Uint8Array,
    opts?: StoragePutOptions,
  ): Promise<StoragePutResult> {
    // Re-check inside the critical section. The pre-lock check happens
    // before an unbounded queue wait, so a signal aborted while this call
    // sat behind other writers to the same key would otherwise be ignored
    // and the write would land anyway.
    opts?.signal?.throwIfAborted();
    const newEtag = etagOf(body);

    if (opts?.ifNoneMatch === "*") {
      // Atomic exclusive create via link(2) — see class JSDoc.
      const tmp = tempPathFor(path);
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
      // Read-compare-write. Atomic only because `put` holds this key's
      // lock for the whole of it, publish included — see the class JSDoc
      // for what that does and does not guarantee.
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

    // Unconditional PUT (or `ifMatch` already verified above). Stage to a
    // sibling temp, then `rename` to publish — the rename is atomic, so a
    // reader sees either the old body or the new one, never a partial
    // write. See `tempPathFor` for why the temp must be a sibling.
    const tmp = tempPathFor(path);
    try {
      await writeFile(tmp, body);
      await rename(tmp, path);
    } catch (error) {
      throw new BaerlyError(
        "InvalidResponse",
        `LocalFsStorage.put(${key}): ${(error as Error).message}`,
        error,
      );
    } finally {
      // Best-effort cleanup, mirroring the create-if-absent branch. On
      // success the rename already consumed the temp and this is a no-op;
      // on failure it keeps a half-written body from lingering under the
      // bucket root, where only the `TEMP_PREFIX` filter hides it. A
      // cleanup failure must not mask the error thrown above.
      await rm(tmp, { force: true }).catch(() => {});
    }
    return { etag: newEtag, serverDate: new Date() };
  }

  async delete(key: string, opts?: { signal?: AbortSignal }): Promise<void> {
    opts?.signal?.throwIfAborted();
    const path = this.#pathFor(key);
    // Same lock as `put`: a delete slipping between an `ifMatch` compare
    // and its publish would resurrect the key from a version the caller
    // was told no longer existed.
    return withKeyLock(await this.#lockKey(path), async () => {
      // Re-check after the queue wait — see `#putSerialized`.
      opts?.signal?.throwIfAborted();
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
    });
  }

  /**
   * Identity of the thing being mutated, for {@link withKeyLock}.
   *
   * Keyed on the *canonical filesystem path*, not on the key and not on
   * `this`. Not on `this` because separate instances over one directory
   * are the common case (`localFsStorage()` mints a fresh one per call),
   * so an instance-scoped lock would serialize nothing where it matters.
   * Not on the key because several distinct spellings can name one file,
   * and handing an alias its own lock lets the race straight back in —
   * each of the three below was measured at 2 winners before it was
   * closed:
   *
   * - Case. The default macOS filesystem folds it, so `k` and `K` are one
   *   object.
   * - Unicode. macOS normalizes filenames, so NFC and NFD spellings of
   *   one string are one object.
   * - Symlinks. `resolve()` collapses `.`/`..` but not links, so
   *   `/tmp/data` and `/private/tmp/data` — the same directory on every
   *   Mac — look like two. Hence `realpath`, memoized per instance and
   *   only cached once it succeeds, so a root that does not exist yet
   *   cannot poison the entry.
   *
   * Case-folding and NFC-normalizing deliberately over-approximate: on a
   * case-sensitive filesystem `a` and `A` are genuinely different objects
   * and will share a lock. That costs a little concurrency between keys
   * differing only in case, and never costs correctness — whereas
   * under-approximating does, which is exactly how the symlink class got
   * missed the first time. This adapter is not the throughput path.
   */
  async #lockKey(path: string): Promise<string> {
    const root = await this.#canonicalRoot();
    return (root + path.slice(this.#root.length)).normalize("NFC").toLowerCase();
  }

  /**
   * {@link #root} with symlinks resolved. Cached only on success: `delete`
   * against a bucket that was never created would otherwise memoize the
   * un-canonicalized spelling and defeat the aliasing guard for every
   * later `put`.
   */
  async #canonicalRoot(): Promise<string> {
    if (this.#realRoot !== undefined) {
      return this.#realRoot;
    }
    try {
      this.#realRoot = await realpath(this.#root);
      return this.#realRoot;
    } catch {
      return this.#root;
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
      let buf: Buffer;
      try {
        buf = await readFile(this.#pathFor(key));
      } catch (error) {
        if (isErrnoException(error) && error.code === "ENOENT") {
          // Deleted between `walk` and this read. A key vanishing
          // mid-listing is a legal outcome on a real object store, so skip
          // it rather than failing the whole iteration — and skip it
          // rather than locking, since `list` is a snapshot iterator, not
          // a critical section. Reachable in the maintenance fold, where
          // `runGc` deletes while the compactor walks the same prefixes.
          continue;
        }
        throw new BaerlyError(
          "InvalidResponse",
          `LocalFsStorage.list(${key}): ${(error as Error).message}`,
          error,
        );
      }
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
    // Shared Storage key grammar (non-empty, no `.`/`..` segments); the
    // FS-specific guards below add traversal/backslash/empty-segment checks.
    assertValidStorageKey(key);
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
    if (segments.some((s) => s.startsWith(TEMP_PREFIX))) {
      // `walk` skips this prefix so in-flight staging temps never surface
      // as keys, which means a *real* key here would be writable and
      // readable but invisible to `list` — a silent violation of the
      // put-then-list contract. Reserve the namespace rather than leave
      // the hole open; `tempPathFor` is the only legitimate producer.
      throw new BaerlyError(
        "InvalidConfig",
        `LocalFsStorage: key uses the reserved "${TEMP_PREFIX}" prefix: ${key}`,
      );
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
      // Skip the reserved staging namespace (see TEMP_PREFIX) so a
      // concurrent list during a write never surfaces a half-published
      // key. Applied to directories as well as files: `#pathFor` rejects
      // the prefix in ANY segment, so yielding `.baerly-tmp-d/child` here
      // would produce a key that `list` then throws on when it maps that
      // key back to a path. Nothing in this adapter creates such a
      // directory, but a stray one must not break iteration.
      if (entry.name.startsWith(TEMP_PREFIX)) {
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(relative(root, full).split(sep).join(posix.sep));
      }
    }
  }
};
