import { describe, test, expect } from "vitest";
import {
  getOrCreateMemoryStorageForBucket,
  createCurrentJson,
  CURRENT_JSON_SCHEMA_VERSION,
  type Storage,
} from "@baerly/protocol";
import { getPreset } from "../../bench/load-harness/presets.ts";
import { makeRng } from "../../bench/load-harness/generators/rng.ts";
import { buildDataset } from "../../bench/load-harness/generators/dataset.ts";
import { generateOpStream } from "../../bench/load-harness/generators/ops.ts";
import { CountingStorage } from "../../bench/storage.ts";
import { ManifestCachedStorage } from "../../bench/load-harness/stores/manifest-cache.ts";
import { runSeed } from "../../bench/load-harness/runner/seed.ts";
import { runReplay } from "../../bench/load-harness/runner/replay.ts";

// Side-effect imports to register all presets.
import "../../bench/load-harness/presets/recent-first-crud.ts";
import "../../bench/load-harness/presets/one-hot-tenant.ts";
import "../../bench/load-harness/presets/update-heavy-messy-log.ts";
import "../../bench/load-harness/presets/hot-tenant-compaction-debt.ts";
import "../../bench/load-harness/presets/many-tiny-apps.ts";
import "../../bench/load-harness/presets/rag-document-store.ts";
import "../../bench/load-harness/presets/chat-conversation-store.ts";

const PRESET_NAMES = [
  "recent-first-crud",
  "one-hot-tenant",
  "update-heavy-messy-log",
  "hot-tenant-compaction-debt",
  "many-tiny-apps",
  "rag-document-store",
  "chat-conversation-store",
] as const;

// Bound record bodies to 16 bytes — same pattern as
// bench/load-harness/tests/dataset.test.ts.
const tinyBodies = [{ cumulativeFraction: 1.0, maxBytes: 16 }];

// ---------------------------------------------------------------------------
// 1. Reproducibility
// ---------------------------------------------------------------------------

describe("preset reproducibility", () => {
  for (const name of PRESET_NAMES) {
    test(`${name}: same seed → same dataset and ops`, () => {
      const preset = getPreset(name);
      const opts = {
        seed: 42,
        tenantCount: 4,
        schema: { collection: preset.schema.collection },
        recordSizeBuckets: tinyBodies,
      };
      const a = buildDataset(opts);
      const b = buildDataset(opts);
      expect(a.totalRecords).toBe(b.totalRecords);
      for (let i = 0; i < a.tenants.length; i++) {
        expect(a.tenants[i]!.tenantId).toBe(b.tenants[i]!.tenantId);
        expect(a.tenants[i]!.records.length).toBe(b.tenants[i]!.records.length);
      }

      const aOps = generateOpStream({
        seed: 42,
        dataset: a,
        mix: preset.opMix,
        opCount: 50,
      });
      const bOps = generateOpStream({
        seed: 42,
        dataset: b,
        mix: preset.opMix,
        opCount: 50,
      });
      expect(aOps).toEqual(bOps);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Op-mix sum
// ---------------------------------------------------------------------------

describe("preset op-mix sum", () => {
  for (const name of PRESET_NAMES) {
    test(`${name}: op mix sums to 1.0 ± 0.01`, () => {
      const preset = getPreset(name);
      const sum = Object.values(preset.opMix.weights).reduce((a, b) => a + b, 0);
      expect(Math.abs(sum - 1.0)).toBeLessThan(0.01);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Smoke-run: seed + ingest phase on memory backend
// ---------------------------------------------------------------------------

describe("preset smoke-run", () => {
  for (const name of PRESET_NAMES) {
    test(`${name}: seed + ingest produces non-zero storage ops`, async () => {
      const preset = getPreset(name);
      const rng = makeRng(1);
      const memStorage = getOrCreateMemoryStorageForBucket(`bench-smoke-${name}`);
      const cache = new ManifestCachedStorage(memStorage, "metadata-warm");
      const counting = new CountingStorage(cache);

      const dataset = buildDataset({
        seed: rng.int(0, 2 ** 31),
        tenantCount: 4,
        schema: { collection: preset.schema.collection },
        tenantSizeBuckets: [{ cumulativeFraction: 1.0, maxRecords: 50 }],
        recordSizeBuckets: tinyBodies,
      });

      const allOps = generateOpStream({
        seed: rng.int(0, 2 ** 31),
        dataset,
        mix: preset.opMix,
        opCount: 100,
      });

      const app = "bench-smoke";
      const collection = preset.schema.collection;

      for (const tenant of dataset.tenants) {
        const key = `app/${app}/tenant/${tenant.tenantId}/manifests/${collection}/current.json`;
        await createCurrentJson(counting as unknown as Storage, key, {
          schema_version: CURRENT_JSON_SCHEMA_VERSION,
          snapshot: null,
          next_seq: 0,
          log_seq_start: 0,
          writer_fence: { epoch: 0, owner: "bench-smoke", claimed_at: "" },
        });
      }
      counting.reset();

      await runSeed({
        storage: counting,
        app,
        defaultTenant: "t-000000",
        collection,
        dataset,
      });

      const writeKinds = new Set(["insert", "update", "replace", "delete", "archive"]);
      const writeOps = allOps.filter((o) => writeKinds.has(o.kind));

      const ingestRes = await runReplay({
        storage: counting,
        app,
        defaultTenant: "t-000000",
        collection,
        ops: writeOps,
        phase: "ingest",
        recordLatency: () => {},
      });

      const snap = ingestRes.metrics;
      expect(snap.object_store.get + snap.object_store.put).toBeGreaterThan(0);
    });
  }
});
