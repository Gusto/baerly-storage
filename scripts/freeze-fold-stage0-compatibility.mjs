#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const CAPTURE_SPECS = [
  ["snapshot/legacy-ascii.json", "snapshot"],
  ["snapshot/legacy-utf16-random-distinct.json", "snapshot"],
  ["snapshot/legacy-unmarked-organ-pipe-mixed.json", "snapshot"],
  ["snapshot/legacy-duplicate-rows.json", "snapshot"],
  ["snapshot/malformed-scalar-escape.json", "snapshot"],
  ["snapshot/identity-divergent.json", "snapshot"],
  ["log/insert.json", "log"],
  ["log/update.json", "log"],
  ["log/delete.json", "log"],
  ["log/malformed-scalar-escape.json", "log"],
  ["log/identity-divergent.json", "log"],
  ["log/malformed-lsn.json", "log"],
  ["log/session-divergent.json", "log"],
  ["log/sequence-divergent.json", "log"],
  ["log/key-body-sequence-divergent.json", "log"],
  ["current/fresh-zero.json", "current-json"],
  ["current/snapshotted.json", "current-json"],
  ["current/null-snapshot-positive-floor.json", "current-json"],
  ["current/high-floor-no-old-logs.json", "current-json"],
  ["current/rollback-roll-forward.json", "current-json"],
  ["restore/canonical.ndjson", "restore"],
  ["restore/malformed-scalar.ndjson", "restore"],
  ["restore/duplicate-ids.ndjson", "restore"],
  ["restore/missing-id.ndjson", "restore"],
  ["restore/identity-divergent.ndjson", "restore"],
  ["dump/mixed-unicode.ndjson", "dump"],
  ["export/mixed-unicode-sqlite.sql", "export"],
  ["export/mixed-unicode-postgres.sql", "export"],
  ["export/mixed-unicode-d1.sql", "export"],
  ["mixed-version/b-reads-marked.snapshot.json", "mixed-version"],
  ["mixed-version/stage0-reads-unmarked.snapshot.json", "mixed-version"],
];

export const EXPECTED_CAPTURE_PATHS = Object.freeze(CAPTURE_SPECS.map(([path]) => path));

const EXPECTED_CONTRACT_BY_PATH = new Map(CAPTURE_SPECS);

function compareAscii(a, b) {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/** Lowercase hex SHA-256 of raw bytes. Never parses or reserializes. */
export function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A manifest path must be POSIX-separated, relative, and contained.
 * Rejects absolute paths, backslashes, `.`/`..` segments, and empty segments.
 */
export function assertCorpusRelativePath(path) {
  const ok =
    typeof path === "string" &&
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !/(^|\/)\.\.?(\/|$)/.test(path) &&
    !path.includes("//");
  if (!ok) {
    throw new Error(
      `freeze:fold-stage0: ${JSON.stringify(path)} is not a contained corpus-relative POSIX path`,
    );
  }
}

export function assertNoDuplicatePaths(files) {
  const seen = new Set();
  for (const f of files) {
    if (seen.has(f.path)) {
      throw new Error(`freeze:fold-stage0: duplicate manifest path ${f.path}`);
    }
    seen.add(f.path);
  }
}

export function buildManifest({ frozenSubjectCommit, captureToolSha256, packageVersion, files }) {
  for (const f of files) {
    assertCorpusRelativePath(f.path);
  }
  assertNoDuplicatePaths(files);
  return {
    schema: "baerly.fold-stage0-compatibility/v1",
    frozen_subject_commit: frozenSubjectCommit,
    capture_tool_sha256: captureToolSha256,
    package_version: packageVersion,
    files: [...files].toSorted((a, b) => compareAscii(a.path, b.path)),
  };
}

export function assertCleanSubjectWorktree(porcelainStatus) {
  if (porcelainStatus.trim() !== "") {
    throw new Error(
      `freeze:fold-stage0: subject worktree is dirty; refusing to capture:\n${porcelainStatus}`,
    );
  }
}

export function assertSubjectCommitMatches(requested, actual) {
  if (requested !== actual) {
    throw new Error(
      `freeze:fold-stage0: subject HEAD ${actual} does not match requested ${requested}`,
    );
  }
}

export function assertSubjectWorktreeState({
  requestedCommit,
  actualCommit,
  branchName,
  subjectWorktree,
  implementationWorktree,
}) {
  if (!/^[0-9a-f]{40}$/.test(requestedCommit)) {
    throw new Error(
      "freeze:fold-stage0: --subject-commit must be a lowercase full 40-hex commit SHA",
    );
  }
  assertSubjectCommitMatches(requestedCommit, actualCommit);
  if (branchName !== "") {
    throw new Error(
      `freeze:fold-stage0: subject HEAD must be detached; found attached branch ${branchName}`,
    );
  }
  if (realpathSync(subjectWorktree) === realpathSync(implementationWorktree)) {
    throw new Error(
      "freeze:fold-stage0: subject worktree must be physically distinct from the implementation checkout",
    );
  }
}

/**
 * Strips stale-dist reuse flags from the environment handed to every
 * subprocess of a capture. Nothing in the current capture path builds, so this
 * is forward-looking: a capture must never inherit a caller's opt-out from a
 * rebuild, because the payload bytes would then describe a stale tree.
 */
export function sanitizeCaptureEnvironment(environment) {
  const sanitized = { ...environment };
  delete sanitized.BAERLY_SKIP_BUILD;
  return sanitized;
}

export function assertOutputDirectoryEmpty(dir) {
  if (!existsSync(dir)) {
    return;
  }
  const entries = readdirSync(dir);
  if (entries.length > 0) {
    throw new Error(
      `freeze:fold-stage0: ${dir} is not empty; refusing to overwrite a frozen corpus. ` +
        `A superseding capture gets a new directory — never regenerate this one in place.`,
    );
  }
}

export function assertOutputRootContained(fixtureRoot, outputRoot) {
  const rel = relative(resolve(fixtureRoot), resolve(outputRoot));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(
      `freeze:fold-stage0: output ${outputRoot} is outside the fixture root ${fixtureRoot}`,
    );
  }
}

