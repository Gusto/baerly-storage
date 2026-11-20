/**
 * A write carrying an integer outside the safe range is counted and
 * warned about, naming the field path; nothing is refused.
 */

import { BaerlyError, MAX_DOCUMENT_BYTES, MemoryStorage, type Storage } from "@baerly/protocol";
import { describe, expect, test, vi } from "vitest";
import { Db } from "./db.ts";
import { createObservabilityContext } from "./observability/context.ts";
import { runWithContext } from "./observability/index.ts";

const UNSAFE = 2 ** 53 + 2;

type Warning = { event: string; properties: Readonly<Record<string, unknown>> };

const setup = (storage: Storage = new MemoryStorage()) => {
  const warnings: Warning[] = [];
  const obs = createObservabilityContext({
    maintenance: {
      disabled: true,
      warn: (event, properties) => void warnings.push({ event, properties }),
    },
  });
  const coll = Db.create({ storage, app: "a", tenant: "t" }).collection("things");
  const count = (): number =>
    obs.recorder
      .snapshot()
      .counters.filter((c) => c.name === "db.write.unsafe_integer_total")
      .reduce((acc, c) => acc + c.value, 0);
  return { warnings, obs, coll, count };
};

describe("unsafe integers on write", () => {
  test("insert warns at the nested path and still stores the value", async () => {
    const { warnings, obs, coll, count } = setup();
    const { _id } = await runWithContext(obs, () =>
      coll.insert({ a: { ids: [1, UNSAFE] }, b: UNSAFE }),
    );
    expect(count()).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.event).toBe("unsafe_integer");
    expect(warnings[0]!.properties).toMatchObject({
      collection: "things",
      verb: "insert",
      path: "a.ids[1]",
    });
    expect(String(warnings[0]!.properties["detail"])).toContain("as strings");
    await expect(coll.get(_id)).resolves.toMatchObject({ b: UNSAFE });
  });

  test("update patch and replace warn", async () => {
    const { warnings, obs, coll, count } = setup();
    const { _id } = await coll.insert({ n: 1 });
    await runWithContext(obs, () => coll.update(_id, { big: { v: -UNSAFE } }));
    await runWithContext(obs, () => coll.replace(_id, { big: UNSAFE }));
    expect(count()).toBe(2);
    expect(warnings.map((w) => [w.properties["verb"], w.properties["path"]])).toEqual([
      ["update", "big.v"],
      ["replace", "big"],
    ]);
  });

  test("an update that leaves an already-stored unsafe integer alone does not warn", async () => {
    const { warnings, obs, coll, count } = setup();
    const { _id } = await runWithContext(obs, () => coll.insert({ big: UNSAFE }));
    warnings.length = 0;
    await runWithContext(obs, () => coll.update(_id, { n: 1 }));
    expect(count()).toBe(1);
    expect(warnings).toHaveLength(0);
  });

  test("safe integers, the safe-range edge and floats do not warn", async () => {
    const { warnings, obs, coll, count } = setup();
    await runWithContext(obs, () =>
      coll.insert({
        a: Number.MAX_SAFE_INTEGER,
        b: Number.MIN_SAFE_INTEGER,
        c: 1.5,
        d: 2 ** 52 + 0.5,
      }),
    );
    expect(count()).toBe(0);
    expect(warnings).toHaveLength(0);
  });

  test("a refused write is not counted or warned about", async () => {
    const { warnings, obs, coll, count } = setup();
    const { _id } = await coll.insert({ n: 1 });
    const oversized = "x".repeat(MAX_DOCUMENT_BYTES);
    await expect(
      runWithContext(obs, () => coll.insert({ big: UNSAFE, pad: oversized })),
    ).rejects.toMatchObject({ code: "InvalidConfig" });
    await expect(
      runWithContext(obs, () => coll.insert({ _id, big: UNSAFE })),
    ).rejects.toMatchObject({ code: "AlreadyExists" });
    await expect(
      runWithContext(obs, () => coll.replace(_id, { big: UNSAFE, pad: oversized })),
    ).rejects.toMatchObject({ code: "InvalidConfig" });
    await expect(
      runWithContext(obs, () => coll.replace("missing", { big: UNSAFE })),
    ).rejects.toMatchObject({ code: "NotFound" });
    expect(count()).toBe(0);
    expect(warnings).toHaveLength(0);
  });

  test("a committed write warns exactly once", async () => {
    const { warnings, obs, coll, count } = setup();
    await runWithContext(obs, () => coll.insert({ big: UNSAFE }));
    expect(count()).toBe(1);
    expect(warnings).toHaveLength(1);
  });

  test.each([false, true])(
    "a multi-row update warns once even if a later row fails (%s)",
    async (failSecond) => {
      const storage = new MemoryStorage();
      const { warnings, obs, coll, count } = setup(storage);
      await coll.insert({ _id: "a", n: 1 });
      await coll.insert({ _id: "b", n: 1 });
      const put = storage.put.bind(storage);
      const spy = vi.spyOn(storage, "put").mockImplementation(async (key, body, opts) => {
        if (failSecond && key.endsWith("/log/3.json")) {
          throw new BaerlyError("CapacityExceeded", "injected storage refusal");
        }
        return put(key, body, opts);
      });
      try {
        const update = runWithContext(obs, () => coll.where({ n: 1 }).update({ big: UNSAFE }));
        if (failSecond) {
          await expect(update).rejects.toMatchObject({ code: "AmbiguousCommit" });
        } else {
          await expect(update).resolves.toEqual({ modified: 2 });
        }
        await expect(coll.get("a")).resolves.toMatchObject({ big: UNSAFE });
        if (failSecond) {
          await expect(coll.get("b")).resolves.toEqual({ _id: "b", n: 1 });
        }
        expect(count()).toBe(1);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!.properties).toMatchObject({ verb: "update", path: "big" });
      } finally {
        spy.mockRestore();
      }
    },
  );

  test("an update matching no row does not warn", async () => {
    const { warnings, obs, coll, count } = setup();
    await runWithContext(obs, () => coll.update("missing", { big: UNSAFE }));
    expect(count()).toBe(0);
    expect(warnings).toHaveLength(0);
  });

  test("with no sink the warning goes to console.warn", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const coll = Db.create({ storage: new MemoryStorage(), app: "a", tenant: "t" }).collection(
        "things",
      );
      await coll.insert({ x: UNSAFE });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]![0])).toContain("x");
    } finally {
      spy.mockRestore();
    }
  });
});
