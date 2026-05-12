/**
 * `baerly copy` — cross-bucket snapshot copy.
 *
 * Walks the source bucket's manifest from a point-in-time cursor and
 * writes a parallel manifest at the target. The copy path bypasses
 * write-path compaction: it emits one L9 snapshot directly at the
 * target, skipping the per-entry `ServerWriter.commit` → fold →
 * re-snapshot round trip a naive replay would incur. The same
 * physical insight Turbopuffer uses for its `copy_from_namespace` 75%
 * write discount — the source already paid for the fold.
 *
 * Surface:
 *   - {@link runCopy} — top-level CLI entry; turns thrown
 *     `MPS3Error`s into integer exit codes.
 *   - {@link doCopy} — programmatic walker; throws on every failure
 *     path. Tests import this when they want explicit error
 *     assertions.
 *   - {@link parseBucketUri} — locked grammar:
 *     `s3://<bucket>[/<prefix>]`, `file:///<absolute-path>`,
 *     `memory://<bucket>`.
 *   - {@link parseCursor} — `<currentJsonKey>@<etag>` cursor format.
 */

import { LocalFsStorage } from "@baerly/dev";
import {
  CURRENT_JSON_SCHEMA_VERSION,
  MPS3Error,
  MemoryStorage,
  S3HttpStorage,
  createCurrentJson,
  getOrCreateMemoryStorageForBucket,
  logSeqStartOf,
  readCurrentJson,
  snapshotHash,
  type CurrentJson,
  type JSONArraylessObject,
  type LogEntry,
  type Storage,
} from "@baerly/protocol";
import {
  encodeSnapshotBody,
  loadSnapshotAsMap,
  snapshotKey,
  type SnapshotBody,
} from "@baerly/server";

// MemoryStorage is imported above for parseBucketUri's discriminator;
// the no-op reference here keeps it bundled into the type graph and
// silences the unused-import lint without weakening the public surface.
void MemoryStorage;

const COPY_OWNER = "baerly-copy";
const APPLICATION_JSON = "application/json";

/**
 * Result of `parseBucketUri`. `storage` is a constructed `Storage`
 * handle; `keyPrefix` is "" for an unprefixed bucket, or a non-empty
 * string ending in `/` for a prefixed one. The target side prepends
 * this to every emitted key.
 */
export interface ParsedBucketUri {
  storage: Storage;
  /** Empty for no-prefix; non-empty always ends with "/". */
  keyPrefix: string;
}

/**
 * Result of `parseCursor`. Identifies which `current.json` to copy
 * from and the ETag observed at cursor mint time. `doCopy` refuses if
 * the live `current.json` ETag has moved past `expectedEtag`.
 */
export interface ParsedCursor {
  currentJsonKey: string;
  expectedEtag: string;
}

/**
 * Parse a `baerly copy` bucket URI into a constructed `Storage`
 * handle + optional key prefix. Locked grammar:
 *
 *   bucket-uri ::= scheme "://" host-or-path
 *   scheme     ::= "s3" | "file" | "memory"
 *
 * - `s3://<bucket>[/<prefix>]` — S3-compatible HTTP. Creds via env
 *   vars (`BAERLY_S3_ENDPOINT`, `BAERLY_S3_ACCESS_KEY_ID`,
 *   `BAERLY_S3_SECRET_ACCESS_KEY`, `BAERLY_S3_REGION` — region
 *   defaults to `us-east-1`).
 * - `file:///<absolute-path>` — `LocalFsStorage` rooted at the path.
 *   Relative paths are rejected by the three-slash prefix.
 * - `memory://<bucket>` — `MemoryStorage` keyed via
 *   `getOrCreateMemoryStorageForBucket`, so source/target URIs in the
 *   same process share a backing store. Test-only.
 *
 * @throws MPS3Error code="InvalidConfig" — unsupported scheme, or an
 *   `s3://` URI with a missing env var.
 */
