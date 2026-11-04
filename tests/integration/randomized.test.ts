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
import { fc, test as fcTest } from "@fast-check/vitest";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  BaerlyError,
  type Collection,
  createCurrentJson,
  decodeJsonBytes,
  type DocumentData,
  getOrCreateMemoryStorageForBucket,
  type LogEntry,
  logSeqStartOf,
  MemoryStorage,
  readCurrentJson,
  type Storage,
  uuid,
} from "@baerly/protocol";
import { S3HttpStorage, gcsStorage } from "@baerly/adapter-node";
import { LocalFsStorage } from "@baerly/dev";
import { Db, loadSnapshotAsMap, walkLogRange } from "@baerly/server";
import { compact } from "@baerly/server/maintenance";
import { createObservabilityContext, runWithContext } from "@baerly/server/observability";
import type { InternalCompactOptions } from "@baerly/server/_internal/testing";
import { type Op, opArbOver } from "../../packages/server/src/_internal/randomized-model.ts";
import { foldLogEntriesOnto } from "../../packages/server/src/log-walk.ts";
import { Writer } from "../../packages/server/src/writer.ts";
import { logStateCurrentJson } from "../fixtures/log-state.ts";
import { createBucket } from "../fixtures/s3-fixtures.ts";
import { type EndpointCreds, loadEndpointCreds } from "../fixtures/endpoint-creds.ts";
import {
  runCausalConsistencyCascade,
  runMultiDocCascade,
  runRangeWalkParityCascade,
  runSameIdInsertRaceCascade,
} from "../fixtures/randomized-cascade.ts";
import {
  MINIO_ACCESS_KEY,
  MINIO_ENDPOINT,
  MINIO_SECRET_KEY,
  TOXIPROXY_ADMIN_ENDPOINT,
  TOXIPROXY_ENDPOINT,
} from "../setup/ports.ts";

fcTest.prop({
  // How the first create's outcome reaches the Writer: the call fails after
  // landing (a lost ack), the adapter's hidden retry sees the landed object
  // as a 412, or the call fails without landing (an in-flight send that may
  // still land, or never will).
  createOutcome: fc.constantFrom("lost-ack", "hidden-retry-412", "not-landed"),
  unreadableResolution: fc.boolean(),
})(
  "uncertain create histories preserve at most one durable commit per logical call, with one create per slot",
  async ({ createOutcome, unreadableResolution }) => {
    const prefix = "app/fate/tenant/t/manifests/c";
    const firstSlot = `${prefix}/log/0.json`;
    let faultEnabled = true;
    let putAttempts = 0;
    let readbacks = 0;
    class FaultStorage extends MemoryStorage {
      override async put(
        ...args: Parameters<MemoryStorage["put"]>
      ): ReturnType<MemoryStorage["put"]> {
        if (faultEnabled && args[0] === firstSlot && args[2]?.ifNoneMatch === "*") {
          putAttempts++;
          if (putAttempts > 1) {
            // A Writer-level resend: never honoured, so it cannot mask a
            // missing readback.
            throw new BaerlyError("NetworkError", "resend unavailable");
          }
          if (createOutcome !== "not-landed") {
            await super.put(...args);
          }
          if (createOutcome === "hidden-retry-412") {
            throw new BaerlyError("WriteConflict", "412 precondition failed");
          }
          throw new BaerlyError("NetworkError", "create acknowledgement lost");
        }
        return super.put(...args);
      }

      override async get(
        ...args: Parameters<MemoryStorage["get"]>
      ): ReturnType<MemoryStorage["get"]> {
        if (faultEnabled && putAttempts > 0 && args[0] === firstSlot) {
          readbacks++;
          if (unreadableResolution) {
            throw new BaerlyError("NetworkError", "resolution unavailable");
          }
        }
        return super.get(...args);
      }
    }
    const storage = new FaultStorage();
    const currentJsonKey = `${prefix}/current.json`;
    await createCurrentJson(storage, currentJsonKey, logStateCurrentJson());
    const newWriter = () => new Writer({ storage, currentJsonKey });
    const logicalCall = () =>
      newWriter().commit({
        op: "I",
        collection: "c",
        docId: "own",
        body: { _id: "own" },
      });
    let failure: unknown;
    try {
      await logicalCall();
    } catch (error) {
      failure = error;
      faultEnabled = false;
      if ((error as BaerlyError).retriable) {
        await logicalCall();
      }
    }
    faultEnabled = false;
    const landed = createOutcome !== "not-landed";
    const next = await newWriter().commit({
      op: "I",
      collection: "c",
      docId: "next",
      body: { _id: "next" },
    });
    const history: LogEntry[] = [];
    for await (const listed of storage.list(`${prefix}/log/`)) {
      history.push(decodeJsonBytes<LogEntry>((await storage.get(listed.key))!.body));
    }
    expect(history.map((entry) => entry.doc_id)).toEqual(landed ? ["own", "next"] : ["next"]);
    expect(next.entry.seq).toBe(landed ? 1 : 0);
    // One create and one readback at the slot: the adapter owns retries.
    expect(putAttempts).toBe(1);
    expect(readbacks).toBe(1);
    if (unreadableResolution || !landed) {
      // An unreadable or absent slot cannot prove the send won't land.
      expect(failure).toMatchObject({ code: "AmbiguousCommit", retriable: false });
    } else {
      expect(failure).toBeUndefined();
    }
  },
);

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

