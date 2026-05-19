import { describe, test, expect } from "vitest";
import { MemoryStorage } from "@baerly/protocol";
import { Db, createRouter, withHttpObservability } from "@baerly/server";

describe("createRouter sinceTimeoutMs override", () => {
  test("idle long-poll returns within the configured budget", async () => {
    const storage = new MemoryStorage();
    const db = Db.create({ storage, app: "test", tenant: "test" });
    const app = createRouter({ db, sinceTimeoutMs: 100, sincePollIntervalMs: 25 });

    const t0 = performance.now();
    const req = new Request("http://x/v1/since?table=t&cursor=");
    const res = await withHttpObservability(req, (r) => app.fetch(r));
    const elapsedMs = performance.now() - t0;

    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[]; next_cursor: string };
    expect(body.events).toEqual([]);
    expect(elapsedMs).toBeLessThan(500);
  });
});
