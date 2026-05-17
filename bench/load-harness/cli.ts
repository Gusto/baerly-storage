/**
 * Load-harness CLI entry point.
 *
 * Wires the ticket-50 CountingStorage + ticket-51 preset framework
 * + ticket-53 runner + manifest cache into one invocation. Writes
 * a canonical `RunResult` JSON to `bench/results/load/` per the
 * shape locked in this file's `type RunResult` declaration.
 *
 * Backend gating mirrors `pnpm test:minio` — `--variant=node-minio`
 * requires `MINIO=1` and `pnpm dev:storage` running.
 *
 * @example
 * ```sh
 * pnpm bench:load --preset=recent-first-crud --variant=memory \
 *   --records=100 --ops=200 --seed=42
 * ```
 *
 * Result JSON shape locked at ticket 54 §2. Run an analysis pass via:
 *
 * ```sql
 * SELECT run.preset, run.cache_mode, derived.get_per_op
 * FROM read_json_auto('bench/results/load/*.json')
 * ORDER BY run.timestamp DESC LIMIT 20;
 * ```
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AwsClient } from "aws4fetch";
import { DOMParser } from "@xmldom/xmldom";
import {
  S3HttpStorage,
  getOrCreateMemoryStorageForBucket,
  createCurrentJson,
  CURRENT_JSON_SCHEMA_VERSION,
  type Storage,
} from "@baerly/protocol";
import type { IndexDefinition } from "@baerly/server";
import { LocalFsStorage } from "@baerly/dev";
import { CountingStorage } from "../storage.ts";
import type { StorageSnapshot } from "../types.ts";
import { ManifestCachedStorage, type ManifestCacheMode } from "./stores/manifest-cache.ts";
import { runSeed } from "./runner/seed.ts";
import { runReplay } from "./runner/replay.ts";
import { runCompact, type CompactProfileName } from "./runner/compact.ts";
import { getPreset, type Preset } from "./presets.ts";
import { makeRng } from "./generators/rng.ts";
import { buildDataset } from "./generators/dataset.ts";
import { generateOpStream, type Op } from "./generators/ops.ts";

// Side-effect imports to register presets before getPreset() works.
// eslint-disable-next-line import/no-unassigned-import
import "./presets/recent-first-crud.ts";
// eslint-disable-next-line import/no-unassigned-import
import "./presets/one-hot-tenant.ts";
// eslint-disable-next-line import/no-unassigned-import
import "./presets/update-heavy-messy-log.ts";
// eslint-disable-next-line import/no-unassigned-import
import "./presets/hot-tenant-compaction-debt.ts";
// eslint-disable-next-line import/no-unassigned-import
import "./presets/many-tiny-apps.ts";
// eslint-disable-next-line import/no-unassigned-import
import "./presets/rag-document-store.ts";
// eslint-disable-next-line import/no-unassigned-import
import "./presets/chat-conversation-store.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Variant = "memory" | "local-fs" | "node-minio" | "cloudflare-r2";

export type RunResult = {
  run: {
    preset: string;
    variant: "memory" | "local-fs" | "node-minio" | "cloudflare-r2";
    cache_mode: "cold" | "metadata-warm" | "data-warm" | "tiny-cache";
    records: number;
    ops: number;
    seed: number;
    timestamp: string;
    backend_details?: Record<string, string>;
  };
  latency_ms: {
    logical_op: { p50: number; p95: number; p99: number };
    by_op: Record<string, { p50: number; p95: number; p99: number }>;
  };
  object_store: {
    get: number;
    put: number;
    head: number;
    list: number;
    delete: number;
    bytes_read: number;
    bytes_written: number;
    retries: number;
    conflict_412: number;
    rate_limit_429: number;
  };
  derived: {
    get_per_op: number;
    put_per_op: number;
    bytes_read_per_op: number;
    bytes_written_per_op: number;
    class_a_per_tenant_per_hour: number;
  };
  cache: { manifest_hit_rate: number; snapshot_hit_rate: number };
  compaction: {
    bytes_read: number;
    bytes_written: number;
    objects_read: number;
    objects_written: number;
    write_amplification: number;
  };
};

// ---------------------------------------------------------------------------
// Argv parser
// ---------------------------------------------------------------------------

const argv = new Map<string, string>(
  process.argv.slice(2).flatMap((a) => {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    return m ? [[m[1]!, m[2]!]] : [];
  }),
);

function arg(name: string, dflt: string | undefined = undefined): string {
  const v = argv.get(name);
  if (v === undefined) {
    if (dflt === undefined) {
      throw new Error(`bench:load: missing required --${name}=…`);
    }
    return dflt;
  }
  return v;
}

function argNumber(name: string, dflt: number): number {
  const raw = argv.get(name);
  if (raw === undefined) return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`bench:load: --${name}=${raw} is not a number`);
  return n;
}

const presetName = arg("preset", "recent-first-crud");
const variant = arg("variant", "memory") as Variant;
const cacheMode = arg("cache-mode", "metadata-warm") as ManifestCacheMode;
const records = argNumber("records", 1_000);
const totalOps = argNumber("ops", 1_000);
const seed = argNumber("seed", 42);
const compactProfile = arg("profile", "NODE_PROFILE") as CompactProfileName;
const outputDir = arg("output-dir", "bench/results/load");
const tenants = argNumber("tenants", 1);
const app = arg("app", "bench");
const indexesMode = arg("indexes", "none") as "auto" | "none";
if (indexesMode !== "auto" && indexesMode !== "none") {
  throw new Error(`bench:load: --indexes must be "auto" or "none" (got ${String(indexesMode)})`);
}

// ---------------------------------------------------------------------------
// Variant-to-Storage factory
// ---------------------------------------------------------------------------

const MINIO_ENDPOINT = "http://127.0.0.1:9102";
const BENCH_BUCKET_NAME = "baerly-bench-load";
const S3_RETRIES = 8;
const HEALTH_CHECK_ENDPOINT = "http://127.0.0.1:9102/minio/health/ready";

interface VariantBuild {
  readonly inner: Storage;
  readonly backendDetails: Record<string, string>;
  cleanup?(): Promise<void>;
}

async function buildVariant(v: Variant): Promise<VariantBuild> {
  switch (v) {
    case "memory": {
      const inner = getOrCreateMemoryStorageForBucket(BENCH_BUCKET_NAME);
      return { inner, backendDetails: { kind: "memory" } };
    }
    case "local-fs": {
      const root = await mkdtemp(join(tmpdir(), "baerly-load-"));
      return {
        inner: new LocalFsStorage({ root }),
        backendDetails: { kind: "local-fs", root },
        cleanup: () => rm(root, { recursive: true, force: true }).catch(() => {}),
      };
    }
    case "node-minio": {
      if (process.env.MINIO !== "1") {
        throw new Error(
          `bench:load: --variant=node-minio requires MINIO=1. Run 'pnpm dev:storage' first, then 'MINIO=1 pnpm bench:load …'.`,
        );
      }
      try {
        const res = await fetch(HEALTH_CHECK_ENDPOINT);
        if (res.status !== 200) {
          throw new Error(
            `bench:load: Minio health check returned ${res.status}. Did you run 'pnpm dev:storage'?`,
          );
        }
      } catch (e) {
        throw new Error(
          `bench:load: Minio unreachable at ${MINIO_ENDPOINT} (${(e as Error).message}). Run 'pnpm dev:storage'.`,
          { cause: e },
        );
      }
      const signer = new AwsClient({
        accessKeyId: "baerly",
        secretAccessKey: "ZOAmumEzdsUUcVlQ",
        region: "us-east-1",
        service: "s3",
      });
      const created = await fetch(
        await signer.sign(new Request(`${MINIO_ENDPOINT}/${BENCH_BUCKET_NAME}`, { method: "PUT" })),
      );
      if (created.status !== 200 && created.status !== 204 && created.status !== 409) {
        throw new Error(`bench:load: bucket create returned ${created.status}`);
      }
      return {
        inner: new S3HttpStorage({
          endpoint: MINIO_ENDPOINT,
          bucket: BENCH_BUCKET_NAME,
          sign: (req) => signer.sign(req),
          xmlParser: new DOMParser(),
          retries: S3_RETRIES,
        }),
        backendDetails: { kind: "node-minio", endpoint: MINIO_ENDPOINT, bucket: BENCH_BUCKET_NAME },
      };
    }
    case "cloudflare-r2": {
      throw new Error(
        `bench:load: --variant=cloudflare-r2 is deferred. Run the miniflare-pool variant under a future ticket.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// currentJsonKeys derivation
// ---------------------------------------------------------------------------

function currentJsonKeysFor(
  appName: string,
  preset: Preset,
  dataset: ReturnType<typeof buildDataset>,
): string[] {
  // Use every tenant ID in the dataset (the dataset was already built
  // with `tenantCount` tenants from the CLI's `--tenants` flag).
  const collection = preset.schema.collection;
  return dataset.tenants.map(
    (t) => `app/${appName}/tenant/${t.tenantId}/manifests/${collection}/current.json`,
  );
}

// ---------------------------------------------------------------------------
// assembleResult
// ---------------------------------------------------------------------------

interface PhaseResult {
  readonly metrics: StorageSnapshot;
  readonly wallclockMs: number;
}

interface AssembleOpts {
  readonly preset: Preset;
  readonly variant: Variant;
  readonly cacheMode: ManifestCacheMode;
  readonly records: number;
  readonly totalOps: number;
  readonly seed: number;
  readonly startedIso: string;
  readonly backendDetails: Record<string, string>;
  readonly seedRes: PhaseResult;
  readonly ingestRes: PhaseResult;
  readonly queryPreRes: PhaseResult;
  readonly compactRes: PhaseResult;
  readonly queryPostRes: PhaseResult;
  readonly cacheStats: { manifestHitRate: number; snapshotHitRate: number };
  readonly latencyByOp: Map<string, number[]>;
  readonly tenants: number;
}

function pct(arr: number[], q: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].toSorted((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx]!;
}

function assembleResult(o: AssembleOpts): RunResult {
  const phases = [o.seedRes, o.ingestRes, o.queryPreRes, o.compactRes, o.queryPostRes];
  const sum = (pick: (s: StorageSnapshot) => number): number =>
    phases.reduce((acc, p) => acc + pick(p.metrics), 0);

  const get = sum((s) => s.object_store.get);
  const put = sum((s) => s.object_store.put);
  const head = sum((s) => s.object_store.head);
  const list = sum((s) => s.object_store.list);
  const del = sum((s) => s.object_store.delete);
  const bytesRead = sum((s) => s.object_store.bytes_read);
  const bytesWritten = sum((s) => s.object_store.bytes_written);
  const retries = sum((s) => s.object_store.retries);
  const conflict412 = sum((s) => s.object_store.conflict_412);
  const rateLimit429 = sum((s) => s.object_store.rate_limit_429);

  // Class A idle bound: measured during query-post phase only.
  const classAInQueryPost =
    o.queryPostRes.metrics.object_store.put +
    o.queryPostRes.metrics.object_store.list +
    o.queryPostRes.metrics.object_store.delete;
  const queryPostHours = Math.max(1e-6, o.queryPostRes.wallclockMs / 3_600_000);
  const classAPerTenantPerHour = classAInQueryPost / Math.max(1, o.tenants) / queryPostHours;

  // Compaction phase isolation.
  const compactObjectsRead = o.compactRes.metrics.object_store.get;
  const compactObjectsWritten = o.compactRes.metrics.object_store.put;
  const compactBytesRead = o.compactRes.metrics.object_store.bytes_read;
  const compactBytesWritten = o.compactRes.metrics.object_store.bytes_written;

  // Per-op latency percentiles.
  const allLatencies: number[] = [];
  const byOp: Record<string, { p50: number; p95: number; p99: number }> = {};
  for (const [kind, arr] of o.latencyByOp) {
    byOp[kind] = { p50: pct(arr, 0.5), p95: pct(arr, 0.95), p99: pct(arr, 0.99) };
    allLatencies.push(...arr);
  }
  const logicalOp = {
    p50: pct(allLatencies, 0.5),
    p95: pct(allLatencies, 0.95),
    p99: pct(allLatencies, 0.99),
  };

  return {
    run: {
      preset: o.preset.name,
      variant: o.variant,
      cache_mode: o.cacheMode,
      records: o.records,
      ops: o.totalOps,
      seed: o.seed,
      timestamp: o.startedIso,
      backend_details: o.backendDetails,
    },
    latency_ms: { logical_op: logicalOp, by_op: byOp },
    object_store: {
      get,
      put,
      head,
      list,
      delete: del,
      bytes_read: bytesRead,
      bytes_written: bytesWritten,
      retries,
      conflict_412: conflict412,
      rate_limit_429: rateLimit429,
    },
    derived: {
      get_per_op: get / Math.max(1, o.totalOps),
      put_per_op: put / Math.max(1, o.totalOps),
      bytes_read_per_op: bytesRead / Math.max(1, o.totalOps),
      bytes_written_per_op: bytesWritten / Math.max(1, o.totalOps),
      class_a_per_tenant_per_hour: classAPerTenantPerHour,
    },
    cache: {
      manifest_hit_rate: o.cacheStats.manifestHitRate,
      snapshot_hit_rate: o.cacheStats.snapshotHitRate,
    },
    compaction: {
      bytes_read: compactBytesRead,
      bytes_written: compactBytesWritten,
      objects_read: compactObjectsRead,
      objects_written: compactObjectsWritten,
      write_amplification: compactBytesWritten / Math.max(1, compactBytesRead),
    },
  };
}

// ---------------------------------------------------------------------------
// Main driver
// ---------------------------------------------------------------------------

const WRITE_KINDS = new Set(["insert", "update", "replace", "delete", "archive"]);

async function main(): Promise<void> {
  // Validate preset (exits 1 on unknown via getPreset's throw).
  const preset: Preset = getPreset(presetName);

  const built = await buildVariant(variant);
  try {
    const cache = new ManifestCachedStorage(built.inner, cacheMode);
    const counting = new CountingStorage(cache);

    const rng = makeRng(seed);

    // Build a compact dataset shaped to `records` records × `tenants` tenants.
    const dataset = buildDataset({
      seed: rng.int(0, 2 ** 31),
      tenantCount: tenants,
      schema: { collection: preset.schema.collection },
      tenantSizeBuckets: [{ cumulativeFraction: 1.0, maxRecords: Math.max(1, records) }],
    });

    // Generate op stream from preset mix.
    const allOps: Op[] = generateOpStream({
      seed: rng.int(0, 2 ** 31),
      dataset,
      mix: preset.opMix,
      opCount: totalOps,
    });

    const writeOps = allOps.filter((o) => WRITE_KINDS.has(o.kind));
    const readOps = allOps.filter((o) => !WRITE_KINDS.has(o.kind));

    const latencyByOp = new Map<string, number[]>();
    const recordLatency = (kind: string, ms: number): void => {
      let arr = latencyByOp.get(kind);
      if (arr === undefined) {
        arr = [];
        latencyByOp.set(kind, arr);
      }
      arr.push(ms);
    };

    const startedIso = new Date().toISOString();
    const collection = preset.schema.collection;

    // Optional auto-planner indexes map. When `--indexes=auto`, declare a
    // single-field index on `popularityRank` — the field the
    // `filtered-list` op kind targets in `replay.ts` — so the planner
    // can route the read through `runIndexWalkPlan` instead of the
    // snapshot+log fold. When `--indexes=none`, leave the map undefined
    // so `Db.create` falls back to its `EMPTY_INDEX_MAP` sentinel.
    const indexesMap: ReadonlyMap<string, ReadonlyArray<IndexDefinition>> | undefined =
      indexesMode === "auto"
        ? new Map<string, ReadonlyArray<IndexDefinition>>([
            [collection, [{ name: "by_popularity_rank", on: "popularityRank" }]],
          ])
        : undefined;

    // Bootstrap current.json for every tenant in the dataset before
    // seeding. `ServerWriter` requires current.json to exist; `Db.create`
    // alone does NOT create it (same pattern as the integration tests).
    for (const tenant of dataset.tenants) {
      const key = `app/${app}/tenant/${tenant.tenantId}/manifests/${collection}/current.json`;
      await createCurrentJson(counting as unknown as Storage, key, {
        schema_version: CURRENT_JSON_SCHEMA_VERSION,
        snapshot: null,
        next_seq: 0,
        log_seq_start: 0,
        writer_fence: { epoch: 0, owner: "bench-load", claimed_at: "" },
      });
    }
    // Reset counters so bootstrap ops don't pollute phase metrics.
    counting.reset();

    // Phase 1: Seed — insert every dataset record once.
    const seedRes = await runSeed({
      storage: counting,
      app,
      defaultTenant: "hot",
      collection,
      dataset,
      ...(indexesMap !== undefined && { indexes: indexesMap }),
    });

    // Phase 2: Ingest — write-heavy replay.
    const ingestRes = await runReplay({
      storage: counting,
      app,
      defaultTenant: "hot",
      collection,
      ops: writeOps,
      phase: "ingest",
      recordLatency,
      ...(indexesMap !== undefined && { indexes: indexesMap }),
    });

    // Phase 3: Query pre-compact — read-only on uncompacted log.
    const queryPreRes = await runReplay({
      storage: counting,
      app,
      defaultTenant: "hot",
      collection,
      ops: readOps,
      phase: "query-pre",
      recordLatency,
      ...(indexesMap !== undefined && { indexes: indexesMap }),
    });

    // Phase 4: Compact.
    const currentJsonKeys = currentJsonKeysFor(app, preset, dataset);
    const compactRes = await runCompact({
      storage: counting,
      currentJsonKeys,
      profile: compactProfile,
    });

    // Phase 5: Query post-compact.
    const queryPostRes = await runReplay({
      storage: counting,
      app,
      defaultTenant: "hot",
      collection,
      ops: readOps,
      phase: "query-post",
      recordLatency,
      ...(indexesMap !== undefined && { indexes: indexesMap }),
    });

    const result = assembleResult({
      preset,
      variant,
      cacheMode,
      records,
      totalOps,
      seed,
      startedIso,
      backendDetails: { ...built.backendDetails, indexes_mode: indexesMode },
      seedRes,
      ingestRes,
      queryPreRes,
      compactRes,
      queryPostRes,
      cacheStats: cache.stats(),
      latencyByOp,
      tenants,
    });

    await mkdir(outputDir, { recursive: true });
    const stamp = startedIso.replace(/[:.]/g, "-");
    const out = join(outputDir, `${preset.name}-${variant}-${cacheMode}-${stamp}.json`);
    await writeFile(out, JSON.stringify(result, null, 2));

    // One-line stdout summary for at-a-glance sweep output.
    console.log(
      `${preset.name} v=${variant} c=${cacheMode} ops=${totalOps} ` +
        `get/op=${result.derived.get_per_op.toFixed(3)} ` +
        `put/op=${result.derived.put_per_op.toFixed(3)} ` +
        `bytes/op=${result.derived.bytes_read_per_op.toFixed(0)} ` +
        `p95(list_recent)=${result.latency_ms.by_op["list-recent"]?.p95.toFixed(1) ?? "n/a"}ms ` +
        `out=${out}`,
    );
  } finally {
    if (built.cleanup !== undefined) await built.cleanup();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
});
