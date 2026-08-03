export type Stage0FixtureContract =
  | "snapshot"
  | "log"
  | "current-json"
  | "restore"
  | "dump"
  | "export"
  | "mixed-version";

/** One frozen artifact bound to its bytes. This is the hash-binding record. */
export interface Stage0HashBinding {
  /** POSIX-separated path relative to the corpus root. Never absolute. */
  readonly path: string;
  /** Exact byte length on disk. */
  readonly bytes: number;
  /** Lowercase hex SHA-256 of the raw bytes — no parse, no reserialize. */
  readonly sha256: string;
  readonly contract: Stage0FixtureContract;
}

export interface Stage0CompatibilityManifest {
  readonly schema: "baerly.fold-stage0-compatibility/v1";
  readonly frozen_subject_commit: string;
  readonly capture_tool_sha256: string;
  readonly package_version: string;
  readonly files: readonly Stage0HashBinding[];
}

export interface CaptureIndexEntry extends Stage0HashBinding {}

export interface Stage0CaptureProvenanceInput {
  readonly frozenSubjectCommit: string;
  readonly captureToolPath: string;
  readonly captureToolSha256: string;
  readonly rootPackageVersion: string;
  readonly lockfileSha256: string;
  readonly nodeVersion: string;
  readonly pnpmVersion: string;
}

export interface Stage0CaptureSuccessResult {
  readonly captured_at_utc: string;
  readonly corpus_manifest_sha256: string;
  readonly corpus_file_count: number;
  readonly frozen_subject_commit: string;
  readonly capture_provenance_sha256: string;
}

export const EXPECTED_CAPTURE_PATHS: readonly string[];

export function hashBytes(bytes: Uint8Array): string;
export function assertCorpusRelativePath(path: string): void;
export function assertNoDuplicatePaths(files: readonly Stage0HashBinding[]): void;
export function assertOutputRootContained(fixtureRoot: string, outputRoot: string): void;
export function assertCaptureIndex(files: readonly CaptureIndexEntry[]): void;
export function readCapturedPayloads(
  childRoot: string,
  files: readonly CaptureIndexEntry[],
): readonly { readonly binding: Stage0HashBinding; readonly bytes: Uint8Array }[];
export function writePayloadExclusive(root: string, relPath: string, bytes: Uint8Array): void;
export function assertCleanSubjectWorktree(porcelainStatus: string): void;
export function assertSubjectCommitMatches(requested: string, actual: string): void;
export function assertSubjectWorktreeState(input: {
  readonly requestedCommit: string;
  readonly actualCommit: string;
  readonly branchName: string;
  readonly subjectWorktree: string;
  readonly implementationWorktree: string;
}): void;
export function sanitizeCaptureEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function buildCaptureProvenanceBytes(input: Stage0CaptureProvenanceInput): Uint8Array;
export function writeCaptureProvenanceExclusive(path: string, bytes: Uint8Array): void;
export function buildCaptureSuccessResult(input: {
  readonly capturedAtUtc: string;
  readonly manifestBytes: Uint8Array;
  readonly corpusFileCount: number;
  readonly frozenSubjectCommit: string;
  readonly provenanceBytes: Uint8Array;
}): Stage0CaptureSuccessResult;
export function assertOutputDirectoryEmpty(dir: string): void;
export function buildManifest(input: {
  readonly frozenSubjectCommit: string;
  readonly captureToolSha256: string;
  readonly packageVersion: string;
  readonly files: readonly Stage0HashBinding[];
}): Stage0CompatibilityManifest;
export function main(): Promise<void>;
