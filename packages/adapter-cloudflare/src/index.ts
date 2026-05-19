/**
 * Cloudflare Workers adapter for Baerly. Ships two `Storage` flavors:
 *
 *  - {@link r2BindingStorage} — fast path. In-cell R2 binding, no
 *    SigV4. Use when your Worker and bucket are in the same
 *    Cloudflare account.
 *  - {@link S3HttpStorage} — fallback. Plain S3 REST. Use for
 *    cross-cloud (AWS, GCS) or cross-account R2.
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

// Re-export the HTTP path so callers pick the flavor at construction
// time without pulling in @baerly/protocol directly.
export { S3HttpStorage } from "@baerly/protocol";
export type { S3HttpStorageOptions } from "@baerly/protocol";

// Worker module-default + Cron Trigger surface.
export { baerlyWorker } from "./worker.ts";
export type { BaerlyWorkerOptions, Env, WorkerHandler, WorkerScheduledHandler } from "./worker.ts";

// Dev-only convenience verifier. **Not** for production use — see
// the JSDoc on the helper itself.
export { singleTenantDevVerifier } from "./single-tenant-dev-verifier.ts";
