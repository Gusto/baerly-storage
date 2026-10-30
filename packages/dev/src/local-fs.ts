import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
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
import { decodeComponents, encodeKey } from "./local-fs-key-codec.ts";

/**
 * Prefix for the in-directory staging temps (see `put`). Dot-prefixed, so
 * it can never collide with an encoded key (see `local-fs-key-codec.ts`)
 * and `walk` skips it with every other adapter-private name.
 */
const TEMP_PREFIX = ".baerly-tmp-";

/**
 * Root marker recording the on-disk key encoding. Dot-prefixed, so it is
 * never a key. A directory without it is scanned once for names written
 * by the pre-encoding layout (see `#ensureFormat`).
 */
const FORMAT_MARKER = ".baerly-localfs.json";

/** Version of the key encoding in `local-fs-key-codec.ts`. */
const KEY_ENCODING = 1;

/** Legacy paths named in the refusal message before it truncates. */
const LEGACY_PATHS_SHOWN = 10;

/**
 * Staging path for a two-phase (write → publish) `put`. Always a sibling
 * of the destination: `rename(2)`/`link(2)` refuse to cross filesystems
 * (`EXDEV`), and the bucket root is routinely on a different volume from
 * `os.tmpdir()`. The leading `.` of `TEMP_PREFIX` is what makes staging
 * in-bucket safe — `walk` skips dot-prefixed names at every depth, and no
 * encoded key starts with one, so a crash before the publish leaves a file
 * invisible to `list` rather than a bogus key.
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
 * Keys are byte-exact, as on S3 and R2: keys that differ only by case or
 * Unicode normalization are distinct objects even on a filesystem that
 * folds both (default macOS APFS). Each segment is escaped into a
 * fold-invariant alphabet on disk — `A` is stored as `%41`, NFC `é` as
 * `%c3%a9` — while kernel-written segments (lowercase ids, base-32 index
 * values, `current.json`) are stored verbatim. See
 * `local-fs-key-codec.ts`.
 *
 * The root carries a `.baerly-localfs.json` marker naming that encoding.
 * A directory written by an older release, before keys were escaped, is
 * adopted as-is when every name in it already reads the same under the
 * encoding; otherwise every operation refuses with `InvalidConfig`.
 * Recover such a directory by dumping it with the older release
 * (`baerly admin dump`) and restoring into a fresh one (`baerly admin
 * restore`). Data a folding filesystem has already merged is not
 * recoverable.
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
 *
 * ⚠️ **Hard termination and temp files.**
 *
 * Writes stage a sibling `.baerly-tmp-*` file before atomic rename/link.
 * Normal failures clean up the temp in `finally`, but hard termination
 * (`SIGKILL`, OOM, power loss) can strand a temp inside the root directory.
 *
 * These files are hidden from `list`, `gc`, `fsck`, and usage reporting
 * by design—the temp filter applies at every depth.
 *
 * **Manual cleanup procedure:**
 * 1. Stop all writers using the root
 * 2. Run: `find <root> -name '.baerly-tmp-*' -delete`
 *
 * Do not clean while writes are in progress—races with in-flight PUTs
 * can delete a file that a concurrent operation is about to rename.
 */
export class LocalFsStorage implements Storage {
  readonly #root: string;
  /** Memoized `realpath` of {@link #root} — see {@link #canonicalRoot}. */
  #realRoot: string | undefined;
  /** Set once the root's key encoding is known to be current. */
  #formatChecked = false;

  constructor(opts: LocalFsStorageOptions) {
    this.#root = resolve(opts.root);
  }

