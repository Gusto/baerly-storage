/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key field. */
/**
 * R2 stores canonically-equivalent keys as one object, so an NFC
 * collection name addresses the objects a legacy non-NFC (NFD) name
 * wrote. Every path that reads those objects under the NFC name must
 * refuse loudly rather than skip the legacy entries: a skipped entry
 * reads as an empty collection, a fold that skips it lets log
 * retirement delete it, and a snapshot that carries the other spelling
 * must not surface as a corrupt-object `InvalidResponse`.
 */
import { describe, expect, test } from "vitest";
import { createCurrentJson, MemoryStorage, readCurrentJson, type Storage } from "@baerly/protocol";
import { Db } from "@baerly/server";
import { listEventsSince } from "@baerly/server/http";
import { compact, runScheduledMaintenance } from "@baerly/server/maintenance";
import { loadMaterialisedView } from "../../packages/cli/src/export/index.ts";
import { logStateCurrentJson, seedLogEntry } from "../fixtures/log-state.ts";

const NFC = "café";
const NFD = "café";
const prefixFor = (collection: string): string => `app/app/tenant/tenant/manifests/${collection}`;

/** Model R2's canonical-equivalent object keys without credentials. */
const r2Model = (): { storage: Storage; base: MemoryStorage } => {
  const base = new MemoryStorage({ ephemeral: true });
  const storage: Storage = {
    get: (key, opts) => base.get(key.normalize("NFC"), opts),
    put: (key, body, opts) => base.put(key.normalize("NFC"), body, opts),
    delete: (key, opts) => base.delete(key.normalize("NFC"), opts),
    list: (prefix, opts) => base.list(prefix.normalize("NFC"), opts),
  };
  return { storage, base };
};

const ROWS = [
  { _id: "a", kind: "x" },
  { _id: "b", kind: "y" },
];

/** A legacy NFD collection whose rows live only in its unfolded log. */
const seedLegacyLog = async (storage: Storage, tailHint: number = ROWS.length): Promise<void> => {
  await createCurrentJson(
    storage,
    `${prefixFor(NFD)}/current.json`,
    logStateCurrentJson({ tail_hint: tailHint }),
  );
  for (const [seq, row] of ROWS.entries()) {
    await seedLogEntry(storage, prefixFor(NFD), seq, {
      collection: NFD,
      doc_id: row._id,
      after: row,
    });
  }
};

const logKeys = async (base: MemoryStorage): Promise<string[]> => {
  const keys: string[] = [];
  for await (const e of base.list(`${prefixFor(NFC)}/log/`)) {
    keys.push(e.key);
  }
  return keys;
};

const ALIASED = { code: "InvalidConfig" };

describe("an NFC name that aliases a legacy NFD collection on R2", () => {
  test("reads and writes refuse instead of seeing an empty collection", async () => {
    const { storage, base } = r2Model();
    await seedLegacyLog(storage);
    const rows = Db.create({ storage, app: "app", tenant: "tenant" }).collection(NFC);
    await expect(rows.where({}).all()).rejects.toMatchObject(ALIASED);
    await expect(rows.get("a")).rejects.toMatchObject(ALIASED);
    await expect(rows.insert({ _id: "c", kind: "z" })).rejects.toMatchObject(ALIASED);
    await expect(rows.update("a", { kind: "q" })).rejects.toMatchObject(ALIASED);
    await expect(logKeys(base)).resolves.toHaveLength(ROWS.length);
  });

  test("the /v1/since change feed refuses instead of serving legacy entries", async () => {
    const { storage } = r2Model();
    await seedLegacyLog(storage);
    const db = Db.create({ storage, app: "app", tenant: "tenant" });
    await expect(listEventsSince({ db, collection: NFC, cursor: "" })).rejects.toMatchObject(
      ALIASED,
    );
    const head = await readCurrentJson(storage, `${prefixFor(NFC)}/current.json`);
    await expect(db.getLogEntry(NFC, 0, head!.json)).rejects.toMatchObject(ALIASED);
  });

  test("the /v1/since forward probe refuses legacy entries past tail_hint", async () => {
    const { storage } = r2Model();
    await seedLegacyLog(storage, 0);
    const db = Db.create({ storage, app: "app", tenant: "tenant" });
    await expect(listEventsSince({ db, collection: NFC, cursor: "" })).rejects.toMatchObject(
      ALIASED,
    );
  });

  test("compact and scheduled maintenance refuse and delete nothing", async () => {
    const { storage, base } = r2Model();
    await seedLegacyLog(storage);
    const currentJsonKey = `${prefixFor(NFC)}/current.json`;
    await expect(
      compact({ storage, currentJsonKey }, { minEntriesToCompact: 1 }),
    ).rejects.toMatchObject(ALIASED);
    await expect(runScheduledMaintenance({ storage, currentJsonKey })).rejects.toMatchObject(
      ALIASED,
    );
    await expect(logKeys(base)).resolves.toHaveLength(ROWS.length);
    const head = await readCurrentJson(storage, currentJsonKey);
    expect(head?.json.snapshot).toBeNull();
    expect(head?.json.log_seq_start).toBe(0);
  });

  test("a legacy snapshot is refused as an alias, not as a corrupt object", async () => {
    const { storage } = r2Model();
    await seedLegacyLog(storage);
    // Fold under the legacy spelling, as the release that wrote it did.
    await compact(
      { storage, currentJsonKey: `${prefixFor(NFD)}/current.json` },
      { minEntriesToCompact: 1 },
    );
    const legacyHead = await readCurrentJson(storage, `${prefixFor(NFD)}/current.json`);
    expect(legacyHead?.json.snapshot).not.toBeNull();
    const rows = Db.create({ storage, app: "app", tenant: "tenant" }).collection(NFC);
    await expect(rows.where({}).all()).rejects.toMatchObject(ALIASED);
    // A later legacy tail entry over the snapshot: the fold refuses too.
    await seedLogEntry(storage, prefixFor(NFD), 2, {
      collection: NFD,
      doc_id: "c",
      after: { _id: "c", kind: "z" },
    });
    await expect(
      compact(
        { storage, currentJsonKey: `${prefixFor(NFC)}/current.json` },
        { minEntriesToCompact: 1 },
      ),
    ).rejects.toMatchObject(ALIASED);
  });

  test("export under the NFC name refuses; under the legacy spelling it reads every row", async () => {
    const { storage } = r2Model();
    await seedLegacyLog(storage);
    await expect(
      loadMaterialisedView({
        storage,
        currentJsonKey: `${prefixFor(NFC)}/current.json`,
        collection: NFC,
      }),
    ).rejects.toMatchObject(ALIASED);
    const view = await loadMaterialisedView({
      storage,
      currentJsonKey: `${prefixFor(NFD)}/current.json`,
      collection: NFD,
    });
    expect([...(view?.values() ?? [])]).toEqual(ROWS);
  });
});
