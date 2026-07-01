/**
 * Runtime-neutral S3-over-HTTP storage entry
 * (`@gusto/baerly-storage/s3`).
 *
 * Unlike `@gusto/baerly-storage/node`, this subpath's import closure
 * contains **no** `node:` builtins, so it bundles into a Cloudflare
 * Worker. Reach for it when a Worker must talk to S3 / cross-account
 * R2 over the S3 REST API instead of a native R2 binding.
 *
 * Bundle cost: pulls `aws4fetch` (SigV4) + `fast-xml-parser`. Workers
 * that use a same-account R2 binding should stay on
 * `@gusto/baerly-storage/cloudflare`, whose closure carries neither.
 *
 * The Worker-safety of this closure is enforced by the esbuild probe in
 * `tests/integration/s3-worker-safe.test.ts` — the layer linter does not
 * cover it (adapter-node is Node-only by design).
 */
export { S3HttpStorage } from "./s3-http.ts";
export type { S3HttpStorageOptions } from "./s3-http.ts";
export { sigV4Signer } from "./s3-signer.ts";
export type { SigV4SignerOptions } from "./s3-signer.ts";
