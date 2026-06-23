/**
 * Randomized causal-consistency cascade — Node-side variant runner.
 *
 * Replaces the legacy `Baerly`-class harness. Now drives
 * `Writer.commit()` through three Node-runnable backends:
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
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getOrCreateMemoryStorageForBucket, type Storage, uuid } from "@baerly/protocol";
import { S3HttpStorage } from "@baerly/adapter-node";
import { LocalFsStorage } from "@baerly/dev";
import { createBucket } from "../fixtures/s3-fixtures.ts";
import {
  runCausalConsistencyCascade,
  runMultiDocCascade,
  runRangeWalkParityCascade,
} from "../fixtures/randomized-cascade.ts";
import { MINIO_ENDPOINT, TOXIPROXY_ADMIN_ENDPOINT, TOXIPROXY_ENDPOINT } from "../setup/ports.ts";

/**
 * (a) Per-doc consistency: `observed` must be a subsequence of `written`
 * (every observed value was written to this doc, in write order; no
 * value never written to it ever appears). Returns `true` iff `observed`
 * embeds into `written` preserving order. Values are compared by their
 * canonical token so structural equality is decidable by string equality.
 */
const isSubsequence = (observed: readonly string[], written: readonly string[]): boolean => {
  let w = 0;
  for (const o of observed) {
    while (w < written.length && written[w] !== o) {
      w++;
    }
    if (w >= written.length) {
      return false;
    }
    w++; // consume the match; preserves order + multiplicity
  }
  return true;
};

const stableConfig = {
  endpoint: MINIO_ENDPOINT,
  region: "eu-central-1",
  credentials: { accessKeyId: "baerly", secretAccessKey: "ZOAmumEzdsUUcVlQ" },
};
const unstableConfig = { ...stableConfig, endpoint: TOXIPROXY_ENDPOINT };

const minioEnabled = process.env["MINIO"] === "1";

// Toxiproxy toggle — the new core has no `setOnline()` knob; we flip
// the Minio proxy directly through Toxiproxy's HTTP admin API. No-op
// when MINIO is off so memory / local-fs variants don't try to reach
// the admin port.
const setOnline = async (state: boolean): Promise<void> => {
  if (!minioEnabled) {
    return;
  }
  await fetch(`${TOXIPROXY_ADMIN_ENDPOINT}/proxies/minio`, {
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
      return Array.from(
        { length: n },
        () =>
          new S3HttpStorage({
            endpoint: unstableConfig.endpoint, // Toxiproxy — fault injection
            bucket,
            sign: (req) => signer.sign(req),
          }),
      );
    },
  },
];

const variants = allVariants.filter((v) => !v.requiresMinio || minioEnabled);

describe("randomized (Db + Writer)", () => {
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
        "multi-doc-per-collection: per-doc consistency + single collection total order",
        { timeout: 60 * 1000 },
        async () => {
          const N = 3;
          const docIds = ["alpha", "bravo", "charlie", "delta"];
          const bucket = `mrnd-${variant.label}-${uuid().slice(0, 8)}`;
          const storages = await variant.makeStorages(bucket, N);
          const result = await runMultiDocCascade({
            storages,
            pollTickMs: variant.pollTickMs,
            docIds,
          });

          // (a) Per-doc consistency: for each docId, the observed
          // committed-value sequence for that doc is a subsequence of the
          // values written to that doc — no value never written to it
          // appears, and the order is preserved. The log linearizes the
          // collection, so a doc's committed entries appear in the order
          // they were committed; the observed sequence is the projection
          // of the global log onto that doc.
          for (const docId of docIds) {
            const written = result.writtenPerDoc[docId] ?? [];
            const observed = result.observedPerDoc[docId] ?? [];
            for (const v of observed) {
              expect(
                written,
                `doc ${docId}: observed value ${v} was never written to it`,
              ).toContain(v);
            }
            expect(
              isSubsequence(observed, written),
              `doc ${docId}: observed sequence ${JSON.stringify(observed)} is not a subsequence of written ${JSON.stringify(written)}`,
            ).toBe(true);
          }

          // (b) Collection total order: the committed `log/<seq>` numbers
          // across ALL docs form a contiguous, gap-free, duplicate-free
          // range `{start, start+1, …, start+n-1}`. The log linearizes the
          // COLLECTION, not the doc — every doc's commit takes the next
          // free slot in the one shared log.
          const seqs = result.committedSeqs.toSorted((a, b) => a - b);
          expect(seqs.length, "no commits landed in the multi-doc cascade").toBeGreaterThan(0);
          // No duplicates.
          expect(new Set(seqs).size, `duplicate log/<seq> slots: ${JSON.stringify(seqs)}`).toBe(
            seqs.length,
          );
          // Contiguous, gap-free: max - min + 1 === count, and each step is +1.
          const start = seqs[0]!;
          const end = seqs[seqs.length - 1]!;
          expect(end - start + 1, `log/<seq> range is not gap-free: ${JSON.stringify(seqs)}`).toBe(
            seqs.length,
          );
          for (let i = 0; i < seqs.length; i++) {
            expect(seqs[i], `gap at index ${i} in ${JSON.stringify(seqs)}`).toBe(start + i);
          }

          // (b′) Tie (a) and (b) together: every commit in this cascade is
          // a `U` op carrying a unique token, so each committed log slot
          // contributes exactly one observed per-doc value. The total count
          // of observed values across all docs MUST equal the count of
          // committed slots — proving the slot set and the projected
          // entries describe the SAME committed log, not two independent
          // tallies.
          const totalObserved = docIds.reduce(
            (sum, docId) => sum + (result.observedPerDoc[docId] ?? []).length,
            0,
          );
          expect(
            totalObserved,
            `Σ observed per-doc values (${totalObserved}) != committed slot count (${seqs.length})`,
          ).toBe(seqs.length);
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
