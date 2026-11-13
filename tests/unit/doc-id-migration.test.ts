import { expect, test } from "vitest";
import { createCurrentJson, MemoryStorage, type Storage } from "@baerly/protocol";
import { Db } from "@baerly/server";
import { createRouter } from "@baerly/server/http";
import { loadMaterialisedView } from "../../packages/cli/src/export/index.ts";
import { legacyIndexMarkerKeys, seedLegacyIndexMarkers } from "../fixtures/legacy-index-markers.ts";
import { logStateCurrentJson, seedLogEntry } from "../fixtures/log-state.ts";

test("copying a legacy row to a fresh NFC id keeps it queryable after deleting the original", async () => {
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
  // Seed bytes from the release that still allowed non-NFC writes, its
  // (now inert) index marker included.
  await seedLogEntry(storage, prefix, 0, { collection: "rows", doc_id: legacyId, after: body });
  await seedLegacyIndexMarkers(storage, legacyIndexMarkerKeys(prefix, indexes, body, legacyId));
  const rows = Db.create({
    storage,
    app: "app",
    tenant: "tenant",
    config: { collections: { rows: { indexes } } },
  }).collection("rows");
  const saved = (await rows.get(legacyId))!;
  // Omit the old id so the copy gets a fresh SDK-minted one.
  const { _id: oldId, ...copy } = saved;
  const { _id: migratedId } = await rows.insert(copy);
  expect(oldId).toBe(legacyId);
  await expect(rows.delete(legacyId)).resolves.toEqual({ deleted: 1 });

  const migrated = { ...body, _id: migratedId };
  await expect(rows.get(legacyId)).resolves.toBeUndefined();
  await expect(rows.get(migratedId)).resolves.toEqual(migrated);
  await expect(rows.where({ kind: "same" }).all()).resolves.toEqual([migrated]);
});

test("a legacy non-NFC row stays readable, dumpable and deletable; update and replace refuse it", async () => {
  const storage = new MemoryStorage({ ephemeral: true });
  const prefix = "app/app/tenant/tenant/manifests/rows";
  const legacyId = "legacy-ñ";
  const body = { _id: legacyId, kind: "same" };
  await createCurrentJson(storage, `${prefix}/current.json`, logStateCurrentJson());
  await seedLogEntry(storage, prefix, 0, { collection: "rows", doc_id: legacyId, after: body });
  const db = Db.create({ storage, app: "app", tenant: "tenant" });
  const rows = db.collection("rows");

  // Point reads use the stored-id rule, not the NFC write rule.
  await expect(rows.get(legacyId)).resolves.toEqual(body);
  const response = await createRouter({ db }).request(`/v1/c/rows/${encodeURIComponent(legacyId)}`);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ data: body });
  // `baerly admin dump` reads the same materialised view.
  const view = await loadMaterialisedView({
    storage,
    currentJsonKey: `${prefix}/current.json`,
    collection: "rows",
  });
  expect(view?.get(legacyId)).toEqual(body);

  await expect(rows.update(legacyId, { kind: "other" })).rejects.toMatchObject({
    code: "InvalidConfig",
  });
  await expect(rows.replace(legacyId, { _id: legacyId, kind: "other" })).rejects.toMatchObject({
    code: "InvalidConfig",
  });
  await expect(rows.delete(legacyId)).resolves.toEqual({ deleted: 1 });
  await expect(rows.get(legacyId)).resolves.toBeUndefined();
});