/**
 * Fold-versus-commit protocol ordering. Two writers own disjoint scalar IDs
 * (an NFC/NFD pair split across them, plus an astral ID) and commit while
 * up to two compactors fold the same collection concurrently. After every
 * round:
 *
 * - a fold publishes an exact prefix of the linearized log: the head's
 *   snapshot, read through `loadSnapshotAsMap`, equals the reference fold
 *   of `log/[0, log_seq_start)`;
 * - no two published folds advance from the same captured floor (one
 *   winner per head), and the floor never moves backward. Concurrent fold
 *   attempts may start from the same floor; only one of them may publish;
 * - the customer-visible read equals the committed model.
 *
 * At the end the committed `log/<seq>` slots are gap-free.
 */
const WRITER_IDS: readonly (readonly [string, string])[] = [
  ["a", "\u00e9"],
  ["e\u0301", "\u{10000}"],
];
const ORDERING_APP = "ordering";
const ORDERING_COLLECTION = "rows";

type OrderingRound = {
  readonly commits: readonly [Op | null, Op | null];
  readonly compactors: number;
  /**
   * `maxEntriesPerRun` for this round's folds; `null` folds to the tail. A
   * capped fold still stamps the probed tail as `tail_hint`, so the reader's
   * strict walk over `[log_seq_start, tail_hint)` carries entries.
   */
  readonly foldCap: number | null;
};
const writerOpArb = (writerIndex: number): fc.Arbitrary<Op | null> =>
  fc.option(opArbOver(fc.constantFrom(...WRITER_IDS[writerIndex]!)));
const orderingRoundsArb: fc.Arbitrary<OrderingRound[]> = fc.array(
  fc.record({
    commits: fc.tuple(writerOpArb(0), writerOpArb(1)),
    compactors: fc.integer({ min: 0, max: 2 }),
    foldCap: fc.option(fc.integer({ min: 1, max: 3 })),
  }),
  { minLength: 1, maxLength: 10 },
);

const GLOBAL_RUNS = fc.readConfigureGlobal().numRuns ?? 100;

