import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  BaerlyError,
  casUpdateCurrentJson,
  createCurrentJson,
  CURRENT_JSON_SCHEMA_VERSION,
  logObjectKey,
  lsnParts,
  MemoryStorage,
  readCurrentJson,
  sha256Hex,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { captureStream } from "../../packages/cli/src/_internal/testing.ts";
import { runDump } from "../../packages/cli/src/admin/dump.ts";
import { runRestore } from "../../packages/cli/src/admin/restore.ts";
import { parseBucketUri } from "../../packages/cli/src/bucket-uri.ts";
import {
  emitCreateTable,
  emitInsertStatements,
  inferPlanForCollection,
  loadMaterialisedView,
  type SqlTarget,
} from "../../packages/cli/src/export/index.ts";
import { readLogEntry, walkLogRange } from "../../packages/server/src/log-walk.ts";
import { loadSnapshotAsMap, snapshotKey } from "../../packages/server/src/snapshot.ts";
import {
  buildCaptureSuccessResult,
  hashBytes,
} from "../../scripts/freeze-fold-stage0-compatibility.mjs";
import {
  buildFrozenPrefixSeed,
  FOLD_STAGE0_FROZEN_SUBJECT_COMMIT,
  frozenFixturesByContract,
  loadStage0CompatibilityManifest,
  readFrozenFixtureBytes,
  seedStorageFromFrozenPrefix,
  type Stage0FixtureContract,
} from "../fixtures/fold-stage0/frozen-corpus.ts";

const COVERED_CONTRACTS = new Set<Stage0FixtureContract>();
const CLI_CURRENT_KEY = "app/app/tenant/tenant/manifests/tickets/current.json";
const CLI_MANIFEST_PREFIX = "app/app/tenant/tenant/manifests/tickets";

const loadFrozenSnapshot = async (fixture: string) => {
  const manifest = await loadStage0CompatibilityManifest();
  const binding = manifest.files.find((file) => file.path === fixture);
  if (binding === undefined) {
    throw new Error(`missing fixture binding: ${fixture}`);
  }
  const bytes = await readFrozenFixtureBytes(fixture);
  const body = JSON.parse(new TextDecoder().decode(bytes)) as {
    min_seq: number;
    max_seq: number;
  };
  const storage = new MemoryStorage();
  const key = snapshotKey("compat/tickets", body.min_seq, body.max_seq, binding.sha256);
  await storage.put(key, bytes, { contentType: "application/json" });
  return loadSnapshotAsMap(storage, key, "tickets");
};

let memoryBucketSerial = 0;
const restoreFixture = async (fixture: string) => {
  return restoreBytes(await readFrozenFixtureBytes(fixture));
};

const restoreBytes = async (bytes: Uint8Array) => {
  memoryBucketSerial += 1;
  const bucket = `memory://fold-stage0-freeze-test-${memoryBucketSerial}`;
  const stderr = captureStream(process.stderr);
  let code: number;
  try {
    code = await runRestore(
      [`--bucket=${bucket}`, "--app=app", "--tenant=tenant", "--collection=tickets"],
      { streams: { stdin: Readable.from([bytes]) } },
    );
  } finally {
    stderr.restore();
  }
  const parsed = await parseBucketUri(bucket);
  return { code, storage: parsed.storage, stderr: stderr.captured.join("") };
};

const captureWritable = () => {
  const chunks: Buffer[] = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
    bytes: () => Buffer.concat(chunks),
  };
};

const emitSql = async (target: SqlTarget): Promise<Uint8Array> => {
  const rows = new Map([
    ["a", { _id: "a", label: "ascii", active: true, score: 1 }],
    ["\ufffd", { _id: "\ufffd", label: "bmp", active: false, score: 2 }],
    ["\u{10000}", { _id: "\u{10000}", label: "astral", active: true, score: 3 }],
  ]);
  const plan = inferPlanForCollection({ rows, target, table: "tickets" });
  let sql = emitCreateTable(plan);
  for await (const chunk of emitInsertStatements(plan, rows)) {
    sql += chunk;
  }
  return new TextEncoder().encode(sql);
};

