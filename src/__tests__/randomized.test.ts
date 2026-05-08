import { AwsClient } from "aws4fetch";
import { expect, test, describe, beforeAll, beforeEach, afterEach } from "vitest";
import { MPS3, type MPS3Config } from "../mps3";
import { CentralisedOfflineFirstCausalSystem } from "./consistency";
import { DOMParser } from "@xmldom/xmldom";
import { uuid } from "../types";
import { createBucket, makeFixtureClient, putBucketVersioningEnabled } from "./s3Fixtures";
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

  const setOnline = async (state: boolean) => {
    fetch("localhost:8474/proxies/minio", {
      method: "POST",
      body: JSON.stringify({
        enabled: state,
      }),
    });
  };

  const configs: {
    createBucket?: boolean;
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
      label: "minio",
      config: {
        pollFrequency: 100,
        minimizeListObjectsCalls: false,
        useChecksum: false,
        defaultBucket: `nov${session}`,
        s3Config: unstableConfig,
        parser: new DOMParser(),
      },
    },
    {
      label: "localfirst",
      createBucket: false,
      config: {
        pollFrequency: 10,
        minimizeListObjectsCalls: false,
        parser: new DOMParser(),
        defaultBucket: "l1",
        offlineStorage: false,
        adaptiveClock: false,
        s3Config: {
          endpoint: MPS3.LOCAL_ENDPOINT,
        },
      },
    },
  ];

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
          new Promise<void>((done) => {
            void (async () => {
              let testFailed = false;
              const key = `causal-${uuid()}`;
              await getClient().delete(key);

              const system = new CentralisedOfflineFirstCausalSystem();
              const max_steps = 100;

              type Message = {
                sender: number;
                send_time: number;
              };
              // Setup all clients to forward messages to the observer
              const clients = [...Array(3)].map((_, client_id) => {
                const label = system.client_labels[client_id];
                const client = getClient({ label });
                client.subscribe(key, (val) => {
                  if (val) {
                    const message: Message = <Message>val;
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
                    // Check facts are causally consistent so far
                    testFailed = !system.causallyConsistent();
                    if (testFailed) {
                      console.error(system.grounding);
                      console.error(system.knowledge_base);
                    }
                    expect(testFailed).toBe(false);

                    // Write a new message
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
                    client.put(key, {
                      sender: client_id,
                      send_time: system.client_clocks[client_id]! - 1,
                    });
                  } else if (system.global_time === max_steps) {
                    clients.forEach((c) => c.manifests.forEach((m) => m.subscribers.clear()));
                    done();
                  }
                });
                return client;
              });
            })();
          }),
      );
    }),
  );
});
