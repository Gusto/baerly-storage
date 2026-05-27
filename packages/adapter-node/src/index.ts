/**
 * `@baerly/adapter-node` — Node host adapter for `@baerly/server`.
 *
 * Re-exports the runtime-appropriate `Storage` impls and a Hono-based
 * mount factory. Pairs with `@baerly/adapter-cloudflare`, which
 * provides the same surface for Workers + R2 bindings.
 *
 * `createApp` builds a Hono app that serves the full CRUD surface
 * (`/v1/t/:table[/:id]`) plus an anonymous `/v1/healthz` probe via
 * the shared `createRouter` factory from `@baerly/server`. The
 * caller threads a `Verifier` through `createApp({ verifier })` to
 * resolve the per-request tenant; the `(app, storage, verifier)`
 * boundary is stable. The returned `Hono` exposes `.fetch` (a
 * `(req: Request) => Promise<Response>` handler) so the same factory
 * mounts under any Fetch host.
 *
 * @example
 * ```ts
 * // One-call host helper — the 90% default. Mirrors `baerlyWorker`
 * // from `@gusto/baerly-storage/cloudflare`. Composes `createApp` +
 * // `@hono/node-server`'s `serve()` + SIGTERM/SIGINT handlers +
 * // per-(tenant, collection) maintenance.
 * import { baerlyNode, s3Storage } from "@gusto/baerly-storage/node";
 * import { sharedSecret } from "@gusto/baerly-storage/auth";
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
 * // Advanced: mount the baerly cascade under any Fetch host.
 * import { Hono } from "hono";
 * import { createApp, s3Storage } from "@gusto/baerly-storage/node";
 * import type { Verifier } from "baerly-storage";
 *
 * const verifier: Verifier = async (req) => {
 *   if (req.headers.get("authorization") !== "Bearer dev-token") return null;
 *   return { tenantPrefix: "acme", identity: { sub: "dev" } };
 * };
 *
 * const baerly = createApp({
 *   app: "tickets",
 *   storage: s3Storage({ ... }),
 *   verifier,
 * });
 *
 * // Option A: hand the Fetch handler to any Fetch host
 * // (Cloudflare Workers, Bun.serve, Deno.serve, etc.).
 * export default { fetch: baerly.fetch };
 *
 * // Option B: mount under another Hono app.
 * const app = new Hono();
 * app.route("/", baerly);
 *
 * // Option C: get a Node http listener.
 * import { createServer } from "node:http";
 * import { getRequestListener } from "@hono/node-server";
 * createServer(getRequestListener(baerly.fetch)).listen(3000);
 * ```
 *
 * Advanced users who need to override the `fetch` / `xmlParser` /
 * retry knobs can construct `S3HttpStorage` directly — see the
 * `S3HttpStorageOptions` JSDoc. The four factories above wrap the
 * common case for AWS S3, R2, Minio, and GCS.
 */
export { S3HttpStorage } from "./s3-http.ts";
export type { S3HttpStorageOptions } from "./s3-http.ts";
export { runMaintenanceTick } from "./server.ts";
export type { NodeMaintenanceOptions } from "./server.ts";
export { createApp } from "./app.ts";
export type { CreateAppOptions } from "./app.ts";
export { s3Storage, r2Storage, minioStorage, gcsStorage } from "./storage-factories.ts";
export { baerlyNode } from "./baerly-node.ts";
export type { BaerlyNodeHandle, BaerlyNodeMaintenance, BaerlyNodeOptions } from "./baerly-node.ts";
