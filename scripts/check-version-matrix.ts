import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CURRENT_JSON_SCHEMA_VERSION,
  GC_PENDING_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
} from "../packages/protocol/src/constants.ts";
import { buildSpecIR } from "@baerly/server/_internal/spec-gen";

export const expectedLockstep = ["@gusto/baerly-storage", "@gusto/create-baerly-storage"] as const;

export type MatrixShape = {
  packageSemver: { value: string; lockstep: readonly string[] };
  specVersion: { value: string };
  schemaVersions: {
    "current.json": { value: number };
    "gc/pending.json": { value: number };
    snapshot: { value: number };
    // `policy` stays a plain string: it's a single-valued sentinel and the
    // drift test deliberately assigns an out-of-spec value to prove the
    // guard catches it — a one-member literal type would reject that test.
    LogEntry: { value: null; policy: string };
  };
  layoutVersion: { value: number; implicit: boolean; deferred: boolean };
  corpusVersion: { value: null; status: "not-yet-introduced" | "introduced"; introducedBy: string };
};

/** The live code-derived axes the matrix must not diverge from. */
export type CodeVersions = {
  packageVersion: string;
  specVersion: string;
  currentJson: number;
  gcPending: number;
  snapshot: number;
};

/** Package identity read from the two lockstep `package.json`s. */
export type PackageIdentity = {
  rootName: string;
  rootVersion: string;
  createName: string;
  createVersion: string;
};

/**
 * Structural invariants `--write` must NOT auto-fix: the package
 * lockstep, and the doc-only sentinels (LogEntry / layout / corpus).
 * Each names a conscious decision that needs an ADR, not a silent matrix
 * edit, so a mismatch blocks even regeneration. Returns human-readable
 * violation messages ([] = clean).
 *
 * Package semver's *value* is a governed drift axis (see
 * `collectDriftViolations`), not a structural one: `changeset:version`
 * regenerates it via `--write` on every bump, so a green tree always has
 * `matrix.packageSemver.value === package.json#version` — drift only
 * fires when a bump happened but regeneration didn't run. The lockstep
 * *shape* (which packages, and that they move together) is still
 * structural and lives here.
 */
export const collectStructuralViolations = (
  matrix: MatrixShape,
  pkg: PackageIdentity,
): string[] => {
  const out: string[] = [];
  if (pkg.rootName !== expectedLockstep[0]) {
    out.push(
      `root package name is ${JSON.stringify(pkg.rootName)} but matrix expects ${expectedLockstep[0]}`,
    );
  }
  if (pkg.createName !== expectedLockstep[1]) {
    out.push(
      `create package name is ${JSON.stringify(pkg.createName)} but matrix expects ${expectedLockstep[1]}`,
    );
  }
  if (pkg.createVersion !== pkg.rootVersion) {
    out.push(
      `packageSemver lockstep violated: ${pkg.createName} is ${pkg.createVersion} but ${pkg.rootName} is ${pkg.rootVersion}`,
    );
  }
  if (JSON.stringify(matrix.packageSemver.lockstep) !== JSON.stringify(expectedLockstep)) {
    out.push(
      `packageSemver.lockstep is ${JSON.stringify(matrix.packageSemver.lockstep)} but expected ${JSON.stringify(expectedLockstep)}`,
    );
  }

  // Doc-only sentinels: not derivable from a code constant. Assert they
  // hold their recorded values so a change forces a conscious edit + ADR.
  const logEntry = matrix.schemaVersions.LogEntry;
  if (logEntry.value !== null || logEntry.policy !== "versionless-additive-only") {
    out.push(
      "LogEntry axis changed; update docs/adr/005-logentry-versionless.md before changing the matrix",
    );
  }
  if (
    matrix.layoutVersion.value !== 1 ||
    matrix.layoutVersion.implicit !== true ||
    matrix.layoutVersion.deferred !== true
  ) {
    out.push(
      "layoutVersion sentinel changed; this needs an ADR-003 amendment, not a silent matrix edit",
    );
  }
  if (
    matrix.corpusVersion.value !== null ||
    matrix.corpusVersion.status !== "not-yet-introduced" ||
    matrix.corpusVersion.introducedBy !== "Tier B golden bucket fixtures"
  ) {
    out.push(
      "corpusVersion sentinel changed; introduce the Tier B corpus gate before changing the matrix",
    );
  }
  return out;
};

/**
 * Code-derived axes that MUST match the live reference implementation.
 * These are what `pnpm gen:version-matrix` refreshes. Returns
 * human-readable violation messages ([] = clean).
 */
