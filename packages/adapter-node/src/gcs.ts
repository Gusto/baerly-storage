/**
 * Curated GCS-over-HTTP storage entry (`@gusto/baerly-storage/gcs`).
 *
 * The GCS family barrel: `GcsHttpStorage` + its GOOG4-HMAC-SHA256
 * signer, mirroring how `@gusto/baerly-storage/s3` pairs
 * `S3HttpStorage` with `sigV4Signer`. Import from here rather than the
 * broad `/node` barrel (which drags `node:http`) when you only need
 * the GCS `Storage` impl and its signer.
 *
 * Node-only in v1. GCS's native XML API + generation-based conditional
 * writes are the supported path only under Node; unlike `/s3`, this
 * subpath is NOT declared a Worker target and is not covered by the
 * `s3-worker-safe` bundling probe. (Its closure happens to carry no
 * `node:` builtins — it pulls only `@rgrove/parse-xml` + WebCrypto —
 * but Worker portability is unclaimed and unverified for v1.)
 */
export { GcsHttpStorage, DEFAULT_GCS_ENDPOINT } from "./gcs-http.ts";
export type { GcsHttpStorageOptions } from "./gcs-http.ts";
export { goog4Signer } from "./credentials/goog4-signer.ts";
export type { Goog4SignerOptions } from "./credentials/goog4-signer.ts";
export type { GcsVersioningStatus } from "./gcs-admin.ts";
