/**
 * `@baerly/adapter-node` — Node host adapter for `@baerly/server`.
 *
 * Re-exports the runtime-appropriate `Storage` impls and a
 * `node:http` mount factory. Pairs with `@baerly/adapter-cloudflare`,
 * which provides the same surface for Workers + R2 bindings.
 *
 * Phase 3: `createListener` serves `GET /v1/healthz` only; all other
 * `/v1/*` paths return `501 Not Implemented`. The full `Routes`
 * contract lands in a later phase; the `(app, tenant, storage)`
 * boundary is stable.
 *
 * @example
 * ```ts
 * import { createServer } from "node:http";
 * import { createListener, S3HttpStorage } from "@baerly/adapter-node";
 * import { DOMParser } from "@xmldom/xmldom"; // app's own dep
 *
 * const storage = new S3HttpStorage({
 *   endpoint: process.env.S3_ENDPOINT!,
 *   bucket: process.env.S3_BUCKET!,
 *   xmlParser: new DOMParser(),
 *   // sign: awsSigner.sign,  // omit for anonymous Minio
 * });
 * const listener = createListener({ app: "tickets", tenant: "acme", storage });
 * createServer(listener).listen(3000);
 * ```
 */
export { LocalFsStorage } from "@baerly/dev";
export type { LocalFsStorageOptions } from "@baerly/dev";
export { S3HttpStorage } from "@baerly/protocol";
export type { S3HttpStorageOptions } from "@baerly/protocol";
export { createListener } from "./server";
export type { CreateListenerOptions } from "./server";