const runFoldCommitOrdering = async (
  storages: readonly Storage[],
  rounds: readonly OrderingRound[],
): Promise<void> => {
  const tenant = `ord-${uuid().slice(0, 8)}`;
  const prefix = `app/${ORDERING_APP}/tenant/${tenant}/manifests/${ORDERING_COLLECTION}`;
  const currentJsonKey = `${prefix}/current.json`;
  await createCurrentJson(storages[0]!, currentJsonKey, logStateCurrentJson());
  const writers = [0, 1].map((index) => new Writer({ storage: storages[index]!, currentJsonKey }));
  const model = new Map<string, DocumentData>();
  const committedSeqs: number[] = [];
  const publishedFloors: number[] = [];
  let lastFloor = 0;

  for (const round of rounds) {
    const actions: Promise<unknown>[] = [];
    round.commits.forEach((op, writerIndex) => {
      if (op === null) {
        return;
      }
      // Each writer owns its ids, so the model check cannot race the
      // other writer's commit in the same round.
      const live = model.has(op.id);
      if ((op.kind === "I" && live) || (op.kind !== "I" && !live)) {
        return;
      }
      const body = { _id: op.id, v: op.v! };
      actions.push(
        writers[writerIndex]!.commit(
          op.kind === "D"
            ? { op: "D", collection: ORDERING_COLLECTION, docId: op.id }
            : { op: op.kind, collection: ORDERING_COLLECTION, docId: op.id, body },
        ).then((result) => {
          committedSeqs.push(result.entry.seq);
          if (op.kind === "D") {
            model.delete(op.id);
          } else {
            model.set(op.id, body);
          }
        }),
      );
    });
    for (let k = 0; k < round.compactors; k++) {
      actions.push(
        compact({ storage: storages[2 + k]!, currentJsonKey }, {
          minEntriesToCompact: 1,
          ...(round.foldCap !== null && { maxEntriesPerRun: round.foldCap }),
        } as InternalCompactOptions).then((result) => {
          expect(["below-min-threshold", "cas-lost", undefined]).toContain(result.skippedReason);
          if (result.written) {
            publishedFloors.push(result.logSeqStartBefore);
            expect(result.logSeqStartAfter).toBeGreaterThan(result.logSeqStartBefore);
          }
        }),
      );
    }
    await Promise.all(actions);

    expect(
      new Set(publishedFloors).size,
      `two folds published from one floor: ${JSON.stringify(publishedFloors)}`,
    ).toBe(publishedFloors.length);
    const read = (await readCurrentJson(storages[0]!, currentJsonKey))!;
    const floor = logSeqStartOf(read.json);
    expect(floor, "log_seq_start moved backward").toBeGreaterThanOrEqual(lastFloor);
    expect(floor).toBeLessThanOrEqual(committedSeqs.length);
    lastFloor = floor;

    const reference = new Map<string, DocumentData>();
    foldLogEntriesOnto(reference, await walkLogRange(storages[0]!, prefix, 0, floor), {
      collection: ORDERING_COLLECTION,
    });
    const snapshot =
      read.json.snapshot === null
        ? new Map<string, DocumentData>()
        : await loadSnapshotAsMap(storages[0]!, read.json.snapshot, ORDERING_COLLECTION);
    expect(Object.fromEntries(snapshot)).toEqual(Object.fromEntries(reference));

    const db = Db.create({ storage: storages[1]!, app: ORDERING_APP, tenant });
    const rows = await (db.collection(ORDERING_COLLECTION) as Collection<DocumentData>)
      .where({})
      .all();
    expect(Object.fromEntries(rows.map((r) => [r["_id"] as string, r]))).toEqual(
      Object.fromEntries(model),
    );
  }
  const seqs = committedSeqs.toSorted((a, b) => a - b);
  expect(seqs).toEqual(seqs.map((_, index) => index));
};

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

      test(
        "concurrent same-_id inserts: the first I wins each incarnation (multi-instance)",
        { timeout: 60 * 1000 },
        async () => {
          const bucket = `ins-${variant.label}-${uuid().slice(0, 8)}`;
          const storages = await variant.makeStorages(bucket, 3);
          await runSameIdInsertRaceCascade({
            storages,
            // Only Minio runs behind the Toxiproxy fault twiddler.
            faultInjection: variant.label === "node-minio",
          });
        },
      );

      // Fold-versus-commit ordering runs on the zero-infra variants; the
      // remote ones add only latency to a backend-agnostic protocol check.
      test.skipIf(variant.label !== "memory" && variant.label !== "local-fs")(
        "fold vs commit ordering: concurrent folds publish an exact log prefix, one winner per floor",
        { timeout: GLOBAL_RUNS > 1_000 ? 600_000 : 60_000 },
        async () => {
          // Each run is real concurrent I/O, so the count is fixed rather
          // than `FC_NUM_RUNS`; `test:randomize` runs five times as many.
          const base = variant.label === "memory" ? 20 : 8;
          await fc.assert(
            fc.asyncProperty(orderingRoundsArb, async (rounds) => {
              const bucket = `ord-${variant.label}-${uuid().slice(0, 8)}`;
              const storages = await variant.makeStorages(bucket, 4);
              // Write-tick maintenance off: the compactors are the only
              // folders, so the ordering under test is fold vs commit.
              await runWithContext(
                createObservabilityContext({ maintenance: { disabled: true } }),
                () => runFoldCommitOrdering(storages, rounds),
              );
            }),
            { numRuns: GLOBAL_RUNS > 1_000 ? base * 5 : base },
          );
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
