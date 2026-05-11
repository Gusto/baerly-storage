/**
 * HTTP conformance cascade — Node-side variant runner.
 *
 * Drives the shared {@link runHttpConformanceCascade} driver
 * (`tests/fixtures/http-conformance-cascade.ts`) against
 * `createListener({ app, storage, verifier })` over three Node-
 * runnable storage backends:
 *
 *   - `memory`    — `MemoryStorage`; zero infra.
 *   - `local-fs`  — `LocalFsStorage` over a fresh `mkdtemp` root.
 *   - `node-minio`— `S3HttpStorage` against the local Minio (gated on
 *                   `MINIO=1`; assumes `pnpm dev:storage` is up).
 *
 * The fourth adapter (`cloudflare-r2`) runs under the
 * `cloudflare-pool` vitest project — see
 * `packages/adapter-cloudflare/src/http-conformance.test.ts`.
 *
 * Per variant we spin up a fresh `http.createServer(listener).listen(0)`
 * inside a top-level `describe(variant.label, ...)` block. The cascade
 * registers its own `describe`/`test` blocks at vitest collection
 * time, so the server boot has to happen in a `beforeAll` that runs
 * before any nested test body fires; the port is captured in a
 * closure-scoped `let` and read from the cascade's `fetch` shim.
 */

import { createServer, request as nodeRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AwsClient } from "aws4fetch";
import { DOMParser } from "@xmldom/xmldom";
import { afterAll, beforeAll, describe } from "vitest";
import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  getOrCreateMemoryStorageForBucket,
  S3HttpStorage,
  type Storage,
} from "@baerly/protocol";
import { LocalFsStorage } from "@baerly/dev";
import { createListener } from "@baerly/adapter-node";
import { createBucket } from "../fixtures/s3-fixtures";
import { runHttpConformanceCascade, type HttpFetch } from "../fixtures/http-conformance-cascade";
import { CONFORMANCE_TENANT, testVerifier } from "../fixtures/test-verifier";

const APP = "http-conf";

const stableConfig = {
  endpoint: "http://127.0.0.1:9102",
  region: "eu-central-1",
  credentials: { accessKeyId: "mps3", secretAccessKey: "ZOAmumEzdsUUcVlQ" },
};

const minioEnabled = process.env.MINIO === "1";

interface Variant {
  readonly label: "memory" | "local-fs" | "node-minio";
  readonly requiresMinio?: boolean;
  readonly makeStorage: (bucket: string) => Promise<{
    readonly storage: Storage;
    readonly cleanup?: () => Promise<void>;
  }>;
}

const allVariants: Variant[] = [
  {
    label: "memory",
    makeStorage: async (bucket) => ({
      storage: getOrCreateMemoryStorageForBucket(bucket),
    }),
  },
  {
    label: "local-fs",
    makeStorage: async () => {
      const root = await mkdtemp(join(tmpdir(), "baerly-http-"));
      return {
        storage: new LocalFsStorage({ root }),
        cleanup: async () => {
          await rm(root, { recursive: true, force: true }).catch(() => {
            // Best-effort cleanup; a stale tmp dir under a crashed
            // worker doesn't fail the test.
          });
        },
      };
    },
  },
  {
    label: "node-minio",
    requiresMinio: true,
    makeStorage: async (bucket) => {
      const signer = new AwsClient({
        accessKeyId: stableConfig.credentials.accessKeyId,
        secretAccessKey: stableConfig.credentials.secretAccessKey,
        region: "us-east-1",
        service: "s3",
      });
      await createBucket(signer, stableConfig.endpoint, bucket);
      const xmlParser = new DOMParser();
      return {
        storage: new S3HttpStorage({
          endpoint: stableConfig.endpoint,
          bucket,
          sign: (req) => signer.sign(req),
          xmlParser,
        }),
      };
    },
  },
];

const variants = allVariants.filter((v) => !v.requiresMinio || minioEnabled);

