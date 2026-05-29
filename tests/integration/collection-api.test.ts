/**
 * Collection-API integration cascade — Node-side variant runner.
 *
 * Drives the locked `db.collection(...).{first,all,count,insert,update,
 * replace,delete}` + `db.transaction(...)` surface plus a frozen
 * `LogEntry` round-trip across three Node-runnable backends:
 *   - `memory`    — `MemoryStorage` shared per bucket; zero infra.
 *   - `local-fs`  — `LocalFsStorage` over a fresh tmp dir; zero infra.
 *   - `node-minio`— `S3HttpStorage` against Minio direct (no
 *                   Toxiproxy — the randomized cascade already covers
 *                   the partition axis). Gated on `MINIO=1`.
 *
 * The fourth adapter (`cloudflare-r2`) runs under the
 * `cloudflare-pool` vitest project — see
 * `packages/adapter-cloudflare/src/collection-api.test.ts`. Splitting
 * by project keeps `node:fs/promises` + `aws4fetch` out of Workerd.
 *
 * The cascade body itself is backend-agnostic and lives in
 * `tests/fixtures/collection-api-cascade.ts`; only the variant setup
 * (temp dirs, Minio bucket bootstrap) lives here.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AwsClient } from "aws4fetch";
import { afterEach, describe, test } from "vitest";
import { getOrCreateMemoryStorageForBucket, type Storage, uuid } from "@baerly/protocol";
import { S3HttpStorage } from "@baerly/adapter-node";
import { LocalFsStorage } from "@baerly/dev";
import { createBucket } from "../fixtures/s3-fixtures.ts";
import { runCollectionApiCascade } from "../fixtures/collection-api-cascade.ts";
import { MINIO_ENDPOINT } from "../setup/ports.ts";

const stableConfig = {
  endpoint: MINIO_ENDPOINT,
  region: "eu-central-1",
  credentials: { accessKeyId: "baerly", secretAccessKey: "ZOAmumEzdsUUcVlQ" },
};

const minioEnabled = process.env["MINIO"] === "1";

interface Variant {
  readonly label: "memory" | "local-fs" | "node-minio";
  readonly requiresMinio?: boolean;
  /**
   * Build a `(storage, rivalStorage?, cleanup?)` triple. The
   * `rivalStorage` handle, if present, shares a backing store with
   * `storage` so the cross-writer Conflict assertion can run; absent,
   * that assertion is skipped (the cascade's contract documents the
   * tolerance).
   */
  readonly makeStorages: (bucket: string) => Promise<{
    storage: Storage;
    rivalStorage?: Storage;
    cleanup?: () => Promise<void>;
  }>;
}

const allVariants: Variant[] = [
  {
    label: "memory",
    makeStorages: async (bucket) => ({
      storage: getOrCreateMemoryStorageForBucket(bucket),
      rivalStorage: getOrCreateMemoryStorageForBucket(bucket),
    }),
  },
  {
    label: "local-fs",
    makeStorages: async () => {
      const root = await mkdtemp(join(tmpdir(), "baerly-tbl-"));
      return {
        storage: new LocalFsStorage({ root }),
        rivalStorage: new LocalFsStorage({ root }),
        cleanup: async () => {
          await rm(root, { recursive: true, force: true }).catch(() => {
            // Best-effort cleanup; stale tmp dir under a crashed
            // worker doesn't fail the test.
          });
        },
      };
    },
  },
  {
    label: "node-minio",
    requiresMinio: true,
    makeStorages: async (bucket) => {
      const signer = new AwsClient({
        accessKeyId: stableConfig.credentials.accessKeyId,
        secretAccessKey: stableConfig.credentials.secretAccessKey,
        region: "us-east-1",
        service: "s3",
      });
      await createBucket(signer, stableConfig.endpoint, bucket);
      const make = (): S3HttpStorage =>
        new S3HttpStorage({
          endpoint: stableConfig.endpoint,
          bucket,
          sign: (req) => signer.sign(req),
        });
      return { storage: make(), rivalStorage: make() };
    },
  },
];

const variants = allVariants.filter((v) => !v.requiresMinio || minioEnabled);

describe("collection API", () => {
  for (const variant of variants) {
    describe(variant.label, () => {
      let cleanup: (() => Promise<void>) | undefined;

      afterEach(async () => {
        if (cleanup) {
          await cleanup();
        }
        cleanup = undefined;
      });

      test(
        "happy-path + writes + transactions + LogEntry shape",
        { timeout: 60 * 1000 },
        async () => {
          const bucket = `tbl-${variant.label}-${uuid().slice(0, 8)}`;
          const made = await variant.makeStorages(bucket);
          cleanup = made.cleanup;
          await runCollectionApiCascade({
            storage: made.storage,
            ...(made.rivalStorage !== undefined ? { rivalStorage: made.rivalStorage } : {}),
          });
        },
      );
    });
  }
});
