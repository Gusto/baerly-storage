import { type BaerlyAppConfig, type Storage } from "@baerly/protocol";
import { Db } from "@baerly/server";
import { describe, expect, test, vi } from "vitest";
import { mockExecutionContext } from "../../../tests/fixtures/mock-execution-context.ts";
import { r2BindingStorage } from "./r2-binding-storage.ts";
import { baerlyWorker, type BaerlyEnv } from "./worker.ts";
import { getBinding } from "../../../tests/fixtures/r2-bucket.ts";

const config: BaerlyAppConfig = {
  app: "strong",
  tenant: "test",
  target: "cloudflare",
  auth: "none",
  collections: {},
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const setup = async () => {
  const bucket = getBinding();
  const storage = r2BindingStorage(bucket);
  const tenant = crypto.randomUUID();
  const db = Db.create({ storage, app: config.app, tenant, config });
  await db.collection("c").insert({ _id: "row", value: "old", removed: true });
  const worker = baerlyWorker(() => ({
    config,
    storage,
    observability: false,
    verifier: async (req) => {
      const token = req.headers.get("authorization");
      if (token === "Bearer valid") {
        return { tenantPrefix: tenant, identity: {} };
      }
      if (token === "Bearer other") {
        return { tenantPrefix: `${tenant}-other`, identity: {} };
      }
      return null;
    },
  }));
  const env: BaerlyEnv = { APP: config.app, BAERLY_MAINTENANCE_DISABLE: "true" };
  const pending: Promise<unknown>[] = [];
  const send = (method = "GET", suffix = "", body?: unknown) =>
    worker.fetch!(
      new Request(`https://strong.test/v1/c/c/row${suffix}`, {
        method,
        headers: { authorization: "Bearer valid", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      mockExecutionContext((promise) => pending.push(promise)),
    ) as Promise<Response>;
  const drain = async () => {
    while (pending.length) {
      await Promise.all(pending.splice(0));
    }
  };
  return { db, storage, worker, env, send, drain, tenant };
};
const expectRow = async (response: Response, value: string) => {
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    data: { _id: "row", value },
    _meta: { fresh: true, manifest_pointer: expect.any(String) },
  });
};

describe("Worker storage-backed point reads", () => {
  test("GET → PUT replacement → GET sees the replacement before and after waitUntil drains", async () => {
    const { send, drain, db } = await setup();
    await expectRow(await send(), "old");
    await expect(send("PUT", "", { doc: { value: "new" } })).resolves.toMatchObject({
      status: 200,
    });
    await expect(db.collection("c").get("row")).resolves.toMatchObject({ value: "new" });
    await expectRow(await send(), "new");
    await drain();
    const response = await send();
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({ _id: "row", value: "new" });
  });

  test("query-string variants see a PATCH to the canonical URL", async () => {
    const { send, drain } = await setup();
    await expectRow(await send("GET", "?view=one&__t=spoof"), "old");
    await expect(send("PATCH", "", { patch: { value: "new" } })).resolves.toMatchObject({
      status: 200,
    });
    await drain();
    await expectRow(await send("GET", "?view=one&__t=spoof"), "new");
    await expectRow(await send("GET", "?view=two"), "new");
  });

  test("an overlapping read cannot persist an old response after write invalidation", async () => {
    const { send, drain, storage } = await setup();
    const reached = deferred();
    const release = deferred();
    const get = storage.get.bind(storage);
    let armed = true;
    vi.spyOn(storage, "get").mockImplementation(async (...args: Parameters<Storage["get"]>) => {
      const result = await get(...args);
      // Freeze the reader's last empty-slot probe, after capturing the old
      // committed prefix. The concurrent writer runs without this barrier.
      if (armed && args[0].includes("/log/") && result === null) {
        armed = false;
        reached.resolve();
        await release.promise;
      }
      return result;
    });
    const reading = send();
    await reached.promise;
    try {
      await expect(send("PATCH", "", { patch: { value: "new" } })).resolves.toMatchObject({
        status: 200,
      });
      await drain();
    } finally {
      release.resolve();
    }
    await expectRow(await reading, "old");
    await drain();
    await expectRow(await send(), "new");
  });

  test("repeated URLs still authenticate and isolate tenants", async () => {
    const { send, worker, env, storage, tenant } = await setup();
    await expectRow(await send(), "old");
    const other = Db.create({ storage, app: config.app, tenant: `${tenant}-other`, config });
    await other.collection("c").insert({ _id: "row", value: "other" });
    const get = vi.spyOn(storage, "get");
    const denied = await worker.fetch!(
      new Request("https://strong.test/v1/c/c/row") as Request<
        unknown,
        IncomingRequestCfProperties
      >,
      env,
      mockExecutionContext(),
    );
    expect(denied.status).toBe(401);
    await expect(denied.json()).resolves.toMatchObject({ error: { code: "Unauthorized" } });
    expect(get).not.toHaveBeenCalled();
    const response = await worker.fetch!(
      new Request("https://strong.test/v1/c/c/row?__t=spoof", {
        headers: { authorization: "Bearer other" },
      }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      mockExecutionContext(),
    );
    await expectRow(response as unknown as Response, "other");
    await expectRow(await send(), "old");
  });

  test("a direct SDK writer is visible on the next Worker read", async () => {
    const { send, drain, db } = await setup();
    await expectRow(await send(), "old");
    await db.collection("c").update("row", { value: "new" });
    await drain();
    await expectRow(await send(), "new");
  });
});
