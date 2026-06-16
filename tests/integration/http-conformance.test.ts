/**
 * HTTP conformance cascade — Node-side variant runner.
 *
 * Drives the shared {@link runHttpConformanceCascade} driver
 * (`tests/fixtures/http-conformance-cascade.ts`) against
 * `baerlyNode({ config, storage, verifier }).fetch` (mounted via
 * `getRequestListener` from `@hono/node-server`) over three Node-
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
 * Per variant we spin up a fresh
 * `http.createServer(getRequestListener(baerlyNode(...).fetch)).listen(0)`
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
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type BaerlyAppConfig,
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  getOrCreateMemoryStorageForBucket,
  MemoryStorage,
  type SchemaValidator,
  type Storage,
} from "@baerly/protocol";
import { getRequestListener } from "@hono/node-server";
import { LocalFsStorage } from "@baerly/dev";
import { baerlyNode, S3HttpStorage } from "@baerly/adapter-node";
import { Db } from "@baerly/server";
import { createRouter } from "@baerly/server/http";
import { withHttpObservability } from "@baerly/server/observability";
import { createBucket } from "../fixtures/s3-fixtures.ts";
import { runHttpConformanceCascade, type HttpFetch } from "../fixtures/http-conformance-cascade.ts";
import { CONFORMANCE_TENANT, testVerifier } from "../fixtures/test-verifier.ts";
import { MINIO_ENDPOINT } from "../setup/ports.ts";

const APP = "http-conf";

const stableConfig = {
  endpoint: MINIO_ENDPOINT,
  region: "eu-central-1",
  credentials: { accessKeyId: "baerly", secretAccessKey: "ZOAmumEzdsUUcVlQ" },
};

const minioEnabled = process.env["MINIO"] === "1";

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
      return {
        storage: new S3HttpStorage({
          endpoint: stableConfig.endpoint,
          bucket,
          sign: (req) => signer.sign(req),
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
              if (v === undefined) {
                continue;
              }
              if (Array.isArray(v)) {
                for (const item of v) {
                  resHeaders.append(k, item);
                }
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
            if (text.length > 0) {
              cReq.write(text);
            }
            cReq.end();
          },
          (error) => reject(error),
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
      // `tenant` mirrors `CONFORMANCE_TENANT` (the prefix the shared
      // `testVerifier` pins every authorized request to) so any
      // tenant-derived bookkeeping inside the kernel agrees with the
      // wire. `auth` is placeholder — the explicit `verifier:`
      // override below wins in `resolveVerifier`. `target: "node"` is
      // a required field on `BaerlyAppConfig` but is only read by
      // `baerly deploy` / `baerly doctor`; the runtime adapter
      // ignores it.
      const config: BaerlyAppConfig = {
        app: APP,
        tenant: CONFORMANCE_TENANT,
        target: "node",
        auth: "none",
        collections: {},
      };
      const requestHandler = baerlyNode({
        config,
        storage: made.storage,
        verifier: testVerifier(),
        // Drive the long-poll idle budget down from the 25s default
        // so the cascade's idle-poll wire-shape test (two back-to-
        // back idle polls + cursor-stability assertion) finishes
        // in ~1.2s per variant instead of timing out the suite.
        // The existing race-write test (~50ms write latency vs.
        // the previous 25s budget) still fits comfortably under
        // 500ms; the fast-path test returns immediately and is
        // unaffected.
        sinceTimeoutMs: 500,
        sincePollIntervalMs: 50,
      }).fetch;
      server = createServer(getRequestListener(requestHandler));
      await new Promise<void>((resolve) => server!.listen(0, resolve));
      port = (server!.address() as AddressInfo).port;
    });

    afterAll(async () => {
      if (server !== undefined) {
        await new Promise<void>((resolve, reject) => {
          server!.close((err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        });
      }
      if (cleanup) {
        await cleanup();
      }
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
          tail_hint: 0,
          log_seq_start: 0,
          writer_fence: { epoch: 0, owner: "http-conformance-test", claimed_at: "" },
          snapshot_bytes: 0,
          snapshot_rows: 0,
        });
      },
      options: {
        // `baerlyNode` above passes `sinceTimeoutMs: 500`, so the
        // cascade's idle-poll test fits inside the vitest default
        // timeout. The Workerd-side variant pins this `false` because
        // `baerlyWorker` does not thread the override through.
        supportsSinceTimeoutOverride: true,
        // Pre-seed tail_hint and log_seq_start to `nextSeq` so the
        // overflow regression test only needs ONE insert instead of
        // 1025 sequential HTTP round-trips. Without this the local-fs
        // backend's per-write maintenance overhead (~80ms/write) would
        // push the test over its 30s budget.
        provisionTableAtSeq: async (table, nextSeq) => {
          // Synthetic current.json: snapshot is null, log_seq_start=nextSeq,
          // so readers walk [nextSeq, tail_hint) and treat 0..nextSeq-1 as
          // already truncated/folded away — not snapshotted. This state is
          // deliberately outside what the writer emits (log_seq_start > 0
          // normally implies snapshot !== null), used only to fast-forward
          // the seq counter for the overflow regression test.
          const key = `app/${APP}/tenant/${CONFORMANCE_TENANT}/manifests/${table}/current.json`;
          await createCurrentJson(storage!, key, {
            schema_version: CURRENT_JSON_SCHEMA_VERSION,
            snapshot: null,
            tail_hint: nextSeq,
            log_seq_start: nextSeq,
            writer_fence: { epoch: 0, owner: "http-conformance-test", claimed_at: "" },
            snapshot_bytes: 0,
            snapshot_rows: 0,
          });
        },
      },
    });
  });
}

/**
 * Schema-bound HTTP boundary. The adapters (`@baerly/adapter-node` /
 * `@baerly/adapter-cloudflare`) build a fresh `Db` per request and
 * don't yet thread `schemas` through their factory options, so this
 * block constructs the router directly over `MemoryStorage` + a
 * pre-configured schema-bound `Db`. The assertion is on the WIRE
 * shape: a `SchemaError` carries a 400 status and the
 * `HttpErrorEnvelope` body's `issues[]` array reaches the client.
 */