describe("fold-stage0 frozen corpus: identity and loader", () => {
  test("manifest declares the v1 schema and the rebaseline subject commit", async () => {
    expect.hasAssertions();
    const manifest = await loadStage0CompatibilityManifest();
    expect(manifest.schema).toBe("baerly.fold-stage0-compatibility/v1");
    expect(manifest.frozen_subject_commit).toBe(FOLD_STAGE0_FROZEN_SUBJECT_COMMIT);
    expect(manifest.frozen_subject_commit).toBe("01bdd298ac19826e8141fe67cdfd3b62b4dcdd5e");
    expect(manifest.capture_tool_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.package_version).toBe("0.6.0");
  });

  test("every manifest entry's raw bytes hash to its recorded sha256", async () => {
    expect.hasAssertions();
    const manifest = await loadStage0CompatibilityManifest();
    expect(manifest.files.length).toBe(31);
    for (const file of manifest.files) {
      const bytes = await readFrozenFixtureBytes(file.path);
      const hash = await sha256Hex(bytes);
      expect(bytes.byteLength).toBe(file.bytes);
      expect(hash).toBe(file.sha256);
    }
  });

  test("manifest slices are exhaustive and non-empty", async () => {
    expect.hasAssertions();
    const manifest = await loadStage0CompatibilityManifest();
    expect(
      Object.fromEntries(
        ["snapshot", "log", "current-json", "restore", "dump", "export", "mixed-version"].map(
          (contract) => [
            contract,
            frozenFixturesByContract(manifest, contract as Stage0FixtureContract).length,
          ],
        ),
      ),
    ).toEqual({
      snapshot: 6,
      log: 9,
      "current-json": 5,
      restore: 5,
      dump: 1,
      export: 3,
      "mixed-version": 2,
    });
  });

  test("prefix seeds are deterministic maps of the literal fixture bytes", async () => {
    expect.hasAssertions();
    const options = {
      manifestPrefix: "compat/tickets",
      current: "current/snapshotted.json",
      snapshot: "snapshot/legacy-ascii.json",
      logs: [{ seq: 0, fixture: "log/insert.json" }],
    } as const;
    const first = await buildFrozenPrefixSeed(options);
    const second = await buildFrozenPrefixSeed(options);
    expect(second).toEqual(first);
    expect([...first.keys()]).toEqual([
      "compat/tickets/current.json",
      "compat/tickets/snapshot/L9/000000000000-000000000002-ad5afa8d2ba7793777fa3536ae93eb82242ba9477e07fb927a876ebd2f8fab04.json",
      "compat/tickets/log/0.json",
    ]);
    expect(first.get("compat/tickets/current.json")).toEqual(
      await readFrozenFixtureBytes("current/snapshotted.json"),
    );
  });

  test("raw-byte reads reject paths outside the immutable corpus", async () => {
    expect.hasAssertions();
    // The reader delegates the string rule to the capture tool, so this is the
    // producer's message — proof the two are one implementation, not two.
    await expect(readFrozenFixtureBytes("../manifest.json")).rejects.toThrow(
      "not a contained corpus-relative POSIX path",
    );
    await expect(readFrozenFixtureBytes("/tmp/manifest.json")).rejects.toThrow(
      "not a contained corpus-relative POSIX path",
    );
  });
});

