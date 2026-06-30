/**
 * Storage selection is your app's policy, surfaced here as an editable
 * seam. The default is the library's `resolveStorageFromEnv`, in priority
 * order:
 *   1. R2_ACCOUNT_ID set → Cloudflare R2 (S3-compat endpoint)
 *   2. BUCKET set        → AWS S3
 *   3. neither, local dev → LocalFsStorage (zero credentials)
 *   4. neither, deployed  → throw. It never silently falls back to a
 *      non-durable store (local-fs or in-memory) in a deployment — that
 *      is the failure mode that loses data in production.
 *
 * Replace this re-export with your own `(env) => ResolvedStorage` if your
 * policy differs (a custom endpoint, MinIO, GCS, …). The resolver is
 * exported and tested in `@gusto/baerly-storage/node` so every app shares
 * one safe default instead of hand-rolling one.
 */
export { resolveStorageFromEnv as resolveStorage } from "@gusto/baerly-storage/node";
export type { ResolvedStorage } from "@gusto/baerly-storage/node";
