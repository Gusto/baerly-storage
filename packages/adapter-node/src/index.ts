/**
 * `@baerly/adapter-node` — Node host adapter for `@baerly/server`.
 *
 * Re-exports the runtime-appropriate `Storage` impls and a
 * `node:http` mount factory. Pairs with `@baerly/adapter-cloudflare`,
 * which provides the same surface for Workers + R2 bindings.
 *
 * `createListener` serves the full CRUD surface
 * (`/v1/t/:table[/:id]`) plus an anonymous `/v1/healthz` probe via
 * the shared `createRouter` factory from `@baerly/server`. The
 * caller threads a `Verifier` through `createListener({ verifier })`
 * to resolve the per-request tenant; the `(app, storage, verifier)`
 * boundary is stable.
 *
 * @example
 * ```ts
 * // One-call host helper — the 90% default. Mirrors `baerlyWorker`
 * // from `baerly-storage/cloudflare`. Composes `createListener` +
 * // `node:http` + SIGTERM/SIGINT handlers + per-(tenant, collection)
 * // maintenance.
 * import { baerlyNode, s3Storage } from "baerly-storage/node";
 * import { sharedSecret } from "baerly-storage/auth";
 *
 * const handle = baerlyNode({
 *   app: "tickets",
 *   storage: s3Storage({
 *     region: "us-east-1",
 *     bucket: process.env["BUCKET"]!,
 *     accessKeyId: process.env["AWS_ACCESS_KEY_ID"]!,
 *     secretAccessKey: process.env["AWS_SECRET_ACCESS_KEY"]!,
 *   }),
 *   verifier: sharedSecret({
 *     secret: process.env["SHARED_SECRET"]!,
 *     tenantPrefix: "acme",
 *   }),
 *   maintenance: { tenants: ["acme"], collections: ["tickets"] },
 * });
 * await handle.listen(Number(process.env["PORT"] ?? 8080));
 * ```
 *
 * @example
 * ```ts
 * // Low-level seam for callers who want manual control over the
 * // server lifecycle (cluster mode, custom signal handling, etc.).
 * import { createServer } from "node:http";
 * import { createListener, s3Storage } from "baerly-storage/node";
 * import type { Verifier } from "baerly-storage";
 *
 * const verifier: Verifier = async (req) => {
 *   if (req.headers.get("authorization") !== "Bearer dev-token") return null;
 *   return { tenantPrefix: "acme", identity: { sub: "dev" } };
 * };
 *
 * const storage = s3Storage({
 *   region: "us-east-1",
 *   bucket: process.env["BUCKET"]!,
 *   accessKeyId: process.env["AWS_ACCESS_KEY_ID"]!,
 *   secretAccessKey: process.env["AWS_SECRET_ACCESS_KEY"]!,
 * });
 * const listener = createListener({ app: "tickets", storage, verifier });
 * createServer(listener).listen(3000);
 * ```
 *
 * @example
 * ```ts
 * // Mount the baerly /v1/* cascade under any Fetch host (Hono shown;
 * // Express, h3, and friends compose the same way).
 * import { Hono } from "hono";
 * import { createFetchHandler, s3Storage } from "baerly-storage/node";
 *
 * const baerly = createFetchHandler({
 *   app: "tickets",
 *   storage: s3Storage({ ... }),
 *   verifier,
 * });
 * const app = new Hono();
 * app.all("/v1/*", (c) => baerly(c.req.raw));
 * ```
 *
 * Advanced users who need to override the `fetch` / `xmlParser` /
 * retry knobs can construct `S3HttpStorage` directly — see the
 * `S3HttpStorageOptions` JSDoc. The four factories above wrap the
 * common case for AWS S3, R2, Minio, and GCS.
 */
export { S3HttpStorage } from "@baerly/protocol";
export type { S3HttpStorageOptions } from "@baerly/protocol";
export { createFetchHandler, createListener, runMaintenanceTick } from "./server.ts";
export type {
  CreateFetchHandlerOptions,
  CreateListenerOptions,
  NodeMaintenanceOptions,
} from "./server.ts";
export { s3Storage, r2Storage, minioStorage, gcsStorage } from "./storage-factories.ts";
export { baerlyNode } from "./baerly-node.ts";
export type { BaerlyNodeHandle, BaerlyNodeMaintenance, BaerlyNodeOptions } from "./baerly-node.ts";