function assertNoSymlinkComponents(root, target) {
  const base = resolve(root);
  const absoluteTarget = resolve(target);
  assertOutputRootContained(dirname(base), absoluteTarget);
  const rel = relative(base, absoluteTarget);
  let cursor = base;
  if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
    throw new Error(`freeze:fold-stage0: refusing symlink output root ${cursor}`);
  }
  for (const segment of rel.split(sep)) {
    cursor = join(cursor, segment);
    try {
      if (lstatSync(cursor).isSymbolicLink()) {
        throw new Error(`freeze:fold-stage0: refusing symlink output component ${cursor}`);
      }
    } catch (error) {
      if (error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
}

function ensureSafeDirectories(root, relPath) {
  mkdirSync(root, { recursive: true });
  if (lstatSync(root).isSymbolicLink()) {
    throw new Error(`freeze:fold-stage0: refusing symlink output root ${root}`);
  }
  let cursor = root;
  for (const segment of dirname(relPath).split("/")) {
    if (segment === ".") {
      continue;
    }
    cursor = join(cursor, segment);
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`freeze:fold-stage0: refusing non-directory output component ${cursor}`);
      }
    } catch (error) {
      if (!error || error.code !== "ENOENT") {
        throw error;
      }
      mkdirSync(cursor);
    }
  }
}

export function writePayloadExclusive(root, relPath, bytes) {
  assertCorpusRelativePath(relPath);
  ensureSafeDirectories(root, relPath);
  const target = join(root, ...relPath.split("/"));
  try {
    writeFileSync(target, bytes, { flag: "wx" });
  } catch (error) {
    throw new Error(
      `freeze:fold-stage0: refusing to overwrite or follow a symlink at ${target}: ${error.message}`,
      { cause: error },
    );
  }
}

export function assertCaptureIndex(files) {
  assertNoDuplicatePaths(files);
  if (files.length !== CAPTURE_SPECS.length) {
    throw new Error(
      `freeze:fold-stage0: capture child returned ${files.length} payloads; ` +
        `expected ${CAPTURE_SPECS.length}`,
    );
  }
  const got = new Map(files.map((file) => [file.path, file]));
  for (const [path, contract] of CAPTURE_SPECS) {
    const file = got.get(path);
    if (file === undefined) {
      throw new Error(`freeze:fold-stage0: capture child is missing required payload ${path}`);
    }
    assertCorpusRelativePath(file.path);
    if (file.contract !== contract) {
      throw new Error(
        `freeze:fold-stage0: ${path} has contract ${file.contract}; expected ${contract}`,
      );
    }
    if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0) {
      throw new Error(`freeze:fold-stage0: ${path} has invalid byte length ${file.bytes}`);
    }
    if (!/^[0-9a-f]{64}$/.test(file.sha256)) {
      throw new Error(`freeze:fold-stage0: ${path} has invalid sha256 ${file.sha256}`);
    }
  }
}