  async get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> {
    opts?.signal?.throwIfAborted();
    const path = this.#pathFor(key);
    await this.#ensureFormat(false);
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
    await this.#ensureFormat(true);
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
      // bucket root, where only `walk`'s dot-name skip hides it. A
      // cleanup failure must not mask the error thrown above.
      await rm(tmp, { force: true }).catch(() => {});
    }
    return { etag: newEtag, serverDate: new Date() };
  }

  async delete(key: string, opts?: { signal?: AbortSignal }): Promise<void> {
    opts?.signal?.throwIfAborted();
    const path = this.#pathFor(key);
    await this.#ensureFormat(false);
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
   * Not on the root spelling the caller passed, because several spellings
   * of a root can name one directory, and handing an alias its own lock
   * lets the race straight back in:
   *
   * - Symlinks. `resolve()` collapses `.`/`..` but not links, so
   *   `/tmp/data` and `/private/tmp/data` — the same directory on every
   *   Mac — look like two (measured at 2 winners before it was closed).
   *   Hence `realpath`, memoized per instance and only cached once it
   *   succeeds, so a root that does not exist yet cannot poison the entry.
   * - Case and Unicode in the root path. A caller can spell a root on a
   *   folding filesystem as `/Users/me/Data` or `/users/me/data`, or in
   *   NFC or NFD, and reach one directory.
   *
   * The key-derived tail of `path` cannot alias: it is the fold-invariant
   * encoding from `local-fs-key-codec.ts`, so distinct keys are distinct
   * files on every filesystem and the case/NFC fold below changes nothing
   * there. The fold is kept for the root-spelling case only. It
   * over-approximates on a case-sensitive filesystem, where two roots
   * differing only in case are really different directories and share a
   * lock; that costs a little concurrency, never correctness. And it is
   * not exact Unicode case folding (JS has no `toCaseFold()`), so a root
   * spelled with `Σ` and one with `σ` get separate locks — acceptable for
   * a root path, which the operator chooses once.
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
   *
   * Only `ENOENT` falls back. Every other `realpath` failure — `EACCES`,
   * `ELOOP`, `ENAMETOOLONG` — throws, because the fallback is a *different
   * lock key*, and absorbing those would let an instance that cannot
   * canonicalize run unserialized against one that can. That is the
   * exactly-one-winner guarantee this lock exists to provide, failing
   * silently, which is indistinguishable from the defect it fixed. A root
   * that is unreadable is a broken deployment either way; the only choice
   * is whether it says so.
   *
   * Not caching failure bounds that to one call but does not erase it.
   * `put` mkdirs before locking so it always canonicalizes; `delete` does
   * not, so against a not-yet-created symlinked root it locks the
   * unresolved spelling while a concurrent `put` locks the resolved one —
   * two locks, no serialization. That needs only ONE spelling in play, not
   * two: the split is resolved-vs-unresolved form of the same path.
   *
   * Known and kept, not overlooked. The hazard `delete` locks
   * against is slipping inside an `ifMatch` compare→publish, which needs
   * the key to exist, hence the root to exist, hence `realpath` to have
   * succeeded — so both conditions hold only if the root appears between
   * this call and the `rm`, and the next call self-heals. Fixes cost more
   * than that: mkdir-to-get-a-lock-key makes deleting from an absent
   * bucket create it, and walking to the deepest existing ancestor adds
   * real complexity for an unreachable window.
   */
  async #canonicalRoot(): Promise<string> {
    if (this.#realRoot !== undefined) {
      return this.#realRoot;
    }
    try {
      this.#realRoot = await realpath(this.#root);
      return this.#realRoot;
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return this.#root;
      }
      throw new BaerlyError(
        "InvalidResponse",
        `LocalFsStorage: cannot canonicalize root (${this.#root}): ${(error as Error).message}`,
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
    await this.#ensureFormat(false);
    const keys: string[] = [];
    for (const components of (await walk(this.#root)) ?? []) {
      const key = decodeComponents(components);
      if (key !== null) {
        keys.push(key);
        continue;
      }
      // Not the canonical encoding of any key: a file this adapter did not
      // write (`notes~`, `100%zz`). Usually no `get`/`put`/`delete` can
      // address it either, so it is outside the keyspace and skipped rather
      // than failing every `list` over one stray file.
      //
      // Except on a folding filesystem, where a stray such as `c/%4A` or
      // `README.md` IS the file that `get("c/J")` / `get("readme.md")`
      // reads, and a `put` renames over it keeping the stray spelling.
      // Skipping it would hide a key that the other verbs see, so when the
      // case/NFC fold of the name decodes and resolves to this very file,
      // fail loudly instead. `InvalidConfig`, as the legacy-tree refusal is:
      // both mean the data directory holds files the operator must move.
      const alias = await this.#aliasedKey(components);
      if (alias !== null) {
        throw new BaerlyError(
          "InvalidConfig",
          `LocalFsStorage.list: ${join(this.#root, ...components)} was not written by this ` +
            `adapter but the filesystem resolves key ${JSON.stringify(alias)} to it; move the ` +
            `file out of the data directory`,
        );
      }
    }
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
   * The key whose on-disk path the filesystem resolves to the stray file at
   * `components`, or `null` if none does. Only a case- or
   * normalization-folding filesystem produces one: the candidate is
   * {@link foldToEncodedAlphabet} of the name, which is a key only if it
   * decodes, and an alias only if both paths name the same inode.
   */
  async #aliasedKey(components: readonly string[]): Promise<string | null> {
    const folded = components.map(foldToEncodedAlphabet);
    const key = decodeComponents(folded);
    if (key === null) {
      return null;
    }
    try {
      const [a, b] = await Promise.all([
        stat(join(this.#root, ...components)),
        stat(join(this.#root, ...folded)),
      ]);
      return a.dev === b.dev && a.ino === b.ino ? key : null;
    } catch (error) {
      // Either side vanished, or the fold names no file: ENOENT, or ENOTDIR
      // when the folded path runs through a key's file (`Notes/todo` beside
      // the key `notes` on a case-sensitive filesystem), or ENAMETOOLONG
      // should a fold ever lengthen a name. None is an alias.
      if (
        isErrnoException(error) &&
        (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ENAMETOOLONG")
      ) {
        return null;
      }
      throw new BaerlyError(
        "InvalidResponse",
        `LocalFsStorage.list: ${(error as Error).message}`,
        error,
      );
    }
  }

  /**
   * Make sure the root uses the current key encoding before any operation
   * touches it. With the marker present this is one small read per
   * instance. Without it the root is scanned once:
   *
   * - absent root: nothing to read, so reads return without stamping, and
   *   the first `put` (`create`) makes the root and stamps it;
   * - every on-disk name already reads the same under the encoding (true
   *   of kernel-written trees with lowercase ids): stamp, nothing moves;
   * - otherwise refuse with `InvalidConfig`. There is no in-place
   *   migration — renaming cannot undo merges a folding filesystem has
   *   already made — so the remedy is dump with the older release and
   *   restore into a fresh directory.
   *
   * Only success is cached, so a refusal repeats on every call.
   */
  async #ensureFormat(create: boolean): Promise<void> {
    if (this.#formatChecked) {
      return;
    }
    // Canonicalize first so a broken root (ELOOP, EACCES) reports as such —
    // see `#canonicalRoot` — rather than as a failed marker read.
    await this.#canonicalRoot();
    const marker = join(this.#root, FORMAT_MARKER);
    if (await readFormatMarker(marker)) {
      this.#formatChecked = true;
      return;
    }
    if (create) {
      await mkdir(this.#root, { recursive: true });
    }
    const legacy = await findLegacyPaths(this.#root);
    if (legacy === null) {
      return; // root absent and nothing to create
    }
    // Re-read before refusing: a concurrent opener may have stamped the
    // marker and written encoded names since this scan began.
    if (legacy.length > 0 && !(await readFormatMarker(marker))) {
      const shown = legacy.slice(0, LEGACY_PATHS_SHOWN).map((p) => `  ${p}`);
      if (legacy.length > LEGACY_PATHS_SHOWN) {
        shown.push(`  … and ${legacy.length - LEGACY_PATHS_SHOWN} more`);
      }
      throw new BaerlyError(
        "InvalidConfig",
        `LocalFsStorage: ${this.#root} has no ${FORMAT_MARKER} marker and holds paths that ` +
          `are not valid under the current key encoding:\n` +
          `${shown.join("\n")}\n` +
          `If a path is a stray file that is not data, move it out of the directory. ` +
          `Otherwise the directory was written by an older release that stored keys ` +
          `verbatim: dump it with that release (\`baerly admin dump\`) and restore into a ` +
          `fresh directory (\`baerly admin restore\`). Keys that differed only by case or ` +
          `Unicode normalization may already have been merged by the filesystem.`,
      );
    }
    await stampFormatMarker(marker);
    this.#formatChecked = true;
  }

  /**
   * Map an S3-style key to a filesystem path under `#root`, rejecting
   * anything that could escape the root (path traversal, absolute
   * paths, empty segments, backslashes) or that the encoding cannot
   * represent injectively (lone surrogates). All rejections throw
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
    const path = join(this.#root, ...encodeKey(key));
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
 * `true` when the root's format marker exists and names the current
 * encoding, `false` when it is absent. A marker naming another encoding
 * means a newer release wrote this directory, so it is refused.
 */
const readFormatMarker = async (marker: string): Promise<boolean> => {
  const body = await readExisting(marker).catch((error: unknown) => {
    throw new BaerlyError(
      "InvalidResponse",
      `LocalFsStorage: cannot read ${marker}: ${(error as Error).message}`,
      error,
    );
  });
  if (body === null) {
    return false;
  }
  let encoding: unknown;
  try {
    encoding = (JSON.parse(new TextDecoder().decode(body)) as { key_encoding?: unknown })
      .key_encoding;
  } catch (error) {
    throw new BaerlyError("InvalidResponse", `LocalFsStorage: ${marker} is not valid JSON`, error);
  }
  if (encoding !== KEY_ENCODING) {
    throw new BaerlyError(
      "InvalidConfig",
      `LocalFsStorage: ${marker} names key_encoding ${JSON.stringify(encoding)}; this release ` +
        `reads only key_encoding ${KEY_ENCODING}`,
    );
  }
  return true;
};

/**
 * Write the format marker with the same temp + `link(2)` exclusive create
 * as `ifNoneMatch:"*"`. Losing that race to a concurrent opener is fine as
 * long as what it wrote is the current encoding.
 */
const stampFormatMarker = async (marker: string): Promise<void> => {
  const tmp = tempPathFor(marker);
  try {
    await writeFile(tmp, `${JSON.stringify({ key_encoding: KEY_ENCODING })}\n`);
    await link(tmp, marker);
  } catch (error) {
    if (isErrnoException(error) && error.code === "EEXIST" && (await readFormatMarker(marker))) {
      return;
    }
    throw new BaerlyError(
      "InvalidResponse",
      `LocalFsStorage: cannot write ${marker}: ${(error as Error).message}`,
      error,
    );
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
};

/**
 * Non-ASCII characters that APFS's full case folding maps to ASCII but
 * `toLowerCase` leaves alone (Unicode CaseFolding.txt status `F`, plus the
 * `C` mapping of long `ſ`). Each was checked on an APFS volume: a file
 * named with the left side is reached by the right side.
 */
const APFS_ASCII_FOLDS: Readonly<Record<string, string>> = {
  ß: "ss", // U+00DF
  ẞ: "ss", // U+1E9E
  ſ: "s", // U+017F
  ﬀ: "ff", // U+FB00
  ﬁ: "fi", // U+FB01
  ﬂ: "fl", // U+FB02
  ﬃ: "ffi", // U+FB03
  ﬄ: "ffl", // U+FB04
  ﬅ: "st", // U+FB05
  ﬆ: "st", // U+FB06
};
const APFS_ASCII_FOLDABLE = /[ßẞſﬀ-ﬆ]/g;

/**
 * Fold an on-disk name the way a folding filesystem matches it, as far as
 * the result can land in the encoded alphabet (`a-z0-9-_.%`). A name
 * containing anything else after the fold cannot decode, so only folds to
 * ASCII matter: lowercase (which also maps Kelvin `K` to `k`) plus
 * {@link APFS_ASCII_FOLDS}. Normalization adds none: the only canonical
 * decompositions to ASCII are Kelvin `K`, U+037E (`;`) and U+1FEF (`` ` ``),
 * and the last two are escaped by the encoding.
 */
const foldToEncodedAlphabet = (name: string): string =>
  name.replace(APFS_ASCII_FOLDABLE, (c) => APFS_ASCII_FOLDS[c]!).toLowerCase();

/**
 * Paths under `root` that the pre-encoding layout wrote and the current
 * encoding would read differently (uppercase, non-ASCII, `%`, `~`, a
 * leading `.` …). Empty when the tree can be adopted as-is; `null` when
 * the root does not exist.
 *
 * Walks dot-prefixed names too: the old layout stored a key segment such
 * as an `_id` or collection named `.foo` verbatim, and the encoding treats
 * that name as adapter-private, so skipping it here would adopt the tree
 * and silently drop or orphan that data.
 */
const findLegacyPaths = async (root: string): Promise<string[] | null> => {
  const files = await walk(root, isLegacyScanNoise);
  if (files === null) {
    return null;
  }
  return files
    .filter((components) => decodeComponents(components) !== components.join("/"))
    .map((components) => components.join("/"))
    .toSorted();
};

/**
 * Entries the legacy scan may skip: staging temps (both layouts wrote them,
 * and the old one rejected keys with that prefix), and the files Finder
 * and git leave behind. Junk names are skipped as FILES only — a directory
 * called `.DS_Store` would be a legacy collection or tenant, i.e. data.
 * Nothing else is assumed not to be data.
 *
 * The format marker is deliberately not here. The scan runs only when the
 * marker was absent; if a concurrent opener stamps it mid-scan, the scan
 * flags it like any other name and `#ensureFormat`'s re-read of the marker
 * is what accepts the directory. A nested file with the marker's name is
 * legacy data (a key segment that old layout stored verbatim).
 */
const isLegacyScanNoise = (name: string, isDirectory: boolean): boolean =>
  name.startsWith(TEMP_PREFIX) || (!isDirectory && (name === ".DS_Store" || name === ".gitkeep"));

/**
 * In the current layout every dot-prefixed name is not a key: no encoded
 * key component starts with `.`, so those are adapter-private (staging
 * temps, the format marker) or foreign (`.DS_Store`). Skipping temps is
 * what keeps a concurrent `list` from surfacing a half-published key.
 */
const isDotName = (name: string, _isDirectory: boolean): boolean => name.startsWith(".");

/**
 * Recursive directory walk. Returns each file's path components relative
 * to `root`, or `null` when `root` does not exist. Entries for which
 * `skip` holds are ignored at every depth, directories included.
 */
const walk = async (
  root: string,
  skip: (name: string, isDirectory: boolean) => boolean = isDotName,
): Promise<string[][] | null> => {
  const out: string[][] = [];
  const stack: Array<{ dir: string; components: string[] }> = [{ dir: root, components: [] }];
  while (stack.length > 0) {
    const { dir, components } = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        if (dir === root) {
          return null;
        }
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      if (skip(entry.name, entry.isDirectory())) {
        continue;
      }
      const next = [...components, entry.name];
      if (entry.isDirectory()) {
        stack.push({ dir: join(dir, entry.name), components: next });
      } else if (entry.isFile()) {
        out.push(next);
      }
    }
  }
  return out;
};