describe("fold-stage0 frozen corpus: promoted study record", () => {
  test("structured result, promoted provenance, corpus manifest, study manifest, and ledger agree", () => {
    expect.hasAssertions();
    const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
    const corpusManifestBytes = readFileSync(
      join(repoRoot, "tests/fixtures/fold-stage0/pre-change/manifest.json"),
    );
    const corpusManifest = JSON.parse(corpusManifestBytes.toString("utf8")) as {
      frozen_subject_commit: string;
      capture_tool_sha256: string;
      files: readonly unknown[];
    };
    const studyRoot = join(
      repoRoot,
      "docs/spec/attachments/fold-stage0/compat-freeze-01bdd298ac19",
    );
    expect(readdirSync(studyRoot).toSorted()).toEqual([
      "README.md",
      "capture-provenance.json",
      "files.sha256",
      "manifest.json",
    ]);

    const provenanceBytes = readFileSync(join(studyRoot, "capture-provenance.json"));
    const provenance = JSON.parse(provenanceBytes.toString("utf8")) as Record<string, unknown>;
    expect(Object.keys(provenance)).toEqual([
      "schema",
      "frozen_subject_commit",
      "capture_tool_path",
      "capture_tool_sha256",
      "root_package_version",
      "lockfile_sha256",
      "node_version",
      "pnpm_version",
    ]);
    expect(provenance["capture_tool_sha256"]).toBe(corpusManifest.capture_tool_sha256);
    expect(corpusManifest.capture_tool_sha256).toBe(
      hashBytes(readFileSync(join(repoRoot, "scripts/freeze-fold-stage0-compatibility.mjs"))),
    );

    const studyManifestBytes = readFileSync(join(studyRoot, "manifest.json"));
    const studyManifest = JSON.parse(studyManifestBytes.toString("utf8")) as {
      captured_at_utc: string;
      frozen_subject_commit: string;
      corpus_manifest_sha256: string;
      corpus_file_count: number;
      files: readonly { path: string; bytes: number; sha256: string }[];
    };
    expect(Object.keys(JSON.parse(studyManifestBytes.toString("utf8")) as object)).toEqual([
      "schema",
      "study_id",
      "study_kind",
      "frozen_subject_commit",
      "captured_at_utc",
      "corpus_root",
      "corpus_manifest_sha256",
      "corpus_file_count",
      "supersedes",
      "files",
    ]);
    const emittedResult = buildCaptureSuccessResult({
      capturedAtUtc: studyManifest.captured_at_utc,
      manifestBytes: corpusManifestBytes,
      corpusFileCount: corpusManifest.files.length,
      frozenSubjectCommit: corpusManifest.frozen_subject_commit,
      provenanceBytes,
    });
    expect(emittedResult).toEqual({
      captured_at_utc: studyManifest.captured_at_utc,
      corpus_manifest_sha256: studyManifest.corpus_manifest_sha256,
      corpus_file_count: studyManifest.corpus_file_count,
      frozen_subject_commit: studyManifest.frozen_subject_commit,
      capture_provenance_sha256: studyManifest.files.find(
        (file) => file.path === "capture-provenance.json",
      )?.sha256,
    });

    for (const binding of studyManifest.files) {
      const bytes = readFileSync(join(studyRoot, binding.path));
      expect(bytes.byteLength).toBe(binding.bytes);
      expect(hashBytes(bytes)).toBe(binding.sha256);
    }

    const ledgerBindings = new Map(
      readFileSync(join(studyRoot, "files.sha256"), "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => {
          const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
          expect(match).not.toBeNull();
          return [match?.[2] ?? "", match?.[1] ?? ""] as const;
        }),
    );
    expect([...ledgerBindings.keys()].toSorted()).toEqual([
      "README.md",
      "capture-provenance.json",
      "manifest.json",
    ]);
    for (const [path, expectedHash] of ledgerBindings) {
      expect(hashBytes(readFileSync(join(studyRoot, path)))).toBe(expectedHash);
    }
  });
});

