// Type declarations for the regex-based package-layer linter. Consumed by
// `tests/unit/lint-package-layers.test.ts` so the pure-function entrypoint
// can be unit-tested in-process. The script itself runs as a CLI in
// `pnpm verify` / `pnpm verify:agent` — see docs/contributing/architecture.md (§Package layers).

export interface PackageImportFile {
  readonly path: string;
  readonly source: string;
  readonly ownerPkg: string;
}

export interface PackageLayerViolation {
  readonly path: string;
  readonly ownerPkg: string;
  readonly importedPkg: string;
  readonly allowed: readonly string[];
}

export function findViolations(files: readonly PackageImportFile[]): PackageLayerViolation[];

export function formatViolation(v: PackageLayerViolation): string;
