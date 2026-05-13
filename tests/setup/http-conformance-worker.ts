/* eslint-disable no-underscore-dangle -- `__BAERLY_R2_BINDING__` is
   the ticket-06 contract: miniflare's vitest pool sets the global; we
   read it here so the worker entry can talk to the same R2 binding
   the conformance setup file drains between tests. */

/**
 * Worker `main` module for the Cloudflare-pool HTTP-conformance run.
 *
 * `cloudflareTest({ main: <this file> })` wires this module's
 * `export default` into miniflare so the `SELF` binding exposed by
 * `cloudflare:test` invokes it on every `SELF.fetch(req)`.
 *
 * The module composes a `baerlyWorker({ verifier })` against the
 * R2 binding `BUCKET` (declared in `vitest.config.ts`'s
 * `miniflare.r2Buckets`) plus the shared `testVerifier()` from
 * `tests/fixtures/test-verifier.ts`. The factory expects an
 * `ExportedHandler<Env>` shape; the `Env` has `BUCKET` +
 * `APP` + `TENANT` (the latter ignored when `verifier` is supplied).
 *
 * One subtlety: `baerlyWorker.fetch` reads `env.BUCKET` per request,
 * so we don't need to capture the binding here — we just re-export
 * the handler. The default app name `"http-conf"` matches what the
 * Node-side variants use, so the test verifier's tenant prefix
 * resolves to the same physical-prefix-tree on both pools.
 */

import type { Verifier } from "@baerly/protocol";
import { baerlyWorker, type Env } from "@baerly/adapter-cloudflare";

import { CONFORMANCE_BEARER, CONFORMANCE_TENANT } from "../fixtures/test-verifier.ts";

// Reproduce `testVerifier()` inline so the worker module has no
// dependency on a fixture file living above the package root.
// (Vite's worker-bundling is happy with relative imports either
// way; replicating the body here keeps the module's import graph
// minimal — a handful of constants over a fixture re-export.)
const verifier: Verifier = async (req: Request) => {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${CONFORMANCE_BEARER}`) return null;
  return { tenantPrefix: CONFORMANCE_TENANT, identity: {} };
};

const handler = baerlyWorker({ verifier });

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    // `baerlyWorker` returns an `ExportedHandler<Env>` whose `fetch`
    // is `(Request, Env, ExecutionContext) => Promise<Response>`.
    return handler.fetch!(
      req as unknown as Parameters<NonNullable<typeof handler.fetch>>[0],
      env,
      ctx,
    );
  },
} satisfies ExportedHandler<Env>;
