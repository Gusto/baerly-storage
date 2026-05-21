/**
 * Cloudflare Workers adapter for Baerly. Ships the R2-binding
 * `Storage` flavor (`r2BindingStorage`) for in-cell R2 access
 * without SigV4 — the dominant path when your Worker and bucket
 * are in the same Cloudflare account.
 *
 * Cross-cloud or cross-account R2 from a Worker? Import
 * `S3HttpStorage` directly from `baerly-storage/node`. That path
 * pulls `aws4fetch` and `@xmldom/xmldom`, which is why it is not
 * re-exported here: the closure of `baerly-storage/cloudflare`
 * stays peer-free so R2-only consumers don't carry the SigV4 +
 * XML parser bytes.
 *
 * The `fetch(req, env, ctx)` Worker mount lives at the `/worker`
 * subpath: `import { baerlyWorker } from "@baerly/adapter-cloudflare/worker"`.
 * The adapter ships the full CRUD surface via the shared
 * `createRouter` factory in `@baerly/server`; callers thread a
 * `Verifier` through `baerlyWorker({ verifier })` to resolve the
 * tenant per request.
 */
export { r2BindingStorage } from "./r2-binding-storage.ts";
export type { R2BindingStorageOptions } from "./r2-binding-storage.ts";

// Worker module-default + Cron Trigger surface.
export { baerlyWorker } from "./worker.ts";
export type { BaerlyEnv, BaerlyWorkerOptions, WorkerScheduledHandler } from "./worker.ts";

// Dev-only convenience verifier. **Not** for production use — see
// the JSDoc on the helper itself.
export { singleTenantDevVerifier } from "./single-tenant-dev-verifier.ts";