export const parseBucketUri = async (uri: string): Promise<ParsedBucketUri> => {
  if (uri.startsWith("s3://")) {
    const rest = uri.slice(5);
    const slash = rest.indexOf("/");
    const bucket = slash === -1 ? rest : rest.slice(0, slash);
    const prefix = slash === -1 ? "" : rest.slice(slash + 1);
    if (bucket.length === 0) {
      throw new MPS3Error(
        "InvalidConfig",
        `baerly copy: s3:// URI requires a bucket name (got ${JSON.stringify(uri)})`,
      );
    }
    const { AwsClient } = await import("aws4fetch");
    const { DOMParser } = await import("@xmldom/xmldom");
    const signer = new AwsClient({
      accessKeyId: requireEnv("BAERLY_S3_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("BAERLY_S3_SECRET_ACCESS_KEY"),
      region: process.env["BAERLY_S3_REGION"] ?? "us-east-1",
      service: "s3",
    });
    return {
      storage: new S3HttpStorage({
        endpoint: requireEnv("BAERLY_S3_ENDPOINT"),
        bucket,
        sign: (req) => signer.sign(req),
        xmlParser: new DOMParser(),
      }),
      keyPrefix: prefix === "" ? "" : prefix.endsWith("/") ? prefix : `${prefix}/`,
    };
  }
  if (uri.startsWith("file:///")) {
    return { storage: new LocalFsStorage({ root: uri.slice(7) }), keyPrefix: "" };
  }
  if (uri.startsWith("memory://")) {
    const bucket = uri.slice(9);
    if (bucket.length === 0) {
      throw new MPS3Error(
        "InvalidConfig",
        `baerly copy: memory:// URI requires a bucket name (got ${JSON.stringify(uri)})`,
      );
    }
    return { storage: getOrCreateMemoryStorageForBucket(bucket), keyPrefix: "" };
  }
  throw new MPS3Error("InvalidConfig", `baerly copy: unsupported URI ${JSON.stringify(uri)}`);
};

const requireEnv = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new MPS3Error("InvalidConfig", `baerly copy: env var ${name} unset`);
  }
  return v;
};

/**
 * Parse a `baerly copy` cursor of shape `<currentJsonKey>@<etag>`.
 *
 * This is the `baerly copy` CLI cursor format. Distinct from the HTTP
 * `_meta.manifest_pointer` returned by read responses (which is
 * `<snapshot>@<next_seq>` — a view-generation cursor; see
 * `HttpOkMeta` in `packages/server/src/contract.ts`). The two
 * objects describe different things:
 *
 *   - `manifest_pointer` is a *view generation* — "the bytes I read
 *     were a function of (snapshot, next_seq)" — and is the read
 *     response's freshness witness.
 *   - This cursor is a *which-current.json-at-which-version* anchor —
 *     "copy the collection whose `current.json` is at key K and whose
 *     live ETag is E" — and lets `doCopy` refuse a stale cursor.
 *
 * The `@` separator is chosen because S3 ETags are double-quoted
 * (e.g. `"abc..."`) and `@` does not appear in the Baerly key
 * alphabet, so `lastIndexOf("@")` cleanly splits the two halves.
 *
 * @throws MPS3Error code="InvalidConfig" — missing `@`, empty
 *   `currentJsonKey`, or empty `etag`.
 */
export const parseCursor = (cursor: string): ParsedCursor => {
  const at = cursor.lastIndexOf("@");
  if (at < 1 || at === cursor.length - 1) {
    throw new MPS3Error(
      "InvalidConfig",
      `baerly copy: cursor must be "<currentJsonKey>@<etag>", got ${JSON.stringify(cursor)}`,
    );
  }
  return { currentJsonKey: cursor.slice(0, at), expectedEtag: cursor.slice(at + 1) };
};

interface CopyArgs {
  from: string;
  fromSnapshot: string;
  to: string;
}