export const collectDriftViolations = (matrix: MatrixShape, code: CodeVersions): string[] => {
  const checks: Array<[path: string, expected: string | number, actual: unknown]> = [
    ["packageSemver.value", code.packageVersion, matrix.packageSemver.value],
    ["specVersion.value", code.specVersion, matrix.specVersion.value],
    [
      "schemaVersions.current.json.value",
      code.currentJson,
      matrix.schemaVersions["current.json"].value,
    ],
    [
      "schemaVersions.gc/pending.json.value",
      code.gcPending,
      matrix.schemaVersions["gc/pending.json"].value,
    ],
    ["schemaVersions.snapshot.value", code.snapshot, matrix.schemaVersions.snapshot.value],
  ];
  const out: string[] = [];
  for (const [path, expected, actual] of checks) {
    if (actual !== expected) {
      out.push(`${path} is ${JSON.stringify(actual)} but code says ${JSON.stringify(expected)}`);
    }
  }
  return out;
};

type PackageShape = { name: string; version: string };

const readPackage = (path: string, fail: (msg: string) => never): PackageShape => {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PackageShape>;
  const { name, version } = parsed;
  if (typeof name === "string" && typeof version === "string") {
    return { name, version };
  }
  return fail(`${path} must contain string name + version`);
};

const runCli = (): void => {
  const here = dirname(fileURLToPath(import.meta.url));
  const artifactPath = resolve(here, "../docs/contributing/version-matrix.json");
  const pkgPath = resolve(here, "../package.json");
  const createPkgPath = resolve(here, "../packages/create-baerly-storage/package.json");
  const write = process.argv.includes("--write");

  const fail = (msgs: string | string[]): never => {
    for (const msg of Array.isArray(msgs) ? msgs : [msgs]) {
      console.error(`version-matrix: ${msg}`);
    }
    console.error(
      "To fix: reconcile docs/contributing/version-matrix.json with code, then run `pnpm gen:version-matrix` and commit.",
    );
    process.exit(1);
  };

  const rootPkg = readPackage(pkgPath, fail);
  const createPkg = readPackage(createPkgPath, fail);
  const code: CodeVersions = {
    packageVersion: rootPkg.version,
    specVersion: buildSpecIR().specVersion,
    currentJson: CURRENT_JSON_SCHEMA_VERSION,
    gcPending: GC_PENDING_SCHEMA_VERSION,
    snapshot: SNAPSHOT_SCHEMA_VERSION,
  };
  const pkg: PackageIdentity = {
    rootName: rootPkg.name,
    rootVersion: rootPkg.version,
    createName: createPkg.name,
    createVersion: createPkg.version,
  };

  let matrix: MatrixShape;
  try {
    matrix = JSON.parse(readFileSync(artifactPath, "utf8")) as MatrixShape;
  } catch (error) {
    return fail(`missing or invalid version-matrix.json: ${(error as Error).message}`);
  }

  // Structural violations block even `--write` — they can't be fixed by
  // regenerating the matrix.
  const structural = collectStructuralViolations(matrix, pkg);
  if (structural.length > 0) {
    fail(structural);
  }

  if (write) {
    matrix.packageSemver.value = pkg.rootVersion;
    matrix.specVersion.value = code.specVersion;
    matrix.schemaVersions["current.json"].value = code.currentJson;
    matrix.schemaVersions["gc/pending.json"].value = code.gcPending;
    matrix.schemaVersions.snapshot.value = code.snapshot;
    // Match oxfmt's canonical JSON form without shelling out to it: oxfmt
    // inlines short scalar arrays (e.g. `lockstep`) that JSON.stringify
    // expands one-element-per-line. Collapse innermost scalar arrays (no
    // nested objects/arrays) to a single line. format:check in the verify
    // chain is the backstop if oxfmt's wrapping ever diverges from this.
    const json = JSON.stringify(matrix, null, 2).replace(/\[\n[^[\]{}]*?\]/g, (block) =>
      block
        .replace(/\s*\n\s*/g, " ")
        .replace(/\[ /, "[")
        .replace(/ \]/, "]"),
    );
    writeFileSync(artifactPath, json + "\n");
    console.log("version-matrix: wrote docs/contributing/version-matrix.json");
    return;
  }

  const drift = collectDriftViolations(matrix, code);
  if (drift.length > 0) {
    fail(drift);
  }

  console.log(
    `version-matrix: ok (pkg ${pkg.rootVersion}, spec ${code.specVersion}, current.json v${code.currentJson}, gc v${code.gcPending}, snapshot v${code.snapshot})`,
  );
};

const invokedPath = process.argv[1];
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  runCli();
}
