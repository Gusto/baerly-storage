import { expect, test } from "vitest";
import { createCurrentJson, MemoryStorage, type Storage } from "@baerly/protocol";
import { Db } from "@baerly/server";
import { allIndexKeysFor } from "../../packages/server/src/indexes.ts";
import { logStateCurrentJson, seedLogEntry } from "../fixtures/log-state.ts";

test("copying a legacy row to a fresh NFC id preserves its index after deleting the original", async () => {
  // Model R2's canonical-equivalent object keys without requiring credentials.
  const base = new MemoryStorage({ ephemeral: true });
  const storage: Storage = {
    get: (key, opts) => base.get(key.normalize("NFC"), opts),
    put: (key, body, opts) => base.put(key.normalize("NFC"), body, opts),
    delete: (key, opts) => base.delete(key.normalize("NFC"), opts),
    list: (prefix, opts) => base.list(prefix.normalize("NFC"), opts),
  };
  const prefix = "app/app/tenant/tenant/manifests/rows";
  const indexes = [{ name: "by_kind", on: "kind" }];
  const legacyId = "legacy-n\u0303";
  const body = { _id: legacyId, kind: "same" };
  await createCurrentJson(storage, `${prefix}/current.json`, logStateCurrentJson());
  // Seed bytes from the release that still allowed non-NFC writes.
  await seedLogEntry(storage, prefix, 0, { collection: "rows", doc_id: legacyId, after: body });
  for (const key of allIndexKeysFor(prefix, indexes, body, legacyId)) {
    await storage.put(key, new Uint8Array());
  }
  const rows = Db.create({
    storage,
    app: "app",
    tenant: "tenant",
    config: { collections: { rows: { indexes } } },
  }).collection("rows");
  const saved = (await rows.get(legacyId))!;
  // Omit the old id so the UUID cannot share its canonical marker key.
  const { _id: oldId, ...copy } = saved;
  const { _id: migratedId } = await rows.insert(copy);
  expect(oldId).toBe(legacyId);
  await expect(rows.delete(legacyId)).resolves.toEqual({ deleted: 1 });

  const migrated = { ...body, _id: migratedId };
  await expect(rows.get(legacyId)).resolves.toBeUndefined();
  await expect(rows.get(migratedId)).resolves.toEqual(migrated);
  await expect(rows.where({ kind: "same" }).all()).resolves.toEqual([migrated]);
});