export function readCapturedPayloads(childRoot, files) {
  assertCaptureIndex(files);
  return files.map((binding) => {
    const file = join(childRoot, ...binding.path.split("/"));
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`freeze:fold-stage0: capture child returned non-regular file ${file}`);
    }
    const bytes = readFileSync(file);
    if (bytes.byteLength !== binding.bytes) {
      throw new Error(
        `freeze:fold-stage0: stale byte length for ${binding.path}: ` +
          `${bytes.byteLength} does not match ${binding.bytes}`,
      );
    }
    const actualHash = hashBytes(bytes);
    if (actualHash !== binding.sha256) {
      throw new Error(
        `freeze:fold-stage0: stale sha256 for ${binding.path}: ` +
          `${actualHash} does not match ${binding.sha256}`,
      );
    }
    return { binding, bytes };
  });
}

function parseOptions(argv, allowed) {
  const options = new Map();
  for (const arg of argv) {
    if (arg === "--capture-child") {
      continue;
    }
    const match = /^--([^=]+)=(.*)$/s.exec(arg);
    if (match === null || !allowed.has(match[1])) {
      throw new Error(`freeze:fold-stage0: unknown argument ${arg}`);
    }
    if (options.has(match[1])) {
      throw new Error(`freeze:fold-stage0: duplicate --${match[1]}`);
    }
    options.set(match[1], match[2]);
  }
  return options;
}

function requireOption(options, name) {
  const value = options.get(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`freeze:fold-stage0: required --${name}=... was not supplied`);
  }
  return value;
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: options.encoding,
    stdio: options.stdio ?? "inherit",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `freeze:fold-stage0: command failed (${result.status ?? "signal"}): ${command} ${args.join(" ")}`,
    );
  }
  return result;
}

