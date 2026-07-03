/**
 * Cloudflare Workers adapter for baerly-storage. Ships the R2-binding
 * `Storage` flavor (`r2BindingStorage`) for in-cell R2 access
 * without SigV4 — the dominant path when your Worker and bucket
 * are in the same Cloudflare account.
 *
 * Cross-cloud, cross-account, or S3-instead-of-R2 from a Worker? Import
 * `S3HttpStorage` + `sigV4Signer` from the Worker-safe
 * `@gusto/baerly-storage/s3` subpath and pass the instance as
 * `baerlyWorker((env) => ({ config, storage }))`. That subpath pulls
 * `aws4fetch` + `@rgrove/parse-xml` (SigV4 + XML), which is why it is not
 * re-exported here: the closure of `@gusto/baerly-storage/cloudflare`
 * stays peer-free so same-account R2-binding consumers don't carry those
 * bytes. Do NOT import from `@gusto/baerly-storage/node` in a Worker —
 * that barrel drags `node:http` / `node:path`.
 *
 * The `fetch(req, env, ctx)` Worker mount lives at the `/worker`
 * subpath: `import { baerlyWorker } from "@baerly/adapter-cloudflare/worker"`.
 * The adapter ships the full CRUD surface via the shared
 * `createRouter` factory in `@baerly/server`; callers thread a
 * `Verifier` through `baerlyWorker((env) => ({ verifier }))` to
 * resolve the tenant per request.
 */
export { r2BindingStorage } from "./r2-binding-storage.ts";
export type { R2BindingStorageOptions } from "./r2-binding-storage.ts";

// Worker module-default + Cron Trigger surface. `resolveCfMaintenanceProfile`
// is the cron-profile helper callers thread into the scheduled handler.
export { baerlyWorker, resolveCfMaintenanceProfile } from "./worker.ts";
export type { BaerlyEnv, BaerlyWorkerOptions, WorkerScheduledHandler } from "./worker.ts";
