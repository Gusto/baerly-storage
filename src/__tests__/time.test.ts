import { expect, test, describe, beforeAll } from "bun:test";
import { MPS3 } from "mps3";
import { dateToSecs } from "time";
import { uuid } from "types";
import { DOMParser } from "@xmldom/xmldom";
import { S3 } from "@aws-sdk/client-s3";

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

describe("clock behavior", () => {
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
    const s3 = new S3({
      endpoint: "http://127.0.0.1:9102",
      region: "eu-central-1",
      credentials: {
        accessKeyId: "mps3",
        secretAccessKey: "ZOAmumEzdsUUcVlQ",
      },
    });
    try {
      await s3.createBucket({
        Bucket: "clock",
      });
    } catch (e) {}
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