/**
 * Translate a WHATWG `Request` into a `node:http.request(...)` against
 * `127.0.0.1:<port>` and the response back into a WHATWG `Response`.
 *
 * Carries the inbound `AbortSignal` through to the underlying
 * `ClientRequest.destroy(...)` so the cascade's pre-aborted block
 * surfaces a rejection. Multi-value response headers are passed
 * through verbatim — vitest-pool-workers' `set-cookie`-style array
 * shape isn't a Node-side concern but the use of `.append` keeps the
 * shim consistent across runtimes.
 */
const nodeFetch =
  (port: number): HttpFetch =>
  (req: Request) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        headers[key] = value;
      });

      const cReq = nodeRequest(
        {
          host: "127.0.0.1",
          port,
          method: req.method,
          path: `${url.pathname}${url.search}`,
          headers,
        },
        (cRes) => {
          const chunks: Buffer[] = [];
          cRes.on("data", (c: Buffer) => chunks.push(c));
          cRes.on("end", () => {
            const buf = Buffer.concat(chunks);
            const resHeaders = new Headers();
            for (const [k, v] of Object.entries(cRes.headers)) {
              if (v === undefined) continue;
              if (Array.isArray(v)) {
                for (const item of v) resHeaders.append(k, item);
              } else {
                resHeaders.set(k, v);
              }
            }
            // 204/304 carry no body. Constructing a `Response` with an
            // empty `ArrayBuffer` on those status codes is illegal per
            // the Fetch spec (`Response.body` is null for null-body
            // statuses); use `null` directly.
            const status = cRes.statusCode ?? 0;
            const nullBody = status === 204 || status === 304 || status === 205;
            resolve(
              new Response(nullBody ? null : new Uint8Array(buf), {
                status,
                statusText: cRes.statusMessage,
                headers: resHeaders,
              }),
            );
          });
          cRes.on("error", reject);
        },
      );

      cReq.on("error", reject);

      const onAbort = (): void => {
        cReq.destroy(new Error("aborted"));
      };
      if (req.signal.aborted) {
        onAbort();
        return;
      }
      req.signal.addEventListener("abort", onAbort, { once: true });

      // Body: GET/HEAD/DELETE typically have no body — only write one
      // when there's something to send. `req.text()` resolves to "" on
      // body-less requests in both Node and Workerd.
      if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "DELETE") {
        void req.text().then(
          (text) => {
            if (text.length > 0) cReq.write(text);
            cReq.end();
          },
          (err) => reject(err),
        );
      } else {
        cReq.end();
      }
    });

const freshBucketName = (label: string): string =>
  `http-${label}-${Math.floor(Math.random() * 0x1_0000_0000)
    .toString(16)
    .padStart(8, "0")}`;

for (const variant of variants) {
  describe(variant.label, () => {
    let server: Server | undefined;
    let port = 0;
    let storage: Storage | undefined;
    let cleanup: (() => Promise<void>) | undefined;

    beforeAll(async () => {
      const bucket = freshBucketName(variant.label);
      const made = await variant.makeStorage(bucket);
      storage = made.storage;
      cleanup = made.cleanup;
      server = createServer(
        createListener({ app: APP, storage: made.storage, verifier: testVerifier() }),
      );
      await new Promise<void>((resolve) => server!.listen(0, resolve));
      port = (server!.address() as AddressInfo).port;
    });

    afterAll(async () => {
      if (server !== undefined) {
        await new Promise<void>((resolve, reject) => {
          server!.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }
      if (cleanup) await cleanup();
    });

    runHttpConformanceCascade({
      name: variant.label,
      // `port` and `storage` are `0`/`undefined` at collection time
      // and populated by `beforeAll` before any nested test body
      // fires; the closures read the live values when invoked.
      fetch: (req) => nodeFetch(port)(req),
      provisionTable: async (table) => {
        const key = `app/${APP}/tenant/${CONFORMANCE_TENANT}/manifests/${table}/current.json`;
        await createCurrentJson(storage!, key, {
          schema_version: CURRENT_JSON_SCHEMA_VERSION,
          snapshot: null,
          next_seq: 0,
          writer_fence: { epoch: 0, owner: "http-conformance-test", claimed_at: "" },
        });
      },
    });
  });
}
