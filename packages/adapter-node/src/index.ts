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
 * import { createServer } from "node:http";
 * import { createListener, S3HttpStorage } from "@baerly/adapter-node";
 * import type { Verifier } from "@baerly/protocol";
 * import { DOMParser } from "@xmldom/xmldom"; // app's own dep
 *
 * const verifier: Verifier = async (req) => {
 *   if (req.headers.get("authorization") !== "Bearer dev-token") return null;
 *   return { tenantPrefix: "acme", identity: { sub: "dev" } };
 * };
 *
 * const storage = new S3HttpStorage({
 *   endpoint: process.env.S3_ENDPOINT!,
 *   bucket: process.env.S3_BUCKET!,
 *   xmlParser: new DOMParser(),
 *   // sign: awsSigner.sign,  // omit for anonymous Minio
 * });
 * const listener = createListener({ app: "tickets", storage, verifier });
 * createServer(listener).listen(3000);
 * ```
 */
export { S3HttpStorage } from "@baerly/protocol";
export type { S3HttpStorageOptions } from "@baerly/protocol";
export { createListener, runMaintenanceTick } from "./server.ts";
export type { CreateListenerOptions, NodeMaintenanceOptions } from "./server.ts";
