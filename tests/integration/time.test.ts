import { expect, test, describe, beforeAll } from "vitest";
import { MPS3 } from "../../src/mps3";
import { dateToSecs } from "../../src/time";
import { uuid } from "@baerly/protocol";
import { DOMParser } from "@xmldom/xmldom";
import { createBucket, makeFixtureClient } from "../fixtures/s3-fixtures";

describe("timestampToSecs", () => {
  test("Mon, 3 Oct 2016 22:32:00 GMT", () => {
    const result = dateToSecs("Mon, 3 Oct 2016 22:32:00 GMT");
    expect(result).toBe(1475533920);
  });

  test("Mon, 3 Oct 2016 22:32:01 GMT", () => {
    const result = dateToSecs("Mon, 3 Oct 2016 22:32:01 GMT");
    expect(result).toBe(1475533921);
  });
});

const minioEnabled = process.env.MINIO === "1";

describe.runIf(minioEnabled)("clock behavior", () => {
  const getClient = (args: any = {}) =>
    new MPS3({
      parser: new DOMParser(),
      offlineStorage: false,
      defaultBucket: "clock",
      s3Config: {
        endpoint: "http://127.0.0.1:9102",
        region: "eu-central-1",
        credentials: {
          accessKeyId: "mps3",
          secretAccessKey: "ZOAmumEzdsUUcVlQ",
        },
      },
      ...args,
    });

  beforeAll(async () => {
    const endpoint = "http://127.0.0.1:9102";
    const client = makeFixtureClient({
      endpoint,
      region: "eu-central-1",
      credentials: {
        accessKeyId: "mps3",
        secretAccessKey: "ZOAmumEzdsUUcVlQ",
      },
    })!;
    try {
      await createBucket(client, endpoint, "clock");
    } catch {}
  });

  test("Stale writes are dropped", async () => {
    const delayedClient = getClient({
      label: "delayed",
      clockOffset: -10000,
      adaptiveClock: false,
    });
    const reader = getClient({ label: "reader" });
    const key = `delayed/${uuid()}`;
    await delayedClient.put(key, "");
    const result = await reader.get(key);
    expect(result).toBeUndefined();
  });

  test("Stale writes are retried and clock offset is updated with adaptiveClock", async () => {
    const delayedClient = getClient({
      label: "delayed",
      clockOffset: -10000,
      adaptiveClock: true,
    });
    const reader = getClient({ label: "reader" });
    const key = `delayed/${uuid()}`;
    await delayedClient.put(key, "");
    const result = await reader.get(key);
    expect(result).toBe("");
    expect(delayedClient.config.clockOffset).toBeGreaterThan(-10000);
  });
});