const parseArgs = (argv: readonly string[]): CopyArgs => {
  const out: Partial<CopyArgs> = {};
  for (const a of argv) {
    const eq = a.indexOf("=");
    if (!a.startsWith("--") || eq < 3) {
      throw new MPS3Error(
        "InvalidConfig",
        `baerly copy: expected --key=value, got ${JSON.stringify(a)}`,
      );
    }
    const k = a.slice(2, eq);
    const v = a.slice(eq + 1);
    if (k === "from") out.from = v;
    else if (k === "from-snapshot") out.fromSnapshot = v;
    else if (k === "to") out.to = v;
    else throw new MPS3Error("InvalidConfig", `baerly copy: unknown flag --${k}`);
  }
  if (out.from === undefined || out.fromSnapshot === undefined || out.to === undefined) {
    throw new MPS3Error(
      "InvalidConfig",
      "baerly copy: required flags --from, --from-snapshot, --to",
    );
  }
  return out as CopyArgs;
};

/**
 * CLI entry. Parses args, dispatches to `doCopy`, and translates
 * `MPS3Error.code` into the exit-code contract documented in
 * `baerly --help`:
 *
 *   - `0` — success
 *   - `1` — user error (`InvalidConfig`)
 *   - `2` — storage error (`NetworkError`, `AccessDenied`, anything
 *     non-`MPS3Error`)
 *   - `3` — protocol invariant (`Conflict`, `Internal`,
 *     `InvalidResponse`)
 *
 * Errors are written to stderr; stdout stays silent on success.
 *
 * @param argv Args AFTER the `copy` subcommand (i.e. everything after
 *   `argv[0]` in `baerly.ts`).
 */
export const runCopy = async (argv: readonly string[]): Promise<number> => {
  try {
    const args = parseArgs(argv);
    const src = await parseBucketUri(args.from);
    const dst = await parseBucketUri(args.to);
    const cursor = parseCursor(args.fromSnapshot);
    await doCopy(src, dst, cursor);
    return 0;
  } catch (err) {
    if (err instanceof MPS3Error) {
      process.stderr.write(`baerly copy: ${err.code}: ${err.message}\n`);
      if (err.code === "InvalidConfig") return 1;
      if (err.code === "Conflict" || err.code === "Internal" || err.code === "InvalidResponse") {
        return 3;
      }
      return 2;
    }
    process.stderr.write(`baerly copy: ${(err as Error).message}\n`);
    return 2;
  }
};

/**
 * Walk the source bucket's manifest from `cursor` and emit a parallel
 * manifest at the target. Single attempt — no CAS retry. Concurrent
 * source writers are caught by the cursor ETag check; a populated
 * target is caught by `createCurrentJson` (which uses
 * `If-None-Match: "*"`).
 *
 * Cost shape: `1 GET (current.json) + 1 GET (snapshot, if any) + N
 * GETs (live tail) + 1 PUT (target snapshot) + 1 PUT (target
 * current.json)`. Under the Phase-5 idle live-tail cap (~100 entries)
 * the snapshot dominates — roughly a 100× reduction over a naive
 * log-replay.
 *
 * @throws MPS3Error code="InvalidConfig" — source `current.json`
 *   missing at the cursor's key.
 * @throws MPS3Error code="Conflict" — source advanced past the
 *   cursor (live ETag ≠ expected ETag), OR the target is already
 *   populated (`createCurrentJson` lost its `If-None-Match: "*"`).
 * @throws MPS3Error code="Internal" — a log entry expected in
 *   `[log_seq_start, next_seq)` is missing on the source — protocol
 *   invariant violation.
 */
