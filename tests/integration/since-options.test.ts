import { describe, test, expect } from "vitest";
import { MemoryStorage } from "@baerly/protocol";
import { Db } from "@baerly/server";
import { createRouter } from "@baerly/server/http";
import { withHttpObservability } from "@baerly/server/observability";

describe("createRouter sinceTimeoutMs override", () => {
  test("idle long-poll returns within the configured budget", async () => {
    const SINCE_TIMEOUT_MS = 100;
    const storage = new MemoryStorage();
    const db = Db.create({ storage, app: "test", tenant: "test" });
    const app = createRouter({ db, sinceTimeoutMs: SINCE_TIMEOUT_MS, sincePollIntervalMs: 25 });

    const t0 = performance.now();
    const req = new Request("http://x/v1/since?collection=t&cursor=");
    const res = await withHttpObservability(req, (r) => app.fetch(r));
    const elapsedMs = performance.now() - t0;

    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[]; next_cursor: string };
    expect(body.events).toEqual([]);
    // Bound relative to the configured timeout, not a bare wall-clock
    // literal: the handler should return shortly after the budget
    // elapses. The 10x multiplier absorbs scheduler jitter on a loaded
    // CI core while still catching a hung or ignored timeout.
    expect(elapsedMs).toBeLessThan(SINCE_TIMEOUT_MS * 10);
  });
});
