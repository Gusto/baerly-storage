/* eslint-disable no-underscore-dangle -- `_id` is the locked primary key. */
import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  type DocumentData,
  MemoryStorage,
} from "@baerly/protocol";
import { allIndexKeysFor, type IndexDefinition } from "./indexes.ts";
import { rebuildIndex } from "./rebuild-index.ts";
import { Writer } from "./writer.ts";

const PROP_TIMEOUT_MS = 600_000;
const CURRENT_JSON_KEY = "app/x/tenant/t/manifests/tickets/current.json";
const LOG_PREFIX = "app/x/tenant/t/manifests/tickets";
const COLLECTION = "tickets";
const INDEX: IndexDefinition = { name: "by_status", on: "status" };
const INDEX_PREFIX = `${LOG_PREFIX}/index/${INDEX.name}/`;

type Doc = DocumentData & { _id: string; status: "open" | "closed" | "wip" };

const opArb = fc.oneof(
  fc.record({
    kind: fc.constant("I" as const),
    id: fc.constantFrom("a", "b", "c", "d"),
    status: fc.constantFrom("open" as const, "closed" as const, "wip" as const),
  }),
  fc.record({
    kind: fc.constant("U" as const),
    id: fc.constantFrom("a", "b", "c", "d"),
    status: fc.constantFrom("open" as const, "closed" as const, "wip" as const),
  }),
  fc.record({ kind: fc.constant("D" as const), id: fc.constantFrom("a", "b", "c", "d") }),
);

const listIndexKeys = async (storage: MemoryStorage): Promise<Set<string>> => {
  const out = new Set<string>();
  for await (const e of storage.list(INDEX_PREFIX)) {
    out.add(e.key);
  }
  return out;
};

describe("rebuildIndex — idempotent reconciliation + convergence from corruption", () => {
  test.prop({
    ops: fc.array(opArb, { minLength: 0, maxLength: 30 }),
    corruptionSeed: fc.array(fc.boolean(), { minLength: 0, maxLength: 30 }),
    orphanCount: fc.integer({ min: 0, max: 4 }),
  })(
    "heals any corrupted index in one pass; second pass is a no-op; dryRun is read-only",
    async ({ ops, corruptionSeed, orphanCount }) => {
      const storage = new MemoryStorage();
      await createCurrentJson(storage, CURRENT_JSON_KEY, {
        schema_version: CURRENT_JSON_SCHEMA_VERSION,
        snapshot: null,
        tail_hint: 0,
        log_seq_start: 0,
        writer_fence: { epoch: 0, owner: "test", claimed_at: "" },
        snapshot_bytes: 0,
        snapshot_rows: 0,
      });
      const writer = new Writer({
        storage,
        currentJsonKey: CURRENT_JSON_KEY,
        options: { indexes: [INDEX] },
      });

      const model = new Map<string, Doc>();
      for (const op of ops) {
        if (op.kind === "I") {
          if (model.has(op.id)) {
            continue;
          }
          const doc: Doc = { _id: op.id, status: op.status };
          await writer.commit({ op: "I", collection: COLLECTION, docId: op.id, body: doc });
          model.set(op.id, doc);
        } else if (op.kind === "U") {
          if (!model.has(op.id)) {
            continue;
          }
          const doc: Doc = { _id: op.id, status: op.status };
          await writer.commit({ op: "U", collection: COLLECTION, docId: op.id, body: doc });
          model.set(op.id, doc);
        } else {
          if (!model.has(op.id)) {
            continue;
          }
          await writer.commit({ op: "D", collection: COLLECTION, docId: op.id });
          model.delete(op.id);
        }
      }

      // Expected = projection of the live model.
      const expected = new Set<string>();
      for (const doc of model.values()) {
        for (const k of allIndexKeysFor(LOG_PREFIX, [INDEX], doc, doc._id)) {
          expected.add(k);
        }
      }

      // (1) Healthy index ⇒ no-op.
      const healthy = await rebuildIndex(storage, CURRENT_JSON_KEY, INDEX);
      expect({ added: healthy.added, removed: healthy.removed }).toEqual({ added: 0, removed: 0 });
      await expect(listIndexKeys(storage)).resolves.toEqual(expected);

      // (2) Corrupt: delete a subset of real keys, inject bogus orphans.
      const realKeys = [...(await listIndexKeys(storage))];
      for (let i = 0; i < realKeys.length; i++) {
        if (corruptionSeed[i % Math.max(corruptionSeed.length, 1)] === true) {
          await storage.delete(realKeys[i]!);
        }
      }
      for (let i = 0; i < orphanCount; i++) {
        // A well-formed-looking but unreferenced index key.
        await storage.put(`${INDEX_PREFIX}zzzz${i}/ghost${i}.json`, new Uint8Array(0), {
          contentType: "application/json",
        });
      }

      // dryRun must NOT mutate storage.
      const corruptedSnapshot = await listIndexKeys(storage);
      await rebuildIndex(storage, CURRENT_JSON_KEY, INDEX, { dryRun: true });
      await expect(listIndexKeys(storage)).resolves.toEqual(corruptedSnapshot);

      // (2 cont.) One real rebuild converges to `expected`.
      await rebuildIndex(storage, CURRENT_JSON_KEY, INDEX);
      await expect(listIndexKeys(storage)).resolves.toEqual(expected);

      // (2 cont.) Second rebuild is a no-op.
      const second = await rebuildIndex(storage, CURRENT_JSON_KEY, INDEX);
      expect({ added: second.added, removed: second.removed }).toEqual({ added: 0, removed: 0 });
    },
    PROP_TIMEOUT_MS,
  );
});
