/* eslint-disable no-underscore-dangle -- `__BAERLY_R2_BINDING__` is
   the miniflare-pool ↔ test contract: `tests/setup/r2-binding.ts`
   sets the global; we read it here to provision `current.json` from
   outside the worker handler. */

/**
 * HTTP conformance cascade — Workerd variant.
 *
 * Runs under the `cloudflare-pool` vitest project (workerd + miniflare)
 * via the `SELF` service binding exposed by `cloudflare:test`. The
 * binding invokes the `main` worker configured on the
 * `cloudflareTest({ main: ... })` plugin call in `vitest.config.ts` —
 * which points at `tests/setup/http-conformance-worker.ts`. That
 * module composes `baerlyWorker(() => ({ verifier: testVerifier() }))`
 * against the miniflare R2 binding `BUCKET`, so this file just hands
 * `SELF.fetch` to the shared cascade.
 *
 * `tests/setup/r2-binding.ts` (also wired by the cloudflare-pool
 * project's `setupFiles`) drains the bucket between tests so the
 * cascade's table-per-test isolation holds. The same setup file
 * re-publishes the `BUCKET` binding on `__BAERLY_R2_BINDING__` so the
 * `provisionTable` callback can write `current.json` directly into R2
 * without going through `SELF.fetch` (there is no "create table"
 * HTTP route).
 *
 * `supportsCacheApi: true` opts the conditional-GET block into the
 * Workerd-only assertion that `caches.default` doesn't corrupt the
 * doc shape on a second GET — but the cascade tolerates a 200
 * fall-through there too, because the router doesn't emit
 * `ETag` response headers and the cache layer has no etag to match.
 */

import { describe } from "vitest";
import { SELF } from "cloudflare:test";
import { CURRENT_JSON_SCHEMA_VERSION, createCurrentJson } from "@baerly/protocol";
import { runHttpConformanceCascade } from "../../../tests/fixtures/http-conformance-cascade.ts";
import { CONFORMANCE_TENANT } from "../../../tests/fixtures/test-verifier.ts";
import { r2BindingStorage } from "./r2-binding-storage.ts";

const APP = "http-conf";

const getBinding = (): R2Bucket => {
  const bucket = (globalThis as { __BAERLY_R2_BINDING__?: R2Bucket }).__BAERLY_R2_BINDING__;
  if (bucket === undefined) {
    throw new Error(
      "http-conformance: globalThis.__BAERLY_R2_BINDING__ missing — expected wiring from tests/setup/r2-binding.ts under the cloudflare-pool vitest project",
    );
  }
  return bucket;
};

describe("HTTP conformance", () => {
  runHttpConformanceCascade({
    name: "cloudflare-r2",
    fetch: (req) => SELF.fetch(req) as unknown as Promise<Response>,
    provisionTable: async (table) => {
      const storage = r2BindingStorage(getBinding());
      const key = `app/${APP}/tenant/${CONFORMANCE_TENANT}/manifests/${table}/current.json`;
      await createCurrentJson(storage, key, {
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
      // Workerd serves through `caches.default` for read paths. The
      // cascade's conditional-GET block tolerates 200 OR 304.
      supportsCacheApi: true,
      // SELF.fetch on Workerd surfaces an AbortError as an unhandled
      // rejection in addition to the rejected promise the test catches;
      // vitest flags that as a fatal error even though the assertion
      // inside the test succeeds. Skip the AbortSignal block here —
      // the Node-side variants already cover the invariant.
      supportsAbort: false,
      supportsSinceTimeoutOverride: true,
      // Pre-seed tail_hint and log_seq_start so the overflow regression
      // test only needs ONE insert instead of 1025 sequential fetches.
      provisionTableAtSeq: async (table, nextSeq) => {
        // Synthetic current.json: snapshot is null, log_seq_start=nextSeq,
        // so readers walk [nextSeq, tail_hint) and treat 0..nextSeq-1 as
        // already truncated/folded away — not snapshotted. This state is
        // deliberately outside what the writer emits (log_seq_start > 0
        // normally implies snapshot !== null), used only to fast-forward
        // the seq counter for the overflow regression test.
        const storage = r2BindingStorage(getBinding());
        const key = `app/${APP}/tenant/${CONFORMANCE_TENANT}/manifests/${table}/current.json`;
        await createCurrentJson(storage, key, {
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
