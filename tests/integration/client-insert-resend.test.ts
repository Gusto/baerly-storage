import { createBaerlyClient } from "@baerly/client";
import { MemoryStorage } from "@baerly/protocol";
import { Db } from "@baerly/server";
import { createRouter } from "@baerly/server/http";
import { expect, test } from "vitest";

test("a resent auto-ID insert replays as the original success and leaves one row", async () => {
  const db = Db.create({ storage: new MemoryStorage(), app: "client-resend", tenant: "test" });
  const router = createRouter({ db });
  const results: Array<{ status: number; body: unknown }> = [];
  const client = createBaerlyClient({
    baseUrl: "http://localhost",
    // Simulates a lost response: the same request reaches the server
    // twice, and the caller sees only the second answer.
    fetch: async (request) => {
      const resend = request.clone();
      const first = await router.fetch(request);
      results.push({ status: first.status, body: await first.json() });
      const second = await router.fetch(resend);
      results.push({ status: second.status, body: await second.clone().json() });
      return second;
    },
  });

  const { _id } = await client.collection("tickets").insert({ title: "once" });

  expect(results.map((r) => r.status)).toEqual([201, 201]);
  expect(results[0]?.body).toEqual(results[1]?.body);
  expect(results[1]?.body).toEqual({ _id });
  await expect(db.collection("tickets").where({}).all()).resolves.toHaveLength(1);
});