describe("fold-stage0 frozen corpus: current.json compatibility contract", () => {
  COVERED_CONTRACTS.add("current-json");

  test.each([
    ["current/fresh-zero.json", 0, 0, false, 0, "000000000000"],
    ["current/high-floor-no-old-logs.json", 9, 9, true, 3, "000000000002"],
    ["current/null-snapshot-positive-floor.json", 3, 3, false, 1, "000000000000"],
    ["current/rollback-roll-forward.json", 0, 6, false, 1, "000000000003"],
    ["current/snapshotted.json", 2, 2, true, 0, "000000000001"],
  ])(
    "%s preserves its released head fields",
    async (fixture, floor, tail, hasSnapshot, epoch, generation) => {
      expect.hasAssertions();
      const storage = new MemoryStorage();
      const key = "compat/tickets/current.json";
      await storage.put(key, await readFrozenFixtureBytes(fixture), {
        contentType: "application/json",
      });
      const read = await readCurrentJson(storage, key);
      expect(read).not.toBeNull();
      expect(read!.json.log_seq_start).toBe(floor);
      expect(read!.json.tail_hint).toBe(tail);
      expect(read!.json.snapshot !== null).toBe(hasSnapshot);
      expect(read!.json.writer_fence.epoch).toBe(epoch);
      expect(read!.json.generation).toBe(generation);
    },
  );

  // Coordination design section 8 item 3: a null snapshot admits any boundary
  // in [0, tail_hint], with zero bytes and rows and no tie to zero.
  test.each([
    ["current/fresh-zero.json", 0],
    ["current/null-snapshot-positive-floor.json", null],
  ])("%s is a valid null-snapshot head", async (fixture, expectedFloor) => {
    expect.hasAssertions();
    const storage = new MemoryStorage();
    const key = "compat/tickets/current.json";
    await storage.put(key, await readFrozenFixtureBytes(fixture), {
      contentType: "application/json",
    });
    const read = await readCurrentJson(storage, key);
    expect(read).not.toBeNull();
    expect(read!.json.snapshot).toBeNull();
    expect(read!.json.snapshot_bytes).toBe(0);
    expect(read!.json.snapshot_rows).toBe(0);
    expect(read!.json.log_seq_start).toBeGreaterThanOrEqual(0);
    expect(read!.json.log_seq_start).toBeLessThanOrEqual(read!.json.tail_hint);
    if (expectedFloor !== null) {
      expect(read!.json.log_seq_start).toBe(expectedFloor);
    } else {
      expect(read!.json.log_seq_start).toBeGreaterThan(0);
    }
  });

  test("casUpdateCurrentJson still rejects an ordinary floor regression", async () => {
    expect.hasAssertions();
    const storage = new MemoryStorage();
    const key = "compat/tickets/current.json";
    await storage.put(key, await readFrozenFixtureBytes("current/high-floor-no-old-logs.json"));
    await expect(
      casUpdateCurrentJson(storage, key, (current) => ({ ...current, log_seq_start: 8 })),
    ).rejects.toMatchObject({ code: "Internal" });
  });

  test("restore --force deliberately bypasses the floor guard and may lower the floor", async () => {
    expect.hasAssertions();
    memoryBucketSerial += 1;
    const bucket = `memory://fold-stage0-floor-exemption-${memoryBucketSerial}`;
    const parsed = await parseBucketUri(bucket);
    const storage = parsed.storage;
    await storage.put(
      CLI_CURRENT_KEY,
      await readFrozenFixtureBytes("current/high-floor-no-old-logs.json"),
      { contentType: "application/json" },
    );
    const code = await runRestore(
      [`--bucket=${bucket}`, "--app=app", "--tenant=tenant", "--collection=tickets", "--force"],
      { streams: { stdin: Readable.from(['{"_id":"new"}\n']) } },
    );
    const read = await readCurrentJson(storage, CLI_CURRENT_KEY);
    expect(code).toBe(0);
    expect(read).not.toBeNull();
    expect(read!.json.snapshot).toBeNull();
    expect(read!.json.log_seq_start).toBe(0);
    expect(read!.json.tail_hint).toBe(1);
  });
});

