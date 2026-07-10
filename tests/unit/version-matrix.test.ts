import { describe, expect, test } from "vitest";

import {
  collectDriftViolations,
  collectStructuralViolations,
  expectedLockstep,
  type CodeVersions,
  type MatrixShape,
  type PackageIdentity,
} from "../../scripts/check-version-matrix.ts";

// Baselines that mirror the committed version-matrix.json + live code.
// A test mutates one field at a time so a violation is unambiguous.
const baseMatrix = (): MatrixShape => ({
  packageSemver: { value: "0.3.0", lockstep: [...expectedLockstep] },
  specVersion: { value: "1" },
  schemaVersions: {
    "current.json": { value: 3 },
    "gc/pending.json": { value: 1 },
    snapshot: { value: 1 },
    LogEntry: { value: null, policy: "versionless-additive-only" },
  },
  layoutVersion: { value: 1, implicit: true, deferred: true },
  corpusVersion: {
    value: null,
    status: "not-yet-introduced",
    introducedBy: "Tier B golden bucket fixtures",
  },
});

const baseCode = (): CodeVersions => ({
  packageVersion: "0.3.0",
  specVersion: "1",
  currentJson: 3,
  gcPending: 1,
  snapshot: 1,
});

const basePkg = (): PackageIdentity => ({
  rootName: "@gusto/baerly-storage",
  rootVersion: "0.3.0",
  createName: "@gusto/create-baerly-storage",
  createVersion: "0.3.0",
});

describe("check-version-matrix: drift", () => {
  test("a consistent matrix has no drift", () => {
    expect(collectDriftViolations(baseMatrix(), baseCode())).toEqual([]);
  });

  // The gate protecting itself: a code-derived axis that drifts from the
  // matrix MUST be reported, or the check silently becomes a no-op.
  test("a stale code-derived schema version is caught", () => {
    const matrix = baseMatrix();
    matrix.schemaVersions.snapshot.value = 999;
    const violations = collectDriftViolations(matrix, baseCode());
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("schemaVersions.snapshot.value");
  });

  test("a stale specVersion is caught", () => {
    const matrix = baseMatrix();
    matrix.specVersion.value = "0";
    expect(collectDriftViolations(matrix, baseCode())).toEqual([
      expect.stringContaining("specVersion.value"),
    ]);
  });

  test("a stale current.json schema version is caught", () => {
    const matrix = baseMatrix();
    matrix.schemaVersions["current.json"].value = 999;
    expect(collectDriftViolations(matrix, baseCode())).toEqual([
      expect.stringContaining("schemaVersions.current.json.value"),
    ]);
  });

  test("a stale gc/pending.json schema version is caught", () => {
    const matrix = baseMatrix();
    matrix.schemaVersions["gc/pending.json"].value = 999;
    expect(collectDriftViolations(matrix, baseCode())).toEqual([
      expect.stringContaining("schemaVersions.gc/pending.json.value"),
    ]);
  });

  test("a stale packageSemver is caught", () => {
    const matrix = baseMatrix(); // still records the old 0.3.0
    const code = baseCode();
    code.packageVersion = "0.4.0"; // package.json moved on; matrix wasn't regenerated
    expect(collectDriftViolations(matrix, code)).toEqual([
      expect.stringContaining("packageSemver.value"),
    ]);
  });
});

describe("check-version-matrix: structural", () => {
  test("a consistent matrix + package identity is clean", () => {
    expect(collectStructuralViolations(baseMatrix(), basePkg())).toEqual([]);
  });

  test("a broken package lockstep is caught", () => {
    const pkg = basePkg();
    pkg.createVersion = "0.4.0"; // create package drifted off root
    const violations = collectStructuralViolations(baseMatrix(), pkg);
    expect(violations).toEqual([expect.stringContaining("lockstep violated")]);
  });

  test("mutating the LogEntry sentinel is caught", () => {
    const matrix = baseMatrix();
    matrix.schemaVersions.LogEntry.policy = "versioned";
    expect(collectStructuralViolations(matrix, basePkg())).toEqual([
      expect.stringContaining("LogEntry axis changed"),
    ]);
  });

  test("mutating the layout sentinel is caught", () => {
    const matrix = baseMatrix();
    matrix.layoutVersion.deferred = false;
    expect(collectStructuralViolations(matrix, basePkg())).toEqual([
      expect.stringContaining("layoutVersion sentinel changed"),
    ]);
  });

  test("mutating the corpus sentinel is caught", () => {
    const matrix = baseMatrix();
    matrix.corpusVersion.status = "introduced";
    expect(collectStructuralViolations(matrix, basePkg())).toEqual([
      expect.stringContaining("corpusVersion sentinel changed"),
    ]);
  });
});
