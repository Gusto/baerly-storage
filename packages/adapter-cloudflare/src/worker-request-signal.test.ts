/**
 * `enable_request_signal` (set in the scaffolds' `wrangler.jsonc`, which the
 * `cloudflare-pool` project reads) makes a client disconnect abort the
 * incoming `Request.signal` on Workers. `GET /v1/since` settles its long-poll
 * on that abort, so an aborted poll must finish well before its timeout.
 *
 * The probe worker (`tests/setup/http-conformance-worker.ts`) polls with a
 * 500 ms `sinceTimeoutMs` and records when each `/v1/since` request settles.
 */

import { describe, expect, test } from "vitest";
import { SELF } from "cloudflare:test";
import { CURRENT_JSON_SCHEMA_VERSION, createCurrentJson } from "@baerly/protocol";
import { CONFORMANCE_BEARER, CONFORMANCE_TENANT } from "../../../tests/fixtures/test-verifier.ts";
import { getBinding } from "../../../tests/fixtures/r2-bucket.ts";
import { r2BindingStorage } from "./r2-binding-storage.ts";

const SINCE_TIMEOUT_MS = 500;
const ABORT_AFTER_MS = 50;

describe("request signal on Workers", () => {
  test("aborting a /v1/since long-poll settles it before its timeout", async () => {
    const table = "request-signal";
    await createCurrentJson(
      r2BindingStorage(getBinding()),
      `app/http-conf/tenant/${CONFORMANCE_TENANT}/manifests/${table}/current.json`,
      {
        schema_version: CURRENT_JSON_SCHEMA_VERSION,
        snapshot: null,
        tail_hint: 0,
        log_seq_start: 0,
        writer_fence: { epoch: 0, owner: "request-signal-test", claimed_at: "" },
        snapshot_bytes: 0,
        snapshot_rows: 0,
        generation: "0123456789ab",
      },
    );

    const ac = new AbortController();
    const poll = SELF.fetch(`http://x/v1/since?collection=${table}&cursor=`, {
      headers: { authorization: `Bearer ${CONFORMANCE_BEARER}` },
      signal: ac.signal,
    }).then(
      () => "settled",
      () => "aborted",
    );
    await new Promise((resolve) => setTimeout(resolve, ABORT_AFTER_MS));
    ac.abort();
    await expect(poll).resolves.toBe("aborted");

    // Wait past the poll timeout so a poll that ignores the abort has
    // settled by now, then read when the worker finished it.
    await new Promise((resolve) => setTimeout(resolve, SINCE_TIMEOUT_MS + 200));
    const probeResponse = await SELF.fetch("http://x/__probe/since");
    const probe = (await probeResponse.json()) as {
      startedAt: number;
      settledAt?: number;
    } | null;
    expect(probe?.settledAt, "the since poll never settled").toBeDefined();
    expect(probe!.settledAt! - probe!.startedAt).toBeLessThan(SINCE_TIMEOUT_MS - 100);
  });
});