describe("fold-stage0 frozen corpus: snapshot compatibility contract", () => {
  COVERED_CONTRACTS.add("snapshot");
  COVERED_CONTRACTS.add("mixed-version");

  test.each([
    ["snapshot/legacy-ascii.json", ["a", "z"]],
    ["snapshot/legacy-utf16-random-distinct.json", ["\u{10000}", "\ufffd"]],
    ["snapshot/legacy-unmarked-organ-pipe-mixed.json", ["a", "\ufffd", "\u{10000}", "z"]],
    ["snapshot/malformed-scalar-escape.json", ["\ud800"]],
  ])("%s materializes its released row keys", async (fixture, keys) => {
    expect.hasAssertions();
    const map = await loadFrozenSnapshot(fixture);
    expect([...map.keys()]).toEqual(keys);
  });

  test("materializes duplicate rows last-write-wins", async () => {
    expect.hasAssertions();
    const map = await loadFrozenSnapshot("snapshot/legacy-duplicate-rows.json");
    expect(map.size).toBe(1);
    expect(map.get("duplicate")).toEqual({ _id: "duplicate", revision: 2 });
  });

  test("tolerates row/body _id divergence and keys by the row _id", async () => {
    expect.hasAssertions();
    const map = await loadFrozenSnapshot("snapshot/identity-divergent.json");
    expect([...map.keys()]).toEqual(["row-key"]);
    expect(map.get("row-key")).toEqual({ _id: "body-key", note: "legacy divergence" });
  });

  test("legacy loading ignores additive markers and accepts an unmarked peer", async () => {
    expect.hasAssertions();
    const marked = await loadFrozenSnapshot("mixed-version/b-reads-marked.snapshot.json");
    const unmarked = await loadFrozenSnapshot("mixed-version/stage0-reads-unmarked.snapshot.json");
    expect([...marked.entries()]).toEqual([["marked", { _id: "marked", value: 1 }]]);
    expect([...unmarked.keys()]).toEqual(["\u{10000}", "\ufffd"]);
  });

  test("throws Internal on a filename/body hash mismatch and names the key", async () => {
    expect.hasAssertions();
    const storage = new MemoryStorage();
    const bytes = await readFrozenFixtureBytes("snapshot/legacy-ascii.json");
    const key = snapshotKey("compat/tickets", 0, 2, "0".repeat(64));
    await storage.put(key, bytes, { contentType: "application/json" });
    try {
      await loadSnapshotAsMap(storage, key, "tickets");
      expect.unreachable("hash mismatch unexpectedly loaded");
    } catch (error) {
      expect(error).toBeInstanceOf(BaerlyError);
      expect(error).toMatchObject({ code: "Internal" });
      expect((error as Error).message).toContain(key);
    }
  });
});

describe("fold-stage0 frozen corpus: log compatibility contract", () => {
  COVERED_CONTRACTS.add("log");

  const logs = [
    { seq: 0, fixture: "log/insert.json" },
    { seq: 1, fixture: "log/update.json" },
    { seq: 2, fixture: "log/delete.json" },
    { seq: 3, fixture: "log/malformed-scalar-escape.json" },
    { seq: 4, fixture: "log/identity-divergent.json" },
    { seq: 5, fixture: "log/malformed-lsn.json" },
    { seq: 6, fixture: "log/session-divergent.json" },
    { seq: 7, fixture: "log/sequence-divergent.json" },
    { seq: 8, fixture: "log/key-body-sequence-divergent.json" },
  ] as const;

  test("walkLogRange accepts all nine stored bodies and preserves their released fields", async () => {
    expect.hasAssertions();
    const storage = new MemoryStorage();
    await seedStorageFromFrozenPrefix(storage, {
      manifestPrefix: "compat/tickets",
      current: "current/fresh-zero.json",
      snapshot: null,
      logs,
    });
    const entries = await walkLogRange(storage, "compat/tickets", 0, 9);
    expect(
      entries.map(({ seq, op, doc_id, lsn, session }) => ({ seq, op, doc_id, lsn, session })),
    ).toEqual([
      {
        seq: 0,
        op: "I",
        doc_id: "row",
        lsn: "2c12m29vv_capture_7vvvvvvvvvv",
        session: "capture",
      },
      {
        seq: 1,
        op: "U",
        doc_id: "row",
        lsn: "2c12m29vv_capture_7vvvvvvvvvu",
        session: "capture",
      },
      {
        seq: 2,
        op: "D",
        doc_id: "row",
        lsn: "2c12m29vv_capture_7vvvvvvvvvt",
        session: "capture",
      },
      {
        seq: 3,
        op: "I",
        doc_id: "\ud800",
        lsn: "2c12m29vv_capture_7vvvvvvvvvs",
        session: "capture",
      },
      {
        seq: 4,
        op: "I",
        doc_id: "row-key",
        lsn: "2c12m29vv_capture_7vvvvvvvvvr",
        session: "capture",
      },
      { seq: 5, op: "I", doc_id: "bad-lsn", lsn: "not-an-lsn", session: "capture" },
      {
        seq: 6,
        op: "I",
        doc_id: "session",
        lsn: "2c12m29vv_wire_7vvvvvvvvvp",
        session: "capture",
      },
      {
        seq: 7,
        op: "I",
        doc_id: "sequence",
        lsn: "2c12m29vv_capture_7vvvvvvvvvv",
        session: "capture",
      },
      {
        seq: 8,
        op: "I",
        doc_id: "key-body",
        lsn: "2c12m29vv_capture_7vvvvvvvvvn",
        session: "capture",
      },
    ]);
    expect(entries[4]!.after).toEqual({ _id: "body-key" });
    const validParsedSequences = [0, 1, 2, 3, 4, null, 6, 0, 8] as const;
    for (const [index, expectedSeq] of validParsedSequences.entries()) {
      if (expectedSeq === null) {
        continue;
      }
      const parsed = lsnParts(entries[index]!.lsn);
      expect(Number.isFinite(parsed.seq)).toBe(true);
      expect(parsed.seq).toBe(expectedSeq);
    }
    expect(lsnParts(entries[6]!.lsn).session).toBe("wire");
    expect(entries[6]!.session).toBe("capture");
    expect(lsnParts(entries[7]!.lsn).seq).not.toBe(entries[7]!.seq);
    expect(() => lsnParts(entries[5]!.lsn)).toThrowError(BaerlyError);
  });

  test("readLogEntry trusts the stored body sequence when its object key diverges", async () => {
    expect.hasAssertions();
    const storage = new MemoryStorage();
    const key = logObjectKey("compat/tickets", 41);
    await storage.put(key, await readFrozenFixtureBytes("log/key-body-sequence-divergent.json"), {
      contentType: "application/json",
    });
    const entry = await readLogEntry(storage, key);
    expect(entry.seq).toBe(8);
    expect(entry.doc_id).toBe("key-body");
  });
});

