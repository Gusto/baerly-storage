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
 * Point reads are storage-backed on every invocation.
 */

import { describe } from "vitest";
import { SELF } from "cloudflare:test";
import { CURRENT_JSON_SCHEMA_VERSION, createCurrentJson } from "@baerly/protocol";
import { runHttpConformanceCascade } from "../../../tests/fixtures/http-conformance-cascade.ts";
import { CONFORMANCE_TENANT } from "../../../tests/fixtures/test-verifier.ts";
import { r2BindingStorage } from "./r2-binding-storage.ts";
import { getBinding } from "../../../tests/fixtures/r2-bucket.ts";

const APP = "http-conf";

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
        // Match the Node-side seed: exercise the composite
        // `<generation>.<lsn>` cursor shape, not just the bare LSN.
        generation: "0123456789ab",
      });
    },
    options: {
      // SELF.fetch on Workerd surfaces an AbortError as an unhandled
      // rejection in addition to the rejected promise the test catches;
      // vitest flags that as a fatal error even though the assertion
      // inside the test succeeds. Skip the AbortSignal block here —
      // the Node-side variants already cover the invariant.
      supportsAbort: false,
      supportsSinceTimeoutOverride: true,
      streamsRequestBody: true,
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
