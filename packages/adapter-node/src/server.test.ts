/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes; the maintenance test seeds doc bodies with it. */

/**
 * Node adapter — `runMaintenanceTick` smoke test. The cross-adapter
 * compactor + GC behaviour itself is covered by the `@baerly/server`
 * package's tests; this one just confirms the Node-side single-shot
 * helper plumbs through compact + GC against the supplied storage.
 */

import { CURRENT_JSON_SCHEMA_VERSION, createCurrentJson, MemoryStorage } from "@baerly/protocol";
import { ServerWriter } from "@baerly/server";
import { describe, expect, it } from "vitest";
import { runMaintenanceTick } from "./server";

describe("runMaintenanceTick", () => {
  it("runs both compact and gc against the supplied storage", async () => {
    const s = new MemoryStorage();
    const key = "app/t/tenant/x/manifests/c/current.json";
    await createCurrentJson(s, key, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      next_seq: 0,
      writer_fence: { epoch: 0, owner: "node-maintenance-test", claimed_at: "" },
    });
    const writer = new ServerWriter({ storage: s, currentJsonKey: key });
    for (let i = 0; i < 200; i++) {
      await writer.commit({
        op: "I",
        collection: "c",
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }

    await runMaintenanceTick({ storage: s, currentJsonKey: key });

    // Compact landed → current.json carries a snapshot pointer and
    // `log_seq_start` advanced past 0.
    const cur = await s.get(key);
    expect(cur).not.toBeNull();
    const json = JSON.parse(new TextDecoder().decode(cur!.body)) as {
      snapshot: string | null;
      log_seq_start?: number;
    };
    expect(json.snapshot).not.toBeNull();
    expect(json.log_seq_start ?? 0).toBeGreaterThan(0);

    // GC bootstrapped its pending ledger (the file exists; the
    // candidates were marked, not swept — 7-day grace gates the
    // sweep, and this test doesn't override `now`).
    const pending = await s.get("app/t/tenant/x/manifests/c/gc/pending.json");
    expect(pending).not.toBeNull();
  });
});