describe("fold-stage0 frozen corpus: restore compatibility contract", () => {
  COVERED_CONTRACTS.add("restore");

  test.each([
    [
      "restore/canonical.ndjson",
      0,
      [
        ["a", { _id: "a", label: "ascii", rank: 1 }],
        ["\ufffd", { _id: "\ufffd", label: "bmp", rank: 2 }],
        ["\u{10000}", { _id: "\u{10000}", label: "astral", rank: 3 }],
      ],
      null,
    ],
    [
      "restore/malformed-scalar.ndjson",
      0,
      [["\ud800", { _id: "\ud800", note: "lone-high" }]],
      null,
    ],
    ["restore/duplicate-ids.ndjson", 0, [["duplicate", { _id: "duplicate", n: 2 }]], null],
    [
      "restore/missing-id.ndjson",
      2,
      [],
      "baerly admin.restore: Unknown: baerly admin restore: line 1 missing non-empty string _id\n",
    ],
    [
      "restore/identity-divergent.ndjson",
      0,
      [["row-key", { _id: "row-key", note: "legacy divergence" }]],
      null,
    ],
  ] as const)(
    "%s returns released exit %s and materialized rows",
    async (fixture, exit, rows, diagnostic) => {
      expect.hasAssertions();
      const restored = await restoreFixture(fixture);
      const view = await loadMaterialisedView({
        storage: restored.storage,
        currentJsonKey: CLI_CURRENT_KEY,
        collection: "tickets",
      });
      expect(restored.code).toBe(exit);
      expect(view === null ? null : [...view.entries()]).toEqual(rows);
      if (diagnostic !== null) {
        expect(restored.stderr).toBe(diagnostic);
      }
    },
  );

  test("legacy row/body divergence is dumped with row identity and restores remapped", async () => {
    expect.hasAssertions();
    const manifest = await loadStage0CompatibilityManifest();
    const binding = manifest.files.find((file) => file.path === "snapshot/identity-divergent.json");
    expect(binding).toBeDefined();
    if (binding === undefined) {
      return;
    }

    memoryBucketSerial += 1;
    const legacyBucket = `memory://fold-stage0-divergent-dump-${memoryBucketSerial}`;
    const parsedLegacy = await parseBucketUri(legacyBucket);
    const snapshotBytes = await readFrozenFixtureBytes("snapshot/identity-divergent.json");
    const legacySnapshotKey = snapshotKey(CLI_MANIFEST_PREFIX, 0, 1, binding.sha256);
    await parsedLegacy.storage.put(legacySnapshotKey, snapshotBytes, {
      contentType: "application/json",
    });
    await createCurrentJson(parsedLegacy.storage, CLI_CURRENT_KEY, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: legacySnapshotKey,
      tail_hint: 1,
      log_seq_start: 1,
      writer_fence: { epoch: 0, owner: "capture", claimed_at: "" },
      snapshot_bytes: snapshotBytes.byteLength,
      snapshot_rows: 1,
      generation: "000000000001",
    });

    const legacyView = await loadMaterialisedView({
      storage: parsedLegacy.storage,
      currentJsonKey: CLI_CURRENT_KEY,
      collection: "tickets",
    });
    expect(legacyView === null ? null : [...legacyView.entries()]).toEqual([
      ["row-key", { _id: "body-key", note: "legacy divergence" }],
    ]);

    const sink = captureWritable();
    const dumpCode = await runDump(
      [`--bucket=${legacyBucket}`, "--app=app", "--tenant=tenant", "--collection=tickets"],
      { streams: { stdout: sink.stream } },
    );
    const emittedRestoreBytes = sink.bytes();
    expect(dumpCode).toBe(0);
    expect(emittedRestoreBytes.toString("utf8")).toBe(
      '{"_id":"row-key","note":"legacy divergence"}\n',
    );
    expect(emittedRestoreBytes).toEqual(
      Buffer.from(await readFrozenFixtureBytes("restore/identity-divergent.ndjson")),
    );

    const restored = await restoreBytes(emittedRestoreBytes);
    const restoredView = await loadMaterialisedView({
      storage: restored.storage,
      currentJsonKey: CLI_CURRENT_KEY,
      collection: "tickets",
    });
    expect(restored.code).toBe(0);
    expect(restoredView === null ? null : [...restoredView.entries()]).toEqual([
      ["row-key", { _id: "row-key", note: "legacy divergence" }],
    ]);
  });
});

