/**
 * Randomized causal-consistency cascade — Node-side variant runner.
 *
 * Replaces the legacy `Baerly`-class harness. Now drives
 * `Writer.commit()` through four Node-runnable backends:
 *   - `memory`    — `MemoryStorage` shared per bucket; zero infra.
 *   - `local-fs`  — `LocalFsStorage` over a fresh tmp dir; zero infra.
 *   - `node-minio`— `S3HttpStorage` against Toxiproxy → Minio; gated on
 *                   `MINIO=1`.
 *   - `node-gcs`  — `gcsStorage` (native GCS) against the real
 *                   credentials bucket from `credentials/gcs.json`; gated
 *                   on `CONFORMANCE=1`. No fault-injection seam —
 *                   this variant proves multi-writer linearizability over
 *                   the real endpoint, not fault tolerance.
 *
 * The fifth adapter (`cloudflare-r2`) runs under the `cloudflare-pool`
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
import { S3HttpStorage, gcsStorage } from "@baerly/adapter-node";
import { LocalFsStorage } from "@baerly/dev";
import { createBucket } from "../fixtures/s3-fixtures.ts";
import { type EndpointCreds, loadEndpointCreds } from "../fixtures/endpoint-creds.ts";
import {
  runCausalConsistencyCascade,
  runMultiDocCascade,
  runRangeWalkParityCascade,
} from "../fixtures/randomized-cascade.ts";
import {
  MINIO_ACCESS_KEY,
  MINIO_ENDPOINT,
  MINIO_SECRET_KEY,
  TOXIPROXY_ADMIN_ENDPOINT,
  TOXIPROXY_ENDPOINT,
} from "../setup/ports.ts";

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
  credentials: { accessKeyId: MINIO_ACCESS_KEY, secretAccessKey: MINIO_SECRET_KEY },
};
const unstableConfig = { ...stableConfig, endpoint: TOXIPROXY_ENDPOINT };

const minioEnabled = process.env["MINIO"] === "1";

// Resolve at module top level — vitest collects suites synchronously, so
// `describe` callbacks must not be `async`. Mirrors `conformance.test.ts`.
// `EndpointCreds` is the shared credentials/*.json shape; the GCS path only
// reads `bucket` + `credentials` (gcsStorage pins the native host).
const gcsCreds: EndpointCreds | null = await loadEndpointCreds("gcs.json");
const gcsEnabled = gcsCreds !== null && process.env["CONFORMANCE"] === "1";

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
  readonly label: "memory" | "local-fs" | "node-minio" | "node-gcs";
  readonly requiresMinio?: boolean;
  readonly requiresGcs?: boolean;
  /** Per-tick poll cadence; tuned per backend. */
  readonly pollTickMs: number;
  /** Strongly consistent backend → assert read-your-writes + monotonic-reads. */
  readonly strongConsistency: boolean;
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
    strongConsistency: true,
    // Process-singleton: same bucket → same underlying MemoryStorage.
    // Same mechanism the legacy `memory` variant used.
    makeStorages: async (bucket, n): Promise<Storage[]> =>
      Array.from({ length: n }, () => getOrCreateMemoryStorageForBucket(bucket)),
  },
  {
    label: "local-fs",
    pollTickMs: 10,
    strongConsistency: true,
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
    strongConsistency: false,
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
  {
    label: "node-gcs",
    requiresGcs: true,
    // GCS is a real remote endpoint with no fault-injection seam; a
    // larger tick than node-minio's keeps the run measuring contention
    // correctness rather than remote-read round-trip pressure.
    pollTickMs: 250,
    // GCS list-after-write is immediately consistent, and there is no
    // fault injection for this variant — read-your-writes / monotonic-
    // reads must hold.
    strongConsistency: true,
    // Bring-your-own-bucket: ignore the synthetic per-test `bucket` arg
    // and use the real creds bucket. Safe because the cascade fixture
    // picks a fresh `sharedTenant = cascade-<uuid>` per invocation, so
    // every run's keys live under a unique
    // `app/randomized/tenant/cascade-<uuid>/…` prefix — no cross-run
    // collision on the shared bucket.
    makeStorages: async (_bucket, n): Promise<Storage[]> => {
      const creds = gcsCreds!;
      return Array.from({ length: n }, () =>
        gcsStorage({ bucket: creds.bucket, credentials: creds.credentials }),
      );
    },
    // Best-effort sweep of the whole `app/randomized/` prefix on the
    // shared bucket. The cascade generates its tenant internally, so
    // the variant can only sweep the whole space, not just its own
    // tenant — expected and fine; failures here must never fail the
    // suite.
    cleanup: async (): Promise<void> => {
      try {
        const creds = gcsCreds!;
        const sweeper = gcsStorage({ bucket: creds.bucket, credentials: creds.credentials });
        // Internal best-effort deadline, kept under the 30s `afterEach`
        // hook timeout so the sweep always returns cleanly rather than
        // being externally killed mid-delete.
        const GCS_CLEANUP_BUDGET_MS = 20_000;
        const deadline = Date.now() + GCS_CLEANUP_BUDGET_MS;
        for await (const entry of sweeper.list("app/randomized/")) {
          if (Date.now() > deadline) {
            break;
          }
          await sweeper.delete(entry.key).catch(() => {
            // Best-effort — a single failed delete must not fail the suite.
          });
        }
      } catch {
        // Best-effort — sweep failures (soft-delete/eventual quirks,
        // transient errors) must never fail the suite.
      }
    },
  },
];

const variants = allVariants.filter(
  (v) => (!v.requiresMinio || minioEnabled) && (!v.requiresGcs || gcsEnabled),
);

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

      afterEach(
        async () => {
          if (networkTwiddler) {
            clearInterval(networkTwiddler);
          }
          await setOnline(true);
          if (variant.cleanup) {
            await variant.cleanup();
          }
        },
        // `node-gcs`'s cleanup sweeps the shared bucket with sequential
        // network round-trip deletes — vitest's 5s default hook timeout
        // is too tight for a real remote endpoint. Other variants'
        // cleanup is local (tmp-dir rm) and stays well under 5s.
        variant.label === "node-gcs" ? 30_000 : undefined,
      );

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
            strongConsistency: variant.strongConsistency,
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

      // Single-writer (N=1) planner-parity check with no cross-instance
      // contention. node-gcs is enrolled in this cascade for the two
      // multi-writer commit-path proofs above; its 72 sequential seed
      // commits against the real remote endpoint exceed this file's 60s
      // convention without exercising anything GCS-specific — planner
      // routing is backend-agnostic, and real-GCS Storage semantics are
      // already covered by tests/integration/conformance.test.ts.
      test.skipIf(variant.label === "node-gcs")(
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
