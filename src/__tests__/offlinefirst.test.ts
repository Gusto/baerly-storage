import { S3 } from "@aws-sdk/client-s3";
import {
  expect,
  test,
  describe,
  beforeAll,
  beforeEach,
  afterEach,
} from "bun:test";
import { MPS3, MPS3Config } from "mps3";
import { DOMParser } from "@xmldom/xmldom";
import { uuid } from "types";
import "fake-indexeddb/auto";

describe("offlinefirst", () => {
    let s3: S3;
    let session = uuid().substring(31);
    const stableConfig = {
        endpoint: "http://127.0.0.1:9102",
        region: "eu-central-1",
        credentials: {
            accessKeyId: "mps3",
            secretAccessKey: "ZOAmumEzdsUUcVlQ",
        },
    };

    const unstableConfig = {
        endpoint: "http://127.0.0.1:9104",
        region: "eu-central-1",
        credentials: {
            accessKeyId: "mps3",
            secretAccessKey: "ZOAmumEzdsUUcVlQ",
        },
    };

    const configs: {
        label: string;
        config: MPS3Config;
    }[] = [
        {
            label: "useVersioning",
            config: {
                pollFrequency: 100,
                useVersioning: true,
                defaultBucket: `ver${session}`,
                s3Config: unstableConfig,
                parser: new DOMParser(),
            },
        },
        {
            label: "noVersioning",
            config: {
                pollFrequency: 100,
                defaultBucket: `nov${session}`,
                s3Config: unstableConfig,
                parser: new DOMParser(),
            },
        },
    ];

    const setOnline = async (state: boolean) => {
        fetch("localhost:8474/proxies/minio", {
            method: "POST",
            body: JSON.stringify({
                enabled: state,
            }),
        });
    };

    configs.map((variant) =>
        describe(variant.label, () => {
            beforeAll(async () => {
                s3 = new S3(stableConfig);

                await s3.createBucket({
                    Bucket: variant.config.defaultBucket,
                });

                if (variant.config.useVersioning) {
                    await s3.putBucketVersioning({
                        Bucket: variant.config.defaultBucket,
                        VersioningConfiguration: {
                            Status: "Enabled",
                        },
                    });
                }
            });

            beforeEach(async () => {
                await setOnline(true);
            });

            afterEach(async () => {
                await setOnline(true);
            });

            const getClient = (args?: { label?: string; online?: boolean }) =>
                new MPS3({
                    label: args?.label,
                    online: args?.online ?? true,
                    ...variant.config,
                });

            test("Online client commits messages", async () => {
                const writer = getClient({
                    online: true,
                });
                await writer.put("online", true);

                const reader = getClient({
                    online: true,
                });
                expect(await reader.get("online")).toBe(true);
            });

            test("Offline client does not commit messages", async () => {
                const writer = getClient({
                    online: false,
                });
                await writer.put("offline", true);

                const reader = getClient({
                    label: "other",
                    online: true,
                });
                expect(await reader.get("offline")).toBe(undefined);
            });

            test("Restored online client has populated cache", async () => {
                const ID = "restore-1";
                const writer = getClient({
                    label: ID,
                    online: false,
                });
                await writer.put(ID, "foo");

                console.log("Restore");
                const restored = getClient({
                    label: ID,
                    online: false,
                });

                expect(await restored.get(ID)).toBe("foo");
            });

            test("Restored online respects ordering", async () => {
                const ID = "restore-2";
                const writer = getClient({
                    label: ID,
                    online: false,
                });
                await writer.put(ID, "1");

                console.log("Restore");
                const restored = getClient({
                    label: ID,
                    online: false,
                });

                writer.put(ID, "2");
                expect(await restored.get(ID)).toBe("2");
            });

            test("Restored client remembers committed keys", async () => {
                const ID = "restore-3";
                const writer = getClient({
                    label: ID,
                });
                writer.subscribe(ID, () => {});
                await writer.put(ID, "1");
                await new Promise((resolve) => setTimeout(resolve, 100));
                await writer.refresh();

                console.log("Restore");
                const restored = getClient({
                    label: ID,
                    online: false,
                });

                expect(await restored.get(ID)).toBe("1");
            });

            test("Read your write", async () => {
                const client = await getClient({
                    label: "rw-1",
                    online: false,
                });

                client.put("key", "value");
                expect(await client.get("key")).toBe("value");
            });

            test("Subscribe to non-cached key is undefined", async (done) => {
                await getClient({
                    label: "hang-1",
                    online: false,
                }).subscribe("hang-1", (val) => {
                    expect(val).toBeUndefined();
                    done();
                });
            });

            test("Restored client remembers subscribed keys", async () => {
                const ID = "restore-4";
                await getClient({
                    label: `setup-4`,
                }).put(ID, "1");

                const read = await new Promise(async (resolve) => {
                    await getClient({
                        label: ID,
                    }).subscribe(ID, (val) => {
                        resolve(val);
                    });
                });

                // confirm we have subscribed to the value
                // so it should be cached
                expect(read).toBe("1");

                await new Promise((resolve) => setTimeout(resolve, 100));

                // now subscribe with an offline client
                const offlineRead = await new Promise((resolve, reject) => {
                    getClient({
                        label: ID,
                        online: false,
                    }).subscribe(ID, (val, err) => {
                        if (err) reject(err);
                        resolve(val);
                    });
                });

                expect(offlineRead).toBe("1");
            });
        })
    );
});
