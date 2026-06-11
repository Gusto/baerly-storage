// Type declarations for the third-party-licenses manifest helpers.
// Consumed by `rolldown.config.ts` + `packages/cli/rolldown.config.ts`
// (the `.ts` configs need typed imports for `tsgo --noEmit`). The
// runtime lives in the sibling `.mjs`; see that file for the WHY.

export const REPO_ROOT: string;
export const DIST_DIR: string;
export const NOTICES_FILENAME: string;
export const PARTIAL_LIB_FILENAME: string;
export const PARTIAL_CLI_FILENAME: string;
export const ALLOWED_LICENSES: ReadonlySet<string>;

export function isUnacceptableLicense(licenseIdentifier: string | undefined | null): boolean;

export interface LicensePluginOptions {
  readonly outputFilename: string;
  readonly unacceptableLicenseTest: (licenseIdentifier: string) => boolean;
}

export function licensePluginOptions(outputFilename: string): LicensePluginOptions;
