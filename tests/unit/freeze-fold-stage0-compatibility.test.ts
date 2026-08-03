import { describe, test, expect } from "vitest";
import { sha256Hex } from "@baerly/protocol";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  hashBytes,
  assertCorpusRelativePath,
  assertNoDuplicatePaths,
  buildManifest,
  assertCleanSubjectWorktree,
  assertSubjectCommitMatches,
  assertOutputDirectoryEmpty,
  assertOutputRootContained,
  assertCaptureIndex,
  readCapturedPayloads,
  writePayloadExclusive,
  EXPECTED_CAPTURE_PATHS,
  assertSubjectWorktreeState,
  sanitizeCaptureEnvironment,
  buildCaptureProvenanceBytes,
  writeCaptureProvenanceExclusive,
  buildCaptureSuccessResult,
  type Stage0HashBinding,
  type CaptureIndexEntry,
  type Stage0CaptureProvenanceInput,
} from "../../scripts/freeze-fold-stage0-compatibility.mjs";

const FULL_SUBJECT_SHA = "01bdd298ac19826e8141fe67cdfd3b62b4dcdd5e";
const OTHER_FULL_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const CAPTURE_TOOL_PATH = fileURLToPath(
  new URL("../../scripts/freeze-fold-stage0-compatibility.mjs", import.meta.url),
);