describe("fold-stage0 frozen corpus: dump compatibility contract", () => {
  COVERED_CONTRACTS.add("dump");

  test("runDump reproduces the frozen mixed-Unicode NDJSON bytes", async () => {
    expect.hasAssertions();
    const restored = await restoreFixture("restore/canonical.ndjson");
    expect(restored.code).toBe(0);
    memoryBucketSerial += 1;
    const bucket = `memory://fold-stage0-dump-test-${memoryBucketSerial}`;
    const parsed = await parseBucketUri(bucket);
    const dumpStorage = parsed.storage;
    for await (const object of restored.storage.list(`${CLI_MANIFEST_PREFIX}/`)) {
      const got = await restored.storage.get(object.key);
      await dumpStorage.put(object.key, got!.body, { contentType: "application/json" });
    }
    const sink = captureWritable();
    const code = await runDump(
      [`--bucket=${bucket}`, "--app=app", "--tenant=tenant", "--collection=tickets"],
      { streams: { stdout: sink.stream } },
    );
    expect(code).toBe(0);
    expect(sink.bytes()).toEqual(
      Buffer.from(await readFrozenFixtureBytes("dump/mixed-unicode.ndjson")),
    );
  });
});

describe("fold-stage0 frozen corpus: export compatibility contract", () => {
  COVERED_CONTRACTS.add("export");

  test.each(["sqlite", "postgres", "d1"] as const)(
    "%s emitters reproduce the frozen SQL bytes",
    async (target) => {
      expect.hasAssertions();
      expect(Buffer.from(await emitSql(target))).toEqual(
        Buffer.from(await readFrozenFixtureBytes(`export/mixed-unicode-${target}.sql`)),
      );
    },
  );
});

test("every frozen contract slice is covered by at least one assertion", async () => {
  expect.hasAssertions();
  const manifest = await loadStage0CompatibilityManifest();
  const slices = new Set(manifest.files.map((file) => file.contract));
  expect([...slices].filter((contract) => !COVERED_CONTRACTS.has(contract))).toEqual([]);
});