export const doCopy = async (
  src: ParsedBucketUri,
  dst: ParsedBucketUri,
  cursor: ParsedCursor,
): Promise<void> => {
  // 1. Read source current.json; refuse if ETag moved past cursor.
  const srcCur = await readCurrentJson(src.storage, cursor.currentJsonKey);
  if (srcCur === null) {
    throw new MPS3Error(
      "InvalidConfig",
      `baerly copy: source current.json not found at ${cursor.currentJsonKey}`,
    );
  }
  if (srcCur.etag !== cursor.expectedEtag) {
    throw new MPS3Error(
      "Conflict",
      `baerly copy: source advanced (cursor ${cursor.expectedEtag}, live ${srcCur.etag})`,
    );
  }

  // 2. Derive collection + table prefix from the current.json key.
  //    Shape: `<tablePrefix>/current.json`, where the last segment of
  //    `tablePrefix` is the collection name (see
  //    `physicalPrefixFor` in `packages/server/src/db.ts`).
  const lastSlash = cursor.currentJsonKey.lastIndexOf("/");
  if (lastSlash < 0) {
    throw new MPS3Error(
      "InvalidConfig",
      `baerly copy: cursor currentJsonKey ${JSON.stringify(cursor.currentJsonKey)} must contain "/"`,
    );
  }
  const tablePrefix = cursor.currentJsonKey.slice(0, lastSlash);
  const collection = tablePrefix.slice(tablePrefix.lastIndexOf("/") + 1);
  const logSeqStart = logSeqStartOf(srcCur.json);
  const nextSeq = srcCur.json.next_seq;

  // 3. Load source snapshot (if any) as the fold base.
  const base =
    srcCur.json.snapshot === null
      ? new Map<string, JSONArraylessObject>()
      : await loadSnapshotAsMap(src.storage, srcCur.json.snapshot, collection);

  // 4. Walk source live tail [logSeqStart, nextSeq) by integer seq —
  //    matches `compactor.ts:258`'s readLogEntry shape (the writer
  //    writes log entries at this path).
  const textDecoder = new TextDecoder();
  for (let s = logSeqStart; s < nextSeq; s++) {
    const logEntryKey = `${tablePrefix}/log/${s}.json`;
    const got = await src.storage.get(logEntryKey);
    if (got === null) {
      throw new MPS3Error("Internal", `baerly copy: missing log entry at ${logEntryKey}`);
    }
    let entry: LogEntry;
    try {
      entry = JSON.parse(textDecoder.decode(got.body)) as LogEntry;
    } catch (e) {
      throw new MPS3Error(
        "InvalidResponse",
        `baerly copy: log entry at ${logEntryKey} is not valid JSON`,
        e,
      );
    }
    if (entry.collection !== collection || entry.doc_id === undefined) continue;
    if ((entry.op === "I" || entry.op === "U") && entry.new !== undefined) {
      base.set(entry.doc_id, entry.new);
    } else if (entry.op === "D") {
      base.delete(entry.doc_id);
    }
    // T / M: no-ops; emitter never produces them today.
  }

  // 5. Build the target snapshot body using the SAME canonical
  //    encoding as the compactor — same fold ⇒ same bytes ⇒ same
  //    SHA-256 ⇒ same filename.
  const docs = Array.from(base.entries())
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, body]) => ({ _id: id, body }));
  const body: SnapshotBody = {
    schema_version: 1,
    min_seq: 0,
    max_seq: nextSeq,
    collection,
    docs,
  };
  const bytes = encodeSnapshotBody(body);
  const sha256 = await snapshotHash(bytes);

  // 6. Target snapshot key under dst.keyPrefix.
  const dstSnapKey = snapshotKey(`${dst.keyPrefix}${tablePrefix}`, 0, nextSeq, sha256);

  // 7. PUT the snapshot. Idempotent — same body bytes ⇒ same key.
  await dst.storage.put(dstSnapKey, bytes, { contentType: APPLICATION_JSON });

  // 8. Seed target current.json. createCurrentJson uses
  //    `If-None-Match: "*"`, so a second copy onto a populated target
  //    throws Conflict → exit 3.
  const dstCurKey = `${dst.keyPrefix}${cursor.currentJsonKey}`;
  const seeded: CurrentJson = {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: dstSnapKey,
    next_seq: nextSeq,
    // History fully folded; reader walks zero live entries and no
    // follow-up compaction is needed.
    log_seq_start: nextSeq,
    writer_fence: { epoch: 0, owner: COPY_OWNER, claimed_at: "" },
  };
  await createCurrentJson(dst.storage, dstCurKey, seeded);
};
