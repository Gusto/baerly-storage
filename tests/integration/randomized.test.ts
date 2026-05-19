/**
 * Randomized causal-consistency cascade — Node-side variant runner.
 *
 * Replaces the legacy `Baerly`-class harness. Now drives
 * `ServerWriter.commit()` through three Node-runnable backends:
 *   - `memory`    — `MemoryStorage` shared per bucket; zero infra.
 *   - `local-fs`  — `LocalFsStorage` over a fresh tmp dir; zero infra.
 *   - `node-minio`— `S3HttpStorage` against Toxiproxy → Minio; gated on
 *                   `MINIO=1`.
 *
 * The fourth adapter (`cloudflare-r2`) runs under the `cloudflare-pool`
 * vitest project — see `packages/adapter-cloudflare/src/randomized.test.ts`.
 * Splitting by project keeps `node:fs/promises` + `aws4fetch` out of
 * Workerd and the R2 binding out of plain Node forks.
 *
 * The cascade body itself is backend-agnostic and lives in
 * `tests/fixtures/randomized-cascade.ts`; only variant setup (temp
 * dirs, Toxiproxy fault injection, Minio bucket bootstrap) lives here.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AwsClient } from "aws4fetch";
import { DOMParser } from "@xmldom/xmldom";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
  getOrCreateMemoryStorageForBucket,
  S3HttpStorage,
  type Storage,
  uuid,
} from "@baerly/protocol";
import { LocalFsStorage } from "@baerly/dev";
import { createBucket } from "../fixtures/s3-fixtures.ts";
import {
  runCausalConsistencyCascade,
  runRangeWalkParityCascade,
} from "../fixtures/randomized-cascade.ts";

const stableConfig = {
  endpoint: "http://127.0.0.1:9102",
  region: "eu-central-1",
  credentials: { accessKeyId: "baerly", secretAccessKey: "ZOAmumEzdsUUcVlQ" },
};
const unstableConfig = { ...stableConfig, endpoint: "http://127.0.0.1:9104" };

const minioEnabled = process.env["MINIO"] === "1";

// Toxiproxy toggle — the new core has no `setOnline()` knob; we flip
// the Minio proxy directly through Toxiproxy's HTTP admin API. No-op
// when MINIO is off so memory / local-fs variants don't try to reach
// `:8474`.
const setOnline = async (state: boolean): Promise<void> => {
  if (!minioEnabled) {
    return;
  }
  await fetch("http://localhost:8474/proxies/minio", {
    method: "POST",
    body: JSON.stringify({ enabled: state }),
  }).catch(() => {
    // Toxiproxy unreachable — let the test surface the real Minio
    // error rather than masking it here.
  });
};

interface Variant {
  readonly label: "memory" | "local-fs" | "node-minio";
  readonly requiresMinio?: boolean;
  /** Per-tick poll cadence; tuned per backend. */
  readonly pollTickMs: number;
  /** Build N {@link Storage} handles sharing one backing store. */
  readonly makeStorages: (bucket: string, n: number) => Promise<Storage[]>;
  /** Best-effort cleanup for ephemeral resources. */
  readonly cleanup?: () => Promise<void>;
}

const tmpRoots: string[] = [];

const allVariants: Variant[] = [
  {
    label: "memory",
    pollTickMs: 5,
    // Process-singleton: same bucket → same underlying MemoryStorage.
    // Same mechanism the legacy `memory` variant used.
    makeStorages: async (bucket, n): Promise<Storage[]> =>
      Array.from({ length: n }, () => getOrCreateMemoryStorageForBucket(bucket)),
  },
  {
    label: "local-fs",
    pollTickMs: 10,
    // Atomic `writeFile(temp)+rename` keeps concurrent writes safe;
    // cross-instance visibility is the file system.
    makeStorages: async (_bucket, n): Promise<Storage[]> => {
      const root = await mkdtemp(join(tmpdir(), "baerly-rnd-"));
      tmpRoots.push(root);
      return Array.from({ length: n }, () => new LocalFsStorage({ root }));
    },
    cleanup: async (): Promise<void> => {
      const drained = tmpRoots.splice(0);
      for (const r of drained) {
        await rm(r, { recursive: true, force: true }).catch(() => {
          // Cleanup is best-effort; a stale lock under a crashed
          // worker doesn't fail the test.
        });
      }
    },
  },
  {
    label: "node-minio",
    requiresMinio: true,
    pollTickMs: 50,
    makeStorages: async (bucket, n): Promise<Storage[]> => {
      const signer = new AwsClient({
        accessKeyId: stableConfig.credentials.accessKeyId,
        secretAccessKey: stableConfig.credentials.secretAccessKey,
        region: "us-east-1",
        service: "s3",
      });
      await createBucket(signer, stableConfig.endpoint, bucket);
      const xmlParser = new DOMParser();
      return Array.from(
        { length: n },
        () =>
          new S3HttpStorage({
            endpoint: unstableConfig.endpoint, // Toxiproxy — fault injection
            bucket,
            sign: (req) => signer.sign(req),
            xmlParser,
          }),
      );
    },
  },
];

const variants = allVariants.filter((v) => !v.requiresMinio || minioEnabled);

describe("randomized (Db + ServerWriter)", () => {
  for (const variant of variants) {
    describe(variant.label, () => {
      let networkTwiddler: ReturnType<typeof setInterval> | undefined;

      beforeEach(async () => {
        await setOnline(true);
        // Only Minio has a Toxiproxy seam; the other variants have no
        // injectable network shim, so the twiddler is a no-op for them.
        if (variant.label === "node-minio") {
          networkTwiddler = setInterval(() => {
            void setOnline(Math.random() > 0.5);
          }, 100);
        }
      });

      afterEach(async () => {
        if (networkTwiddler) {
          clearInterval(networkTwiddler);
        }
        await setOnline(true);
        if (variant.cleanup) {
          await variant.cleanup();
        }
      });

      test(
        "causal consistency all-to-all, single key (multi-instance)",
        { timeout: 60 * 1000 },
        async () => {
          const N = 3;
          const bucket = `rnd-${variant.label}-${uuid().slice(0, 8)}`;
          const storages = await variant.makeStorages(bucket, N);
          await runCausalConsistencyCascade({
            storages,
            pollTickMs: variant.pollTickMs,
            // T4: assert the filtered-index invariant at the end of
            // the cascade. The CAS path is unaffected by filtered
            // projection, so causal-consistency stays green; the
            // additional check verifies the on-storage key set
            // tracks the live doc set under the filter.
            injectFilteredIndex: true,
          });
        },
      );

      test(
        "range/$in walk parity vs. in-memory full-scan (string-typed bounds only)",
        { timeout: 60 * 1000 },
        async () => {
          // Parity cascade only needs one Storage handle — there is
          // no cross-instance interleaving to test, just that the
          // planner-routed result matches the in-memory full-scan.
          const bucket = `rwp-${variant.label}-${uuid().slice(0, 8)}`;
          const [storage] = await variant.makeStorages(bucket, 1);
          await runRangeWalkParityCascade({ storage: storage! });
        },
      );
    });
  }
});