describe("freeze-fold-stage0-compatibility: hashing", () => {
  test("hashBytes agrees with the protocol's sha256Hex, byte for byte", async () => {
    const bytes = new TextEncoder().encode('{"_id":"é","n":1}');
    expect(hashBytes(bytes)).toBe(await sha256Hex(bytes));
  });

  test("hashBytes hashes raw bytes, not a reserialization", () => {
    const spaced = new TextEncoder().encode('{ "a": 1 }');
    const tight = new TextEncoder().encode('{"a":1}');
    expect(hashBytes(spaced)).not.toBe(hashBytes(tight));
  });

  test("hashBytes emits lowercase hex", () => {
    expect(hashBytes(new Uint8Array([0xff]))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("freeze-fold-stage0-compatibility: path containment", () => {
  for (const bad of ["../escape.json", "/abs.json", "a/../../b.json", "a\\b.json"]) {
    test(`rejects ${bad}`, () => {
      expect(() => assertCorpusRelativePath(bad)).toThrow(/corpus-relative/);
    });
  }
  test("accepts a nested POSIX path", () => {
    expect(() => assertCorpusRelativePath("snapshot/legacy-ascii.json")).not.toThrow();
  });
});

describe("freeze-fold-stage0-compatibility: manifest integrity", () => {
  const entry = (path: string): Stage0HashBinding => ({
    path,
    bytes: 1,
    sha256: "0".repeat(64),
    contract: "snapshot",
  });

  test("rejects duplicate manifest paths", () => {
    expect(() =>
      assertNoDuplicatePaths([entry("snapshot/a.json"), entry("snapshot/a.json")]),
    ).toThrow(/duplicate/i);
  });

  test("manifest carries the declared schema and the frozen subject commit", () => {
    const m = buildManifest({
      frozenSubjectCommit: "01bdd298ac19826e8141fe67cdfd3b62b4dcdd5e",
      captureToolSha256: "1".repeat(64),
      packageVersion: "0.3.0",
      files: [entry("snapshot/a.json")],
    });
    expect(m.schema).toBe("baerly.fold-stage0-compatibility/v1");
    expect(m.frozen_subject_commit).toBe("01bdd298ac19826e8141fe67cdfd3b62b4dcdd5e");
  });

  test("manifest file list is sorted ASCII-lex by path", () => {
    const m = buildManifest({
      frozenSubjectCommit: "01bdd298ac19826e8141fe67cdfd3b62b4dcdd5e",
      captureToolSha256: "1".repeat(64),
      packageVersion: "0.3.0",
      files: [entry("snapshot/b.json"), entry("current/a.json")],
    });
    expect(m.files.map((f) => f.path)).toEqual(["current/a.json", "snapshot/b.json"]);
  });
});

describe("freeze-fold-stage0-compatibility: subject hermeticity", () => {
  test("rejects a dirty subject worktree", () => {
    expect(() => assertCleanSubjectWorktree(" M packages/server/src/writer.ts\n")).toThrow(
      /dirty/i,
    );
  });

  test("accepts an empty porcelain status", () => {
    expect(() => assertCleanSubjectWorktree("")).not.toThrow();
  });

  test("rejects a subject commit that is not the requested one", () => {
    expect(() =>
      assertSubjectCommitMatches(
        "01bdd298ac19826e8141fe67cdfd3b62b4dcdd5e",
        "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      ),
    ).toThrow(/does not match/i);
  });

  test.each(["01bdd298ac19", "HEAD", "refs/heads/main", FULL_SUBJECT_SHA.toUpperCase()])(
    "rejects non-canonical requested commit %s",
    (requestedCommit) => {
      const subject = mkdtempSync(join(tmpdir(), "fold-stage0-subject-"));
      const implementation = mkdtempSync(join(tmpdir(), "fold-stage0-implementation-"));
      try {
        expect(() =>
          assertSubjectWorktreeState({
            requestedCommit,
            actualCommit: requestedCommit,
            branchName: "",
            subjectWorktree: subject,
            implementationWorktree: implementation,
          }),
        ).toThrow(/lowercase full 40-hex/i);
      } finally {
        rmSync(subject, { recursive: true, force: true });
        rmSync(implementation, { recursive: true, force: true });
      }
    },
  );

  test("rejects a mismatched full subject HEAD", () => {
    const subject = mkdtempSync(join(tmpdir(), "fold-stage0-subject-"));
    const implementation = mkdtempSync(join(tmpdir(), "fold-stage0-implementation-"));
    try {
      expect(() =>
        assertSubjectWorktreeState({
          requestedCommit: FULL_SUBJECT_SHA,
          actualCommit: OTHER_FULL_SHA,
          branchName: "",
          subjectWorktree: subject,
          implementationWorktree: implementation,
        }),
      ).toThrow(/does not match/i);
    } finally {
      rmSync(subject, { recursive: true, force: true });
      rmSync(implementation, { recursive: true, force: true });
    }
  });

  test("rejects an attached subject HEAD", () => {
    const subject = mkdtempSync(join(tmpdir(), "fold-stage0-subject-"));
    const implementation = mkdtempSync(join(tmpdir(), "fold-stage0-implementation-"));
    try {
      expect(() =>
        assertSubjectWorktreeState({
          requestedCommit: FULL_SUBJECT_SHA,
          actualCommit: FULL_SUBJECT_SHA,
          branchName: "main",
          subjectWorktree: subject,
          implementationWorktree: implementation,
        }),
      ).toThrow(/detached/i);
    } finally {
      rmSync(subject, { recursive: true, force: true });
      rmSync(implementation, { recursive: true, force: true });
    }
  });

  test("rejects the implementation checkout as its own subject", () => {
    const checkout = mkdtempSync(join(tmpdir(), "fold-stage0-same-checkout-"));
    try {
      expect(() =>
        assertSubjectWorktreeState({
          requestedCommit: FULL_SUBJECT_SHA,
          actualCommit: FULL_SUBJECT_SHA,
          branchName: "",
          subjectWorktree: checkout,
          implementationWorktree: checkout,
        }),
      ).toThrow(/physically distinct/i);
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  test("accepts a full matching SHA in a distinct detached worktree", () => {
    const subject = mkdtempSync(join(tmpdir(), "fold-stage0-subject-"));
    const implementation = mkdtempSync(join(tmpdir(), "fold-stage0-implementation-"));
    try {
      expect(() =>
        assertSubjectWorktreeState({
          requestedCommit: FULL_SUBJECT_SHA,
          actualCommit: FULL_SUBJECT_SHA,
          branchName: "",
          subjectWorktree: subject,
          implementationWorktree: implementation,
        }),
      ).not.toThrow();
    } finally {
      rmSync(subject, { recursive: true, force: true });
      rmSync(implementation, { recursive: true, force: true });
    }
  });

  test("removes BAERLY_SKIP_BUILD without mutating the caller's environment", () => {
    const environment = {
      PATH: "/capture/bin",
      BAERLY_SKIP_BUILD: "stale-dist-is-forbidden",
      BAERLY_CAPTURE_SENTINEL: "preserved",
    };
    expect(sanitizeCaptureEnvironment(environment)).toEqual({
      PATH: "/capture/bin",
      BAERLY_CAPTURE_SENTINEL: "preserved",
    });
    expect(environment.BAERLY_SKIP_BUILD).toBe("stale-dist-is-forbidden");
  });

  test("refuses to overwrite a non-empty corpus", () => {
    const dir = mkdtempSync(join(tmpdir(), "fold-stage0-"));
    mkdirSync(join(dir, "snapshot"), { recursive: true });
    writeFileSync(join(dir, "snapshot", "legacy-ascii.json"), "{}");
    expect(() => assertOutputDirectoryEmpty(dir)).toThrow(/not empty|refusing to overwrite/i);
    rmSync(dir, { recursive: true, force: true });
  });

  test("accepts a missing output directory", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "fold-stage0-")), "does-not-exist");
    expect(() => assertOutputDirectoryEmpty(dir)).not.toThrow();
  });
});

describe("freeze-fold-stage0-compatibility: atomic capture provenance", () => {
  const provenanceInput: Stage0CaptureProvenanceInput = {
    frozenSubjectCommit: FULL_SUBJECT_SHA,
    captureToolPath: "scripts/freeze-fold-stage0-compatibility.mjs",
    captureToolSha256: "1".repeat(64),
    rootPackageVersion: "0.6.0",
    lockfileSha256: "2".repeat(64),
    nodeVersion: "v26.5.0",
    pnpmVersion: "11.1.2",
  };

  test("emits the exact v1 provenance schema and an agreeing structured result", () => {
    const provenanceBytes = buildCaptureProvenanceBytes(provenanceInput);
    expect(provenanceBytes).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(Buffer.from(provenanceBytes).toString("utf8"))).toEqual({
      schema: "baerly.fold-stage0-capture-provenance/v1",
      frozen_subject_commit: FULL_SUBJECT_SHA,
      capture_tool_path: "scripts/freeze-fold-stage0-compatibility.mjs",
      capture_tool_sha256: "1".repeat(64),
      root_package_version: "0.6.0",
      lockfile_sha256: "2".repeat(64),
      node_version: "v26.5.0",
      pnpm_version: "11.1.2",
    });

    const manifestBytes = Buffer.from('{"schema":"manifest"}\n');
    expect(
      buildCaptureSuccessResult({
        capturedAtUtc: "2026-08-03T10:11:12.345Z",
        manifestBytes,
        corpusFileCount: 31,
        frozenSubjectCommit: FULL_SUBJECT_SHA,
        provenanceBytes,
      }),
    ).toEqual({
      captured_at_utc: "2026-08-03T10:11:12.345Z",
      corpus_manifest_sha256: hashBytes(manifestBytes),
      corpus_file_count: 31,
      frozen_subject_commit: FULL_SUBJECT_SHA,
      capture_provenance_sha256: hashBytes(provenanceBytes),
    });
  });

  test("creates provenance exclusively and preserves the emitted bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "fold-stage0-provenance-"));
    const path = join(root, "capture-provenance.json");
    const bytes = Buffer.from('{"schema":"test"}\n');
    try {
      writeCaptureProvenanceExclusive(path, bytes);
      expect(readFileSync(path)).toEqual(bytes);
      expect(() => writeCaptureProvenanceExclusive(path, bytes)).toThrow(
        /overwrite|exist|exclusive/i,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("freeze-fold-stage0-compatibility: complete child capture", () => {
  const captureEntry = (path: string, bytes: Uint8Array): CaptureIndexEntry => ({
    path,
    contract: path.startsWith("current/")
      ? "current-json"
      : (path.slice(0, path.indexOf("/")) as CaptureIndexEntry["contract"]),
    bytes: bytes.byteLength,
    sha256: hashBytes(bytes),
  });

  test("declares all 31 payload paths exactly once", () => {
    expect(EXPECTED_CAPTURE_PATHS).toHaveLength(31);
    expect(new Set(EXPECTED_CAPTURE_PATHS).size).toBe(31);
    expect(EXPECTED_CAPTURE_PATHS).toContain("current/fresh-zero.json");
    expect(EXPECTED_CAPTURE_PATHS).toContain("current/null-snapshot-positive-floor.json");
    expect(EXPECTED_CAPTURE_PATHS).toContain("mixed-version/stage0-reads-unmarked.snapshot.json");
  });

  test("declares no packaging payloads — check-exports.mjs owns that surface", () => {
    expect(EXPECTED_CAPTURE_PATHS.filter((path) => path.startsWith("public-surface/"))).toEqual([]);
  });

  test("rejects an incomplete capture index", () => {
    const entries = EXPECTED_CAPTURE_PATHS.slice(1).map((path) =>
      captureEntry(path, new TextEncoder().encode(path)),
    );
    expect(() => assertCaptureIndex(entries)).toThrow(
      new RegExp(
        `returned ${EXPECTED_CAPTURE_PATHS.length - 1} payloads; ` +
          `expected ${EXPECTED_CAPTURE_PATHS.length}`,
      ),
    );
  });

  test("rejects stale child hashes before copying bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "fold-stage0-child-"));
    try {
      const entries = EXPECTED_CAPTURE_PATHS.map((path) => {
        const bytes = new TextEncoder().encode(path);
        const file = join(root, ...path.split("/"));
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, bytes);
        return captureEntry(path, bytes);
      });
      entries[0] = { ...entries[0]!, sha256: "f".repeat(64) };
      expect(() => readCapturedPayloads(root, entries)).toThrow(/stale|sha256|hash/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses an output path outside the fixture namespace", () => {
    expect(() =>
      assertOutputRootContained("/repo/tests/fixtures/fold-stage0", "/repo/tests/fixtures/escape"),
    ).toThrow(/outside the fixture root/i);
  });

  test("refuses to follow a symlink when writing a payload", () => {
    const root = mkdtempSync(join(tmpdir(), "fold-stage0-write-"));
    const outside = join(root, "outside.json");
    const linked = join(root, "linked.json");
    try {
      writeFileSync(outside, "outside");
      symlinkSync(outside, linked);
      expect(() => writePayloadExclusive(root, "linked.json", new Uint8Array([1]))).toThrow(
        /exist|symlink|refus/i,
      );
      expect(readFileSync(outside, "utf8")).toBe("outside");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a symlinked invocation reaches main instead of silently exiting", () => {
    const root = mkdtempSync(join(tmpdir(), "fold-stage0-bin-"));
    const linked = join(root, "freeze-stage0");
    try {
      symlinkSync(CAPTURE_TOOL_PATH, linked);
      const result = spawnSync(process.execPath, [linked], { encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/--subject-commit/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("freeze-fold-stage0-compatibility: import purity", () => {
  // Importing the module for its pure helpers must never start a capture. The
  // entry point used to sniff `--run` in argv and BAERLY_FREEZE_STAGE0_RUN in
  // the environment, so an unrelated importer whose argv happened to carry
  // `--run` ran main() and poisoned process.exitCode.
  test.each([
    ["bare import", [], {}],
    ["argv carrying --run", ["--run"], {}],
    ["the retired opt-in env var", [], { BAERLY_FREEZE_STAGE0_RUN: "1" }],
  ])("importing the module is a no-op with %s", (_label, extraArgv, extraEnv) => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(pathToFileURL(CAPTURE_TOOL_PATH).href)});
         if (process.exitCode !== undefined && process.exitCode !== 0) {
           throw new Error("import set exitCode " + process.exitCode);
         }`,
        "--",
        ...extraArgv,
      ],
      { encoding: "utf8", env: { ...process.env, ...extraEnv } },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
