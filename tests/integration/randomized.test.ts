import { AwsClient } from "aws4fetch";
import { expect, test, describe, beforeAll, beforeEach, afterEach } from "vitest";
import { MPS3, type MPS3Config } from "../../src/mps3";
import { CentralisedOfflineFirstCausalSystem } from "../fixtures/consistency";
import { DOMParser } from "@xmldom/xmldom";
import { type DeleteValue, type JSONValue, uuid } from "@baerly/protocol";
import { createBucket, makeFixtureClient, putBucketVersioningEnabled } from "../fixtures/s3-fixtures";
import "fake-indexeddb/auto";

describe("mps3", () => {
  let s3: AwsClient;
  let session = uuid().substring(32);
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

  const minioEnabled = process.env.MINIO === "1";

  const setOnline = async (state: boolean) => {
    if (!minioEnabled) return;
    fetch("localhost:8474/proxies/minio", {
      method: "POST",
      body: JSON.stringify({
        enabled: state,
      }),
    });
  };

  const allConfigs: {
    createBucket?: boolean;
    label: string;
    requiresMinio?: boolean;
    config: MPS3Config;
  }[] = [
    {
      label: "useVersioning",
      requiresMinio: true,
      config: {
        useVersioning: true,
        defaultBucket: `ver${session}`,
        s3Config: unstableConfig,
        parser: new DOMParser(),
      },
    },
    {
      label: "minio",
      requiresMinio: true,
      config: {
        minimizeListObjectsCalls: false,
        defaultBucket: `nov${session}`,
        s3Config: unstableConfig,
        parser: new DOMParser(),
      },
    },
    {
      label: "memory",
      createBucket: false,
      config: {
        minimizeListObjectsCalls: false,
        parser: new DOMParser(),
        defaultBucket: `mem${session}`,
        offlineStorage: false,
        adaptiveClock: false,
        s3Config: {
          endpoint: MPS3.MEMORY_ENDPOINT,
        },
      },
    },
  ];

  const configs = allConfigs.filter((v) => !v.requiresMinio || minioEnabled);

  configs.map((variant) =>
    describe(variant.label, () => {
      let networkTwiddler: NodeJS.Timeout;
      beforeAll(async () => {
        s3 = makeFixtureClient(stableConfig)!;

        if (variant.createBucket !== false) {
          await createBucket(s3, stableConfig.endpoint, variant.config.defaultBucket);

          if (variant.config.useVersioning) {
            await putBucketVersioningEnabled(
              s3,
              stableConfig.endpoint,
              variant.config.defaultBucket,
            );
          }
        }
      });

      beforeEach(async () => {
        await setOnline(true);
        networkTwiddler = setInterval(() => {
          setOnline(Math.random() > 0.5);
        }, 100);
      });

      afterEach(async () => {
        clearInterval(networkTwiddler);
        await setOnline(true);
      });

      const getClient = (args?: { label?: string }) =>
        new MPS3({
          label: args?.label,
          ...variant.config,
          clockOffset: Math.random() * 2000 - 1000,
        });
      test(
        "causal consistency all-to-all, single key",
        { timeout: 60 * 1000 },
        () =>
          new Promise<void>((done, reject) => {
            void (async () => {
              let testFailed = false;
              let finished = false;
              const key = `causal-${uuid()}`;
              await getClient().delete(key);

              const system = new CentralisedOfflineFirstCausalSystem();
              const max_steps = 100;

              type Message = {
                sender: number;
                send_time: number;
              };

              const clients = [...Array(3)].map((_, client_id) =>
                getClient({ label: system.client_labels[client_id] }),
              );

              // Drives the cascade: observe a value, check invariants, write
              // a fresh message. Reads come from the per-client polling
              // loop below.
              const handle = (client_id: number, val: JSONValue | DeleteValue) => {
                const label = system.client_labels[client_id];
                if (val) {
                  const message = val as Message;
                  console.log(
                    `${system.global_time}: ${label}@${system.client_clocks[
                      client_id
                    ]!} rcvd ${system.client_labels[message.sender]}@${message.send_time}`,
                  );
                  system.observe({
                    ...message,
                    receiver: client_id,
                  });
                }

                if (system.global_time < max_steps && !testFailed) {
                  testFailed = !system.causallyConsistent();
                  if (testFailed) {
                    console.error(system.grounding);
                    console.error(system.knowledge_base);
                  }
                  expect(testFailed).toBe(false);

                  system.observe({
                    receiver: client_id,
                    sender: client_id,
                    send_time: system.client_clocks[client_id]! - 1,
                  });
                  testFailed = !system.causallyConsistent();
                  expect(testFailed).toBe(false);

                  console.log(
                    `${system.global_time}: ${label}@${
                      system.client_clocks[client_id]! - 1
                    } broadcast`,
                  );
                  void clients[client_id]!.put(key, {
                    sender: client_id,
                    send_time: system.client_clocks[client_id]! - 1,
                  });
                } else if (system.global_time >= max_steps && !finished) {
                  finished = true;
                  done();
                }
              };

              // Kick the cascade: each client observes the seed (undefined,
              // since we deleted above) once before the polling loop
              // catches up to remote writes.
              clients.forEach((_, client_id) => handle(client_id, undefined));

              const POLL_TICK_MS = variant.label === "memory" ? 5 : 50;
              clients.forEach((client, client_id) => {
                void (async () => {
                  let prev: string | undefined = undefined;
                  while (!finished) {
                    await new Promise((r) => setTimeout(r, POLL_TICK_MS));
                    if (finished) return;
                    try {
                      const val = await client.get(key);
                      const serialized = JSON.stringify(val);
                      if (serialized !== prev) {
                        prev = serialized;
                        try {
                          handle(client_id, val);
                        } catch (err) {
                          finished = true;
                          reject(err);
                          return;
                        }
                      }
                    } catch (err) {
                      // Swallow transient read failures (Toxiproxy is
                      // flipping the network on/off every 100ms during
                      // beforeEach). The next tick retries.
                      void err;
                    }
                  }
                })();
              });
            })();
          }),
      );
    }),
  );
});
