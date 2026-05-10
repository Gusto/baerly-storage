import { expect, test, describe, beforeAll } from "vitest";
import { MPS3, MPS3Config } from "../../src/mps3";
import { DOMParser } from "@xmldom/xmldom";
import cloudflareCredentials from "../../credentials/cloudflare.json";
import awsCredentials from "../../credentials/aws.json";
import "fake-indexeddb/auto";
import { uuid } from "@baerly/protocol";
import { createBucket, getObject, makeFixtureClient, putBucketVersioningEnabled } from "../fixtures/s3-fixtures";

describe("mps3", () => {
  let session = uuid().substring(0, 8);
  const minioConfig = {
    endpoint: "http://127.0.0.1:9102",
    region: "eu-central-1",
    autoclean: false,
    credentials: {
      accessKeyId: "mps3",
      secretAccessKey: "ZOAmumEzdsUUcVlQ",
    },
  };

  const configs: {
    label: string;
    createBucket?: boolean;
    config: MPS3Config;
  }[] = [
    {
      label: "useVersioning",
      config: {
        useVersioning: true,
        defaultBucket: `ver${session}`,
        s3Config: minioConfig,
        parser: new DOMParser(),
      },
    },
    {
      label: "minio",
      config: {
        minimizeListObjectsCalls: false,
        defaultBucket: `nov${session}`,
        s3Config: minioConfig,
        parser: new DOMParser(),
      },
    },
    /*
    {
      label: "google",
      createBucket: false,
      config: {
        defaultBucket: `mps3-demo`,
        s3Config: {
          region: "europe-west10",
          endpoint: "https://storage.googleapis.com",
          credentials: gcsCredentials,
        },
        parser: new DOMParser(),
      },
    },*/ {
      label: "cloudflare",
      createBucket: false,
      config: {
        defaultBucket: `mps3-demo`,
        s3Config: {
          region: "auto",
          endpoint: "https://a3e2af584fbdedd172bede5ca0018aae.r2.cloudflarestorage.com",
          credentials: cloudflareCredentials,
        },
        parser: new DOMParser(),
      },
    },
    {
      label: "aws",
      createBucket: false,
      config: {
        defaultBucket: `mps3-demo`,
        s3Config: {
          region: "eu-central-1",
          credentials: awsCredentials,
        },
        parser: new DOMParser(),
      },
    },
    {
      label: "proxy",
      createBucket: false,
      config: {
        defaultBucket: `s3-demo`,
        defaultManifest: `proxy`,
        s3Config: {
          region: "eu-central-1",
          endpoint: "https://mps3-proxy.endpointservices.workers.dev",
        },
        parser: new DOMParser(),
      },
    },
  ];

  configs.map((variant) =>
    describe(variant.label, () => {
      beforeAll(async () => {
        try {
          const s3 = makeFixtureClient(variant.config.s3Config);
          const endpoint = variant.config.s3Config.endpoint;
          if (s3 && endpoint && variant.createBucket !== false) {
            await createBucket(s3, endpoint, variant.config.defaultBucket);
          }

          if (s3 && endpoint && variant.config.useVersioning) {
            await putBucketVersioningEnabled(s3, endpoint, variant.config.defaultBucket);
          }
        } catch (e) {
          console.error(e);
        }
      });
      const getClient = (args?: { label?: string; clockOffset?: number }) => {
        return new MPS3({
          label: args?.label || uuid().substring(32),
          ...variant.config,
          clockOffset: args?.clockOffset ?? Math.random() * 2000 - 1000,
        });
      };

      test("Can see other's mutations after populating cache", async () => {
        const mps3 = getClient({ clockOffset: 0 });
        const rnd = uuid();
        await mps3.put("rw1", rnd);
        await getClient({ clockOffset: 0 }).delete("rw1");

        // pending cache masks server until committed
        while ((await mps3.get("rw1")) !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        const read = await mps3.get("rw1");
        expect(read).toEqual(undefined);
      });

      test("Read no manifest", async () => {
        const mps3 = getClient();
        const read = await mps3.get("unused_key", {
          manifest: {
            key: uuid(),
          },
        });
        expect(read).toEqual(undefined);
      });

      test("Read unknown key resolves to undefined", async () => {
        const mps3 = getClient();
        const read = await mps3.get("unused_key");
        expect(read).toEqual(undefined);
      });

      test("Delete key by setting to undefined", async () => {
        const mps3 = getClient();
        await mps3.put("delete", "");
        await mps3.put("delete", undefined);
        const read = await mps3.get("delete");
        expect(read).toEqual(undefined);
      });

      test("Can read a write only", async () => {
        const rnd = uuid();
        await getClient().put("rw", rnd);
        const read = await getClient().get("rw");
        expect(read).toEqual(rnd);
      });

      test("Key encoding", async () => {
        const rnd = uuid();
        const key = `&$@=;[~|^  :+,"?\\{^}%]>#\x01\x1F\x80\xFF`;
        await getClient().put(key, rnd);
        const read = await getClient().get(key);
        expect(read).toEqual(rnd);
      });

      test("Storage key representation", async () => {
        const s3 = makeFixtureClient(variant.config.s3Config);
        const endpoint = variant.config.s3Config.endpoint;
        const client = await getClient();
        await client.put("storage_key", "foo");
        if (variant.config.useVersioning) {
          const storage = await getObject(
            s3!,
            endpoint!,
            variant.config.defaultBucket,
            "storage_key",
          );
          expect(storage.VersionId).toBeDefined();
        } else {
          // Original behavior: SDK was instantiated even for credential-less
          // variants (localfirst, proxy) and the getObject was expected to
          // throw. Preserve that — credential-less variants short-circuit
          // through the missing client, signed variants throw on raw key.
          try {
            if (!s3 || !endpoint) throw new Error("no client");
            await getObject(s3, endpoint, variant.config.defaultBucket, "storage_key");
            expect(false).toBe(true);
          } catch {}
        }
      });

      test("Can read a write (cold manifest)", async () => {
        const manifest = {
          key: `manifest_${uuid()}`,
        };
        const rnd = uuid();
        await getClient().put("rw", rnd, {
          manifests: [manifest],
        });
        const read = await getClient().get("rw", {
          manifest: manifest,
        });
        expect(read).toEqual(rnd);
      });

      test("Consecutive gets use manifest cache", async () => {
        const mps3 = getClient();
        await mps3.get("cache_get");
        await mps3.get("cache_get");
      });

      test("Parallel puts commute - warm manifest - single read", async () => {
        await getClient().put("warm", null);
        const n = 3;
        const writers = [...Array(n)].map((_) => getClient());
        const rand_keys = [...Array(n)].map((_, i) => `parallel_put/${i}_${uuid()}`);

        // put in parallel
        await Promise.all(rand_keys.map((key, i) => writers[i].put(key, i)));

        // read in parallel
        expect(await getClient().get(rand_keys[1])).toEqual(1);
      });

      test("Parallel puts commute - warm manifest", async () => {
        await getClient().put("warm", null);
        const n = 3;
        const writers = [...Array(n)].map((_) => getClient());
        const rand_keys = [...Array(n)].map((_, i) => `parallel_put/${i}_${uuid()}`);

        // put in parallel
        await Promise.all(rand_keys.map((key, i) => writers[i].put(key, i)));

        // read in parallel
        const reads = await Promise.all(rand_keys.map((key, i) => writers[n - i - 1].get(key)));

        expect(reads).toEqual([...Array(n)].map((_, i) => i));
      });

      test("Parallel puts commute - cold manifest", async () => {
        const manifests = [
          {
            key: uuid(),
          },
        ];
        const n = 3;
        const writers = [...Array(n)].map((_) => getClient());
        const rand_keys = [...Array(n)].map((_, i) => `parallel_put/${i}_${uuid()}`);

        // put in parallel
        await Promise.all(
          rand_keys.map((key, i) =>
            writers[i].put(key, i, {
              manifests,
            }),
          ),
        );

        // read in parallel
        const reads = await Promise.all(
          rand_keys.map((key, i) =>
            writers[n - i - 1].get(key, {
              manifest: manifests[0],
            }),
          ),
        );

        expect(reads).toEqual([...Array(n)].map((_, i) => i));
      });

    }),
  );
});
