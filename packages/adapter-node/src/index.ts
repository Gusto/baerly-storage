/**
 * `@baerly/adapter-node` — Node host adapter for `@baerly/server`.
 *
 * Re-exports the runtime-appropriate `Storage` impls and the one-call
 * host helper. Pairs with `@baerly/adapter-cloudflare`, which provides
 * the same surface for Workers + R2 bindings.
 *
 * `baerlyNode` is the public seam. It composes the kernel router with
 * `@hono/node-server`'s `serve()`, SIGTERM/SIGINT handlers, and
 * per-(tenant, collection) maintenance into a single handle. The
 * returned `BaerlyNodeHandle` exposes `.fetch` for in-process embedding
 * (Vite middleware, custom servers, tests) and `.listen(port)` for the
 * standard standalone-server case. The `serve()` call is lazy — calling
 * `baerlyNode(opts)` builds the Hono app + resolves the verifier but
 * does not create an `http.Server` until `.listen()` runs.
 *
 * @example
 * ```ts
 * import { baerlyNode, s3Storage } from "@gusto/baerly-storage/node";
 * import config from "./baerly.config.ts";
 *
 * const handle = baerlyNode({
 *   config,
 *   storage: s3Storage({
 *     region: "us-east-1",
 *     bucket: process.env["BUCKET"]!,
 *     credentials: {
 *       accessKeyId: process.env["AWS_ACCESS_KEY_ID"]!,
 *       secretAccessKey: process.env["AWS_SECRET_ACCESS_KEY"]!,
 *     },
 *   }),
 *   maintenance: { tenants: ["acme"], collections: ["tickets"] },
 * });
 * await handle.listen(Number(process.env["PORT"] ?? 8080));
 * ```
 *
 * Advanced users who need to override the `fetch` / retry knobs can
 * construct `S3HttpStorage` directly — see the `S3HttpStorageOptions`
 * JSDoc. The four factories (`s3Storage`, `r2Storage`, `minioStorage`,
 * `gcsStorage`) wrap the common case for AWS S3, R2, Minio, and GCS.
 */
export { S3HttpStorage } from "./s3-http.ts";
export type { S3HttpStorageOptions } from "./s3-http.ts";
export { runMaintenanceTick } from "./server.ts";
export type { NodeMaintenanceOptions } from "./server.ts";
export { s3Storage, r2Storage, minioStorage, gcsStorage } from "./storage-factories.ts";
export { baerlyNode } from "./baerly-node.ts";
export type { BaerlyNodeHandle, BaerlyNodeMaintenance, BaerlyNodeOptions } from "./baerly-node.ts";
