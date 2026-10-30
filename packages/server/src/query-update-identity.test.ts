/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes; this suite is about it. */

/**
 * `Query.update` `_id` identity, as a property against a frozen reference
 * rule: a patch is accepted iff its top-level `_id` is absent, `undefined`,
 * or `===` the row's `_id`. Either way the row keeps its `_id`, and the
 * collection keeps exactly one row. Example-based cases live in
 * `query-mutations.test.ts`.
 */

import { fc, test as fcTest } from "@fast-check/vitest";
import {
  CURRENT_JSON_SCHEMA_VERSION,
  type Collection,
  createCurrentJson,
  type DocumentData,
  MemoryStorage,
} from "@baerly/protocol";
import { describe, expect } from "vitest";
import { validDocIdArb } from "../../../tests/fixtures/scalar-doc-id-arbitraries.ts";
import { Db } from "./db.ts";

const APP = "test";
const TENANT = "t";
const COLL = "rows";
const LOG_PREFIX = `app/${APP}/tenant/${TENANT}/manifests/${COLL}/log/`;

type PatchId =
  | { readonly kind: "absent" }
  | { readonly kind: "undefined" }
  | { readonly kind: "same" }
  | { readonly kind: "value"; readonly value: unknown };

const patchIdArb: fc.Arbitrary<PatchId> = fc.oneof(
  fc.constant({ kind: "absent" } as const),
  fc.constant({ kind: "undefined" } as const),
  fc.constant({ kind: "same" } as const),
  validDocIdArb.map((value) => ({ kind: "value", value }) as const),
  fc
    .oneof(
      fc.constant(null),
      fc.constant(""),
      fc.constant(-0),
      fc.constant(Number.NaN),
      fc.integer(),
      fc.boolean(),
      fc.constant({}),
      fc.constant([]),
    )
    .map((value) => ({ kind: "value", value }) as const),
);

/** Frozen reference: the identity rule as the owner ruling states it. */
const referenceAccepts = (rowId: string, patchId: PatchId): boolean =>
  patchId.kind !== "value" || patchId.value === rowId;

const buildPatch = (rowId: string, patchId: PatchId): DocumentData => {
  const patch: Record<string, unknown> = { touched: true };
  if (patchId.kind === "undefined") {
    patch["_id"] = undefined;
  } else if (patchId.kind === "same") {
    patch["_id"] = rowId;
  } else if (patchId.kind === "value") {
    patch["_id"] = patchId.value;
  }
  return patch as DocumentData;
};

const countLogEntries = async (storage: MemoryStorage): Promise<number> => {
  let n = 0;
  for await (const _ of storage.list(LOG_PREFIX)) {
    n++;
  }
  return n;
};

describe("Query.update — _id identity property", () => {
  fcTest.prop({ rowId: validDocIdArb, patchId: patchIdArb, byPredicate: fc.boolean() })(
    "accepts a patch iff its _id is absent, undefined, or the row's own; the row never re-keys",
    async ({ rowId, patchId, byPredicate }) => {
      const storage = new MemoryStorage();
      await createCurrentJson(
        storage,
        `app/${APP}/tenant/${TENANT}/manifests/${COLL}/current.json`,
        {
          schema_version: CURRENT_JSON_SCHEMA_VERSION,
          snapshot: null,
          tail_hint: 0,
          log_seq_start: 0,
          writer_fence: { epoch: 0, owner: "test", claimed_at: "" },
          snapshot_bytes: 0,
          snapshot_rows: 0,
        },
      );
      const db = Db.create({ storage, app: APP, tenant: TENANT });
      const t = db.collection(COLL) as Collection<DocumentData>;
      await t.insert({ _id: rowId, k: 1 });

      const patch = buildPatch(rowId, patchId);
      const run = byPredicate ? t.where({ k: 1 }).update(patch) : t.update(rowId, patch);
      if (referenceAccepts(rowId, patchId)) {
        await expect(run).resolves.toEqual({ modified: 1 });
        await expect(countLogEntries(storage)).resolves.toBe(2);
        await expect(t.where({}).all()).resolves.toEqual([{ _id: rowId, k: 1, touched: true }]);
      } else {
        await expect(run).rejects.toMatchObject({ code: "InvalidConfig" });
        await expect(countLogEntries(storage)).resolves.toBe(1);
        await expect(t.where({}).all()).resolves.toEqual([{ _id: rowId, k: 1 }]);
      }
    },
  );
});
