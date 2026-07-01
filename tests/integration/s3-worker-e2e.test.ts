/**
 * S3-from-a-Worker, end to end — the *composition* proof.
 *
 * `s3-worker-wire.test.ts` proves `S3HttpStorage` runs inside Workerd;
 * `packages/adapter-cloudflare/src/worker-storage.test.ts` proves
 * `resolveWorkerStorage` picks the injected instance. This test wires the
 * two together: it builds a real `baerlyWorker` with an injected
 * `S3HttpStorage` (and **no** `env.BUCKET`), drives an HTTP insert + read
 * through the Worker's `fetch`, and asserts the round-trip flowed through
 * the injected storage — i.e. the factory `storage` option reaches the
 * per-request `Db` and the traffic hit S3, not an R2 binding.
 *
 * This is the seam a Worker author actually uses:
 *
 *   baerlyWorker((env) => ({ config, storage: new S3HttpStorage(...) }))
 *
 * Runs under the `cloudflare-pool` vitest project (Workerd/miniflare) via
 * `pnpm test:adapter-cloudflare` — the stub is the terminal `fetch`, so
 * no MinIO, no docker, no network. It lives under `tests/` (not the CF
 * package `src`) because it imports the node-free `/s3` barrel and the
 * package-layer linter forbids `adapter-cloudflare → adapter-node`.
 */
import { BaerlyError, type BaerlyAppConfig } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { S3HttpStorage, sigV4Signer } from "../../packages/adapter-node/src/s3.ts";
import { baerlyWorker, type BaerlyEnv } from "../../packages/adapter-cloudflare/src/worker.ts";
import { assertAllRequestsSigned, makeS3Stub } from "../fixtures/s3-memory-stub.ts";

const ENDPOINT = "https://s3.us-east-1.amazonaws.com";
const BUCKET = "e2e-test";

const config: BaerlyAppConfig = {
  app: "s3-e2e",
  tenant: "s3-e2e-tenant",
  target: "cloudflare",
  // `auth: "none"` pins every request to `config.tenant` — no header
  // wrangling needed to exercise the storage path.
  auth: "none",
  collections: {},
};

const makeExec = (): ExecutionContext => ({
  waitUntil(): void {},
  passThroughOnException(): void {},
  props: {},
});

const asCfRequest = (req: Request): Request<unknown, IncomingRequestCfProperties> =>
  req as Request<unknown, IncomingRequestCfProperties>;

describe("baerlyWorker routes HTTP through injected S3HttpStorage", () => {
  test("insert then read round-trips through the injected S3 storage, no R2 binding", async () => {
    const { fetchImpl, seen } = makeS3Stub(BUCKET);
    const storage = new S3HttpStorage({
      endpoint: ENDPOINT,
      bucket: BUCKET,
      fetch: fetchImpl,
      sign: sigV4Signer({
        accessKeyId: "AKIAE2ETEST",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        region: "us-east-1",
      }),
      retries: 0,
    });

    const handler = baerlyWorker(() => ({ config, storage }));
    // Deliberately NO `BUCKET` — an S3-only Worker declares no R2 binding.
    // `BaerlyEnv.BUCKET` is optional; if the injected storage weren't
    // wired through, `resolveWorkerStorage` would throw `InvalidConfig`.
    const env: BaerlyEnv = { APP: "s3-e2e-app" };

    const postRes = await handler.fetch!(
      asCfRequest(
        new Request("https://x/v1/c/notes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ doc: { title: "hello from s3" } }),
        }),
      ),
      env,
      makeExec(),
    );
    expect(postRes.status).toBe(201);
    const { _id } = (await postRes.json()) as { readonly _id: string };
    expect(typeof _id).toBe("string");

    const getRes = await handler.fetch!(
      asCfRequest(new Request(`https://x/v1/c/notes/${_id}`, { method: "GET" })),
      env,
      makeExec(),
    );
    expect(getRes.status).toBe(200);
    const { data } = (await getRes.json()) as { readonly data: { title: string } };
    expect(data.title).toBe("hello from s3");

    // The traffic actually went to the injected S3 endpoint, signed —
    // proof it routed through `storage`, not an R2 binding (there is none).
    // The endpoint + PUT assertions are the composition-specific proof; the
    // generic "everything was signed" check is the shared helper.
    expect(seen.every((r) => r.url.startsWith(`${ENDPOINT}/${BUCKET}/`))).toBe(true);
    expect(seen.some((r) => r.method === "PUT")).toBe(true);
    assertAllRequestsSigned(seen);
  });

  test("fails closed at the baerlyWorker level when neither storage nor BUCKET is present", async () => {
    // The composition counterpart to `resolveWorkerStorage`'s unit test:
    // a Worker built with no injected `storage` AND no `env.BUCKET` must
    // reject the request rather than serve it, and the resolution error is
    // cached so every subsequent request re-throws the *same* instance
    // (worker.ts `resolutionError`) rather than re-running resolution.
    const handler = baerlyWorker(() => ({ config }));
    const env: BaerlyEnv = { APP: "s3-e2e-app" }; // no BUCKET, no injected storage

    const req = (): Request<unknown, IncomingRequestCfProperties> =>
      asCfRequest(new Request("https://x/v1/c/notes/anything", { method: "GET" }));

    const attempt = async (): Promise<unknown> => {
      try {
        await handler.fetch!(req(), env, makeExec());
        return undefined;
      } catch (error) {
        return error;
      }
    };

    const first = await attempt();
    expect(first).toBeInstanceOf(BaerlyError);
    expect((first as BaerlyError).code).toBe("InvalidConfig");

    const second = await attempt();
    // Same instance → served from the `resolutionError` cache, proving the
    // fail-closed state is sticky and not silently re-resolved per request.
    expect(second).toBe(first);
  });
});