describe("HTTP boundary — schema validation (ticket 70)", () => {
  test("POST with schema-violating doc returns 400 + issues[]", async () => {
    const STATUS_SCHEMA: SchemaValidator = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (v) => {
          if (typeof v !== "object" || v === null) {
            return { issues: [{ message: "expected object" }] };
          }
          const o = v as Record<string, unknown>;
          if (o["status"] !== "open" && o["status"] !== "closed") {
            return {
              issues: [{ path: ["status"], message: 'expected "open" or "closed"' }],
            };
          }
          return { value: o };
        },
      },
    };

    const APP_NAME = "http-schema";
    const TENANT = "schema-tenant";
    const TABLE = "tickets";
    const memStorage = new MemoryStorage();
    await createCurrentJson(
      memStorage,
      `app/${APP_NAME}/tenant/${TENANT}/manifests/${TABLE}/current.json`,
      {
        schema_version: CURRENT_JSON_SCHEMA_VERSION,
        snapshot: null,
        tail_hint: 0,
        log_seq_start: 0,
        writer_fence: { epoch: 0, owner: "http-schema-test", claimed_at: "" },
        snapshot_bytes: 0,
        snapshot_rows: 0,
      },
    );

    const db = Db.create({
      storage: memStorage,
      app: APP_NAME,
      tenant: TENANT,
      config: { collections: { [TABLE]: { schema: STATUS_SCHEMA } } },
    });
    const app = createRouter({ db });

    // Invalid doc: `status` violates the schema.
    const badReq = new Request(`http://test.local/v1/c/${TABLE}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ doc: { status: "bogus" } }),
    });
    const badRes = await withHttpObservability(badReq, (r) => app.fetch(r));
    expect(badRes.status).toBe(400);
    const badBody = (await badRes.json()) as {
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly issues?: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>;
      };
    };
    expect(badBody.error.code).toBe("SchemaError");
    expect(badBody.error.issues).toBeDefined();
    expect(badBody.error.issues?.[0]?.path).toEqual(["status"]);
    expect(badBody.error.issues?.[0]?.message).toContain("open");

    // Valid doc: the same route accepts a schema-compliant body.
    const okReq = new Request(`http://test.local/v1/c/${TABLE}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ doc: { status: "open" } }),
    });
    const okRes = await withHttpObservability(okReq, (r) => app.fetch(r));
    expect(okRes.status).toBe(201);
  });
});