function gitText(subject, args) {
  const result = runChecked("git", ["-c", "core.fsmonitor=false", "-C", subject, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return result.stdout;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

export function buildCaptureProvenanceBytes({
  frozenSubjectCommit,
  captureToolPath,
  captureToolSha256,
  rootPackageVersion,
  lockfileSha256,
  nodeVersion,
  pnpmVersion,
}) {
  return jsonBytes({
    schema: "baerly.fold-stage0-capture-provenance/v1",
    frozen_subject_commit: frozenSubjectCommit,
    capture_tool_path: captureToolPath,
    capture_tool_sha256: captureToolSha256,
    root_package_version: rootPackageVersion,
    lockfile_sha256: lockfileSha256,
    node_version: nodeVersion,
    pnpm_version: pnpmVersion,
  });
}

export function writeCaptureProvenanceExclusive(path, bytes) {
  try {
    writeFileSync(path, bytes, { flag: "wx" });
  } catch (error) {
    throw new Error(
      `freeze:fold-stage0: refusing to overwrite provenance output ${path}: ${error.message}`,
      { cause: error },
    );
  }
}

export function buildCaptureSuccessResult({
  capturedAtUtc,
  manifestBytes,
  corpusFileCount,
  frozenSubjectCommit,
  provenanceBytes,
}) {
  return {
    captured_at_utc: capturedAtUtc,
    corpus_manifest_sha256: hashBytes(manifestBytes),
    corpus_file_count: corpusFileCount,
    frozen_subject_commit: frozenSubjectCommit,
    capture_provenance_sha256: hashBytes(provenanceBytes),
  };
}

function importFromSubject(subject, path) {
  return import(pathToFileURL(join(subject, path)).href);
}

async function withDeterministicUuid(fn) {
  const cryptoObject = globalThis.crypto;
  const original = cryptoObject.randomUUID;
  let counter = 0;
  Object.defineProperty(cryptoObject, "randomUUID", {
    configurable: true,
    value: () => {
      counter += 1;
      return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
    },
  });
  try {
    return await fn();
  } finally {
    Object.defineProperty(cryptoObject, "randomUUID", {
      configurable: true,
      value: original,
    });
  }
}

async function withMutedProcessWrites(fn) {
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    return await fn();
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

function captureWritable() {
  const chunks = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
    bytes: () => Buffer.concat(chunks),
  };
}

function snapshotBody(protocol, docs, extra = {}) {
  return {
    schema_version: protocol.SNAPSHOT_SCHEMA_VERSION,
    min_seq: 0,
    max_seq: docs.length,
    collection: "tickets",
    docs,
    ...extra,
  };
}

const restoreArgs = (bucket, extra = []) => [
  `--bucket=${bucket}`,
  "--app=app",
  "--tenant=tenant",
  "--collection=tickets",
  ...extra,
];

async function captureProtocolPayloads(subject, emit) {
  const protocol = await importFromSubject(subject, "packages/protocol/src/index.ts");
  const snapshots = await importFromSubject(subject, "packages/server/src/snapshot.ts");
  const logWalk = await importFromSubject(subject, "packages/server/src/log-walk.ts");
  const { runRestore } = await importFromSubject(subject, "packages/cli/src/admin/restore.ts");
  const { runDump } = await importFromSubject(subject, "packages/cli/src/admin/dump.ts");
  const exporters = await importFromSubject(subject, "packages/cli/src/export/index.ts");
  const { parseBucketUri } = await importFromSubject(subject, "packages/cli/src/bucket-uri.ts");

  const snapshotValues = new Map([
    [
      "snapshot/legacy-ascii.json",
      snapshotBody(protocol, [
        { _id: "a", body: { _id: "a", rank: 1 } },
        { _id: "z", body: { _id: "z", rank: 2 } },
      ]),
    ],
    [
      "snapshot/legacy-utf16-random-distinct.json",
      snapshotBody(protocol, [
        { _id: "\u{10000}", body: { _id: "\u{10000}", order: "utf16-first" } },
        { _id: "\ufffd", body: { _id: "\ufffd", order: "scalar-first" } },
      ]),
    ],
    [
      "snapshot/legacy-unmarked-organ-pipe-mixed.json",
      snapshotBody(protocol, [
        { _id: "a", body: { _id: "a", side: "left" } },
        { _id: "\ufffd", body: { _id: "\ufffd", side: "inner-left" } },
        { _id: "\u{10000}", body: { _id: "\u{10000}", side: "inner-right" } },
        { _id: "z", body: { _id: "z", side: "right" } },
      ]),
    ],
    [
      "snapshot/legacy-duplicate-rows.json",
      snapshotBody(protocol, [
        { _id: "duplicate", body: { _id: "duplicate", revision: 1 } },
        { _id: "duplicate", body: { _id: "duplicate", revision: 2 } },
      ]),
    ],
    [
      "snapshot/malformed-scalar-escape.json",
      snapshotBody(protocol, [{ _id: "\ud800", body: { _id: "\ud800", note: "lone-high" } }]),
    ],
    [
      "snapshot/identity-divergent.json",
      snapshotBody(protocol, [
        { _id: "row-key", body: { _id: "body-key", note: "legacy divergence" } },
      ]),
    ],
  ]);

  for (const [path, body] of snapshotValues) {
    const bytes = snapshots.encodeSnapshotBody(body);
    emit(path, "snapshot", bytes);
    const storage = new protocol.MemoryStorage();
    const key = snapshots.snapshotKey("capture/tickets", 0, body.max_seq, hashBytes(bytes));
    await storage.put(key, bytes, { contentType: "application/json" });
    await snapshots.loadSnapshotAsMap(storage, key, "tickets");
  }

  const markedBody = snapshotBody(
    protocol,
    [{ _id: "marked", body: { _id: "marked", value: 1 } }],
    { id_collation: "utf8-scalar-v1", range_provenance: { min_seq: 0, max_seq: 1 } },
  );
  const unmarkedBody = snapshotBody(protocol, [
    { _id: "\u{10000}", body: { _id: "\u{10000}", value: "astral" } },
    { _id: "\ufffd", body: { _id: "\ufffd", value: "bmp" } },
  ]);
  for (const [path, body] of [
    ["mixed-version/b-reads-marked.snapshot.json", markedBody],
    ["mixed-version/stage0-reads-unmarked.snapshot.json", unmarkedBody],
  ]) {
    const bytes = snapshots.encodeSnapshotBody(body);
    emit(path, "mixed-version", bytes);
    const storage = new protocol.MemoryStorage();
    const key = snapshots.snapshotKey("capture/mixed", 0, body.max_seq, hashBytes(bytes));
    await storage.put(key, bytes, { contentType: "application/json" });
    await snapshots.loadSnapshotAsMap(storage, key, "tickets");
  }

  const baseLog = {
    commit_ts: "2026-08-01T00:00:00.000Z",
    collection: "tickets",
    session: "capture",
  };
  const lsnTimestamp = protocol.timestamp(Date.parse(baseLog.commit_ts));
  const mintedLsn = (seq, session = baseLog.session) =>
    `${lsnTimestamp}_${session}_${protocol.countKey(seq)}`;
  const logValues = new Map([
    [
      "log/insert.json",
      {
        ...baseLog,
        lsn: mintedLsn(0),
        seq: 0,
        op: "I",
        doc_id: "row",
        after: { _id: "row", n: 1 },
      },
    ],
    [
      "log/update.json",
      {
        ...baseLog,
        lsn: mintedLsn(1),
        seq: 1,
        op: "U",
        doc_id: "row",
        after: { _id: "row", n: 2 },
      },
    ],
    ["log/delete.json", { ...baseLog, lsn: mintedLsn(2), seq: 2, op: "D", doc_id: "row" }],
    [
      "log/malformed-scalar-escape.json",
      {
        ...baseLog,
        lsn: mintedLsn(3),
        seq: 3,
        op: "I",
        doc_id: "\ud800",
        after: { _id: "\ud800" },
      },
    ],
    [
      "log/identity-divergent.json",
      {
        ...baseLog,
        lsn: mintedLsn(4),
        seq: 4,
        op: "I",
        doc_id: "row-key",
        after: { _id: "body-key" },
      },
    ],
    [
      "log/malformed-lsn.json",
      {
        ...baseLog,
        lsn: "not-an-lsn",
        seq: 5,
        op: "I",
        doc_id: "bad-lsn",
        after: { _id: "bad-lsn" },
      },
    ],
    [
      "log/session-divergent.json",
      {
        ...baseLog,
        lsn: mintedLsn(6, "wire"),
        seq: 6,
        op: "I",
        doc_id: "session",
        after: { _id: "session" },
      },
    ],
    [
      "log/sequence-divergent.json",
      {
        ...baseLog,
        lsn: mintedLsn(0),
        seq: 7,
        op: "I",
        doc_id: "sequence",
        after: { _id: "sequence" },
      },
    ],
    [
      "log/key-body-sequence-divergent.json",
      {
        ...baseLog,
        lsn: mintedLsn(8),
        seq: 8,
        op: "I",
        doc_id: "key-body",
        after: { _id: "key-body" },
      },
    ],
  ]);
  const logStorage = new protocol.MemoryStorage();
  for (const [path, entry] of logValues) {
    const bytes = protocol.encodeJsonBytes(entry);
    emit(path, "log", bytes);
    await logStorage.put(protocol.logObjectKey("capture/tickets", entry.seq), bytes, {
      contentType: "application/json",
    });
    await logWalk.readLogEntry(logStorage, protocol.logObjectKey("capture/tickets", entry.seq));
  }
  await logWalk.walkLogRange(logStorage, "capture/tickets", 0, 9);
  await logWalk.walkLogRangeWithBytes(logStorage, "capture/tickets", 0, 9);
  protocol.lsnParts(logValues.get("log/insert.json").lsn);
  try {
    protocol.lsnParts(logValues.get("log/malformed-lsn.json").lsn);
    throw new Error("freeze:fold-stage0: malformed LSN unexpectedly parsed");
  } catch (error) {
    if (error.message === "freeze:fold-stage0: malformed LSN unexpectedly parsed") {
      throw error;
    }
  }

  const restoreInputs = new Map([
    [
      "restore/canonical.ndjson",
      '{"_id":"a","label":"ascii","rank":1}\n' +
        '{"_id":"\ufffd","label":"bmp","rank":2}\n' +
        '{"_id":"\u{10000}","label":"astral","rank":3}\n',
    ],
    ["restore/malformed-scalar.ndjson", '{"_id":"\\ud800","note":"lone-high"}\n'],
    ["restore/duplicate-ids.ndjson", '{"_id":"duplicate","n":1}\n{"_id":"duplicate","n":2}\n'],
    ["restore/missing-id.ndjson", '{"note":"missing id"}\n'],
  ]);
  for (const [path, input] of restoreInputs) {
    emit(path, "restore", Buffer.from(input));
  }

  const runRestoreInput = (bucket, input, extra = []) =>
    withMutedProcessWrites(() =>
      runRestore(restoreArgs(bucket, extra), {
        streams: { stdin: Readable.from([Buffer.from(input)]) },
      }),
    );

  await withDeterministicUuid(async () => {
    const freshBucket = "memory://fold-stage0-fresh-zero";
    if ((await runRestoreInput(freshBucket, "")) !== 0) {
      throw new Error("freeze:fold-stage0: fresh-zero restore failed");
    }
    const parsedFreshBucket = await parseBucketUri(freshBucket);
    const freshStorage = parsedFreshBucket.storage;
    const currentKey = "app/app/tenant/tenant/manifests/tickets/current.json";
    const fresh = await freshStorage.get(currentKey);
    emit("current/fresh-zero.json", "current-json", fresh.body);
    await protocol.readCurrentJson(freshStorage, currentKey);

    const positiveBucket = "memory://fold-stage0-positive-floor";
    if (
      (await runRestoreInput(positiveBucket, restoreInputs.get("restore/canonical.ndjson"))) !== 0
    ) {
      throw new Error("freeze:fold-stage0: positive-floor seed restore failed");
    }
    if ((await runRestoreInput(positiveBucket, "", ["--force"])) !== 0) {
      throw new Error("freeze:fold-stage0: positive-floor force restore failed");
    }
    const parsedPositiveBucket = await parseBucketUri(positiveBucket);
    const positiveStorage = parsedPositiveBucket.storage;
    const positive = await positiveStorage.get(currentKey);
    emit("current/null-snapshot-positive-floor.json", "current-json", positive.body);
    await protocol.readCurrentJson(positiveStorage, currentKey);

    const divergentRestorePath = "restore/identity-divergent.ndjson";
    const divergentBucket = "memory://fold-stage0-identity-divergent-dump";
    const parsedDivergentBucket = await parseBucketUri(divergentBucket);
    const divergentSnapshotBytes = snapshots.encodeSnapshotBody(
      snapshotValues.get("snapshot/identity-divergent.json"),
    );
    const divergentPrefix = currentKey.slice(0, currentKey.lastIndexOf("/"));
    const divergentSnapshotKey = snapshots.snapshotKey(
      divergentPrefix,
      0,
      1,
      hashBytes(divergentSnapshotBytes),
    );
    await parsedDivergentBucket.storage.put(divergentSnapshotKey, divergentSnapshotBytes, {
      contentType: "application/json",
    });
    await protocol.createCurrentJson(parsedDivergentBucket.storage, currentKey, {
      schema_version: protocol.CURRENT_JSON_SCHEMA_VERSION,
      snapshot: divergentSnapshotKey,
      tail_hint: 1,
      log_seq_start: 1,
      writer_fence: { epoch: 0, owner: "capture", claimed_at: "" },
      snapshot_bytes: divergentSnapshotBytes.byteLength,
      snapshot_rows: 1,
      generation: "000000000001",
    });
    const divergentLegacyView = await exporters.loadMaterialisedView({
      storage: parsedDivergentBucket.storage,
      currentJsonKey: currentKey,
      collection: "tickets",
    });
    if (divergentLegacyView?.get("row-key")?._id !== "body-key") {
      throw new Error(
        "freeze:fold-stage0: legacy divergent snapshot did not preserve row/body identity divergence",
      );
    }
    const divergentSink = captureWritable();
    const divergentDumpCode = await withMutedProcessWrites(() =>
      runDump(restoreArgs(divergentBucket), { streams: { stdout: divergentSink.stream } }),
    );
    if (divergentDumpCode !== 0) {
      throw new Error(
        `freeze:fold-stage0: divergent identity runDump returned ${divergentDumpCode}`,
      );
    }
    const divergentRestoreBytes = divergentSink.bytes();
    restoreInputs.set(divergentRestorePath, divergentRestoreBytes);
    emit(divergentRestorePath, "restore", divergentRestoreBytes);

    const divergentRestoredBucket = "memory://fold-stage0-identity-divergent-restored";
    if ((await runRestoreInput(divergentRestoredBucket, divergentRestoreBytes)) !== 0) {
      throw new Error("freeze:fold-stage0: divergent identity runRestore failed");
    }
    const parsedDivergentRestored = await parseBucketUri(divergentRestoredBucket);
    const divergentRestoredView = await exporters.loadMaterialisedView({
      storage: parsedDivergentRestored.storage,
      currentJsonKey: currentKey,
      collection: "tickets",
    });
    const remapped = divergentRestoredView?.get("row-key");
    if (
      remapped?._id !== "row-key" ||
      remapped.note !== "legacy divergence" ||
      Object.hasOwn(remapped, "body")
    ) {
      throw new Error(
        "freeze:fold-stage0: divergent identity dump/restore did not collapse to row identity",
      );
    }

    for (const [path, input] of restoreInputs) {
      const bucket = `memory://fold-stage0-${path.replaceAll(/[^a-z0-9]+/g, "-")}`;
      const code = await runRestoreInput(bucket, input);
      const expected = path === "restore/missing-id.ndjson" ? 2 : 0;
      if (code !== expected) {
        throw new Error(
          `freeze:fold-stage0: ${path} returned restore code ${code}; expected ${expected}`,
        );
      }
    }

    const dumpBucket = "memory://fold-stage0-dump";
    if ((await runRestoreInput(dumpBucket, restoreInputs.get("restore/canonical.ndjson"))) !== 0) {
      throw new Error("freeze:fold-stage0: dump seed restore failed");
    }
    const sink = captureWritable();
    const dumpCode = await withMutedProcessWrites(() =>
      runDump(restoreArgs(dumpBucket), { streams: { stdout: sink.stream } }),
    );
    if (dumpCode !== 0) {
      throw new Error(`freeze:fold-stage0: runDump returned ${dumpCode}`);
    }
    emit("dump/mixed-unicode.ndjson", "dump", sink.bytes());
  });

  const snapshottedStorage = new protocol.MemoryStorage();
  const currentKey = "capture/tickets/current.json";
  const asciiBytes = snapshots.encodeSnapshotBody(snapshotValues.get("snapshot/legacy-ascii.json"));
  const asciiSnapshotKey = snapshots.snapshotKey("capture/tickets", 0, 2, hashBytes(asciiBytes));
  await snapshottedStorage.put(asciiSnapshotKey, asciiBytes, { contentType: "application/json" });
  await protocol.createCurrentJson(snapshottedStorage, currentKey, {
    schema_version: protocol.CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    tail_hint: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "capture", claimed_at: "" },
    snapshot_bytes: 0,
    snapshot_rows: 0,
    generation: "000000000001",
  });
  await protocol.casUpdateCurrentJson(snapshottedStorage, currentKey, (current) => ({
    ...current,
    snapshot: asciiSnapshotKey,
    tail_hint: 2,
    log_seq_start: 2,
    snapshot_bytes: asciiBytes.byteLength,
    snapshot_rows: 2,
  }));
  const snapshottedCurrent = await snapshottedStorage.get(currentKey);
  emit("current/snapshotted.json", "current-json", snapshottedCurrent.body);

  const highFloorStorage = new protocol.MemoryStorage();
  await protocol.createCurrentJson(highFloorStorage, currentKey, {
    schema_version: protocol.CURRENT_JSON_SCHEMA_VERSION,
    snapshot: asciiSnapshotKey,
    tail_hint: 9,
    log_seq_start: 9,
    writer_fence: { epoch: 3, owner: "capture", claimed_at: "" },
    snapshot_bytes: asciiBytes.byteLength,
    snapshot_rows: 2,
    generation: "000000000002",
  });
  const highFloorCurrent = await highFloorStorage.get(currentKey);
  emit("current/high-floor-no-old-logs.json", "current-json", highFloorCurrent.body);

  const rollbackStorage = new protocol.MemoryStorage();
  await protocol.createCurrentJson(rollbackStorage, currentKey, {
    schema_version: protocol.CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    tail_hint: 4,
    log_seq_start: 0,
    writer_fence: { epoch: 1, owner: "pre-lifecycle", claimed_at: "" },
    snapshot_bytes: 0,
    snapshot_rows: 0,
    generation: "000000000003",
  });
  await protocol.casUpdateCurrentJson(rollbackStorage, currentKey, (current) => ({
    ...current,
    tail_hint: 6,
  }));
  const rollbackCurrent = await rollbackStorage.get(currentKey);
  emit("current/rollback-roll-forward.json", "current-json", rollbackCurrent.body);

  const exportRows = new Map([
    ["a", { _id: "a", label: "ascii", active: true, score: 1 }],
    ["\ufffd", { _id: "\ufffd", label: "bmp", active: false, score: 2 }],
    ["\u{10000}", { _id: "\u{10000}", label: "astral", active: true, score: 3 }],
  ]);
  for (const target of ["sqlite", "postgres", "d1"]) {
    const plan = exporters.inferPlanForCollection({ rows: exportRows, target, table: "tickets" });
    let sql = exporters.emitCreateTable(plan);
    exporters.serializeExportPlan(plan);
    for await (const chunk of exporters.emitInsertStatements(plan, exportRows)) {
      sql += chunk;
    }
    emit(`export/mixed-unicode-${target}.sql`, "export", Buffer.from(sql));
  }
}

async function captureChildMain() {
  const options = parseOptions(process.argv.slice(2), new Set(["child-out"]));
  const out = resolve(requireOption(options, "child-out"));
  assertOutputDirectoryEmpty(out);
  mkdirSync(out, { recursive: true });
  const entries = [];
  const emit = (path, contract, bytes) => {
    if (EXPECTED_CONTRACT_BY_PATH.get(path) !== contract) {
      throw new Error(`freeze:fold-stage0: unexpected capture payload ${path} (${contract})`);
    }
    const raw = Buffer.from(bytes);
    writePayloadExclusive(out, path, raw);
    entries.push({ path, contract, bytes: raw.byteLength, sha256: hashBytes(raw) });
  };
  const subject = process.cwd();
  await captureProtocolPayloads(subject, emit);
  assertCaptureIndex(entries);
  writePayloadExclusive(out, "capture-index.json", jsonBytes(entries));
}

export async function main() {
  const options = parseOptions(
    process.argv.slice(2),
    new Set(["subject-commit", "subject-worktree", "out", "provenance-out"]),
  );
  const requestedCommit = requireOption(options, "subject-commit");
  const requestedSubject = resolve(requireOption(options, "subject-worktree"));
  const out = resolve(process.cwd(), requireOption(options, "out"));
  const provenanceOut = resolve(process.cwd(), requireOption(options, "provenance-out"));
  const scriptPath = fileURLToPath(import.meta.url);
  const repoRoot = realpathSync(
    gitText(dirname(scriptPath), ["rev-parse", "--show-toplevel"]).trim(),
  );
  const fixtureRoot = join(repoRoot, "tests", "fixtures", "fold-stage0");
  assertOutputRootContained(fixtureRoot, out);
  assertNoSymlinkComponents(fixtureRoot, out);
  assertOutputDirectoryEmpty(out);

  const subject = realpathSync(gitText(requestedSubject, ["rev-parse", "--show-toplevel"]).trim());
  const actualCommit = gitText(subject, ["rev-parse", "HEAD"]).trim();
  const branchName = gitText(subject, ["branch", "--show-current"]).trim();
  assertSubjectWorktreeState({
    requestedCommit,
    actualCommit,
    branchName,
    subjectWorktree: subject,
    implementationWorktree: repoRoot,
  });
  assertCleanSubjectWorktree(gitText(subject, ["status", "--porcelain"]));

  const packageVersion = JSON.parse(readFileSync(join(subject, "package.json"), "utf8")).version;
  const captureToolSha256 = hashBytes(readFileSync(scriptPath));
  const captureToolPath = relative(repoRoot, scriptPath).split(sep).join("/");
  assertCorpusRelativePath(captureToolPath);
  const captureEnvironment = sanitizeCaptureEnvironment(process.env);
  const pnpmVersion = runChecked("pnpm", ["--version"], {
    cwd: subject,
    env: captureEnvironment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).stdout.trim();
  if (pnpmVersion.length === 0) {
    throw new Error("freeze:fold-stage0: pnpm --version returned an empty value");
  }
  const provenanceBytes = buildCaptureProvenanceBytes({
    frozenSubjectCommit: actualCommit,
    captureToolPath,
    captureToolSha256,
    rootPackageVersion: packageVersion,
    lockfileSha256: hashBytes(readFileSync(join(subject, "pnpm-lock.yaml"))),
    nodeVersion: process.version,
    pnpmVersion,
  });
  const childRoot = mkdtempSync(join(tmpdir(), "baerly-fold-stage0-capture-"));
  try {
    runChecked(
      process.execPath,
      [
        "--import",
        join(subject, "bench", "register-hooks.mjs"),
        scriptPath,
        "--capture-child",
        `--child-out=${childRoot}`,
      ],
      {
        cwd: subject,
        env: captureEnvironment,
        // The top-level stdout is a single structured success record.
        // Preserve all build/capture diagnostics by routing child stdout
        // alongside stderr instead of discarding it.
        stdio: ["ignore", 2, 2],
      },
    );
    const indexPath = join(childRoot, "capture-index.json");
    const indexStat = lstatSync(indexPath);
    if (indexStat.isSymbolicLink() || !indexStat.isFile()) {
      throw new Error("freeze:fold-stage0: capture child index is not a regular file");
    }
    const entries = JSON.parse(readFileSync(indexPath, "utf8"));
    const payloads = readCapturedPayloads(childRoot, entries);
    for (const payload of payloads) {
      writePayloadExclusive(out, payload.binding.path, payload.bytes);
      const written = readFileSync(join(out, ...payload.binding.path.split("/")));
      if (
        written.byteLength !== payload.binding.bytes ||
        hashBytes(written) !== payload.binding.sha256
      ) {
        throw new Error(
          `freeze:fold-stage0: write verification failed for ${payload.binding.path}`,
        );
      }
    }
    const manifest = buildManifest({
      frozenSubjectCommit: requestedCommit,
      captureToolSha256,
      packageVersion,
      files: payloads.map(({ binding }) => binding),
    });
    const manifestBytes = jsonBytes(manifest);
    writePayloadExclusive(out, "manifest.json", manifestBytes);
    const capturedAtUtc = new Date().toISOString();
    writeCaptureProvenanceExclusive(provenanceOut, provenanceBytes);
    process.stdout.write(
      jsonBytes(
        buildCaptureSuccessResult({
          capturedAtUtc,
          manifestBytes,
          corpusFileCount: payloads.length,
          frozenSubjectCommit: actualCommit,
          provenanceBytes,
        }),
      ),
    );
  } finally {
    rmSync(childRoot, { recursive: true, force: true });
  }
}

/**
 * True only when node was launched on this file. `import.meta.url ===
 * process.argv[1]` no-ops through a symlink (pnpm's `.bin` shims are
 * symlinks), so compare realpaths rather than URLs — that keeps symlinked
 * invocation working without sniffing ambient argv or env, which would make
 * importing this module for its pure helpers run a capture as a side effect.
 */
function invokedDirectly() {
  if (process.argv[1] === undefined) {
    return false;
  }
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function runSelectedEntryPoint() {
  if (!invokedDirectly()) {
    return;
  }
  if (process.argv.includes("--capture-child")) {
    await captureChildMain();
    return;
  }
  await main();
}

try {
  await runSelectedEntryPoint();
} catch (error) {
  process.stderr.write(`${error.stack ?? error.message ?? String(error)}\n`);
  process.exitCode = 1;
}
