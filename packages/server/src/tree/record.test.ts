/**
 * Fold-record encoding (`./record.ts`). What a published fold's record
 * names is checked against the physical oracle in `./publish.test.ts`;
 * this file covers the encoder's own rules.
 */
import { describe, expect, test } from "vitest";
import { sha256Hex } from "@baerly/protocol";
import { TREE_GC_RECORD_MAX_KEYS } from "./constants.ts";
import { parseTreeRecordKey } from "./key.ts";
import { type FoldRecord, sealFoldRecord } from "./record.ts";

const P = "app/helpdesk/tenant/acme/manifests/tickets";
const A1 = "00112233445566778899aabbccddeeff";
const A2 = "ffeeddccbbaa99887766554433221100";
const sha = (n: number): string => n.toString(16).padStart(64, "0");

const RECORD: FoldRecord = {
  attempt: A1,
  base: { floor: 7, root: `${A2}/${sha(9)}`, attempt: A2, generation: "0a1b" },
  result: { floor: 9, root: sha(2) },
  fresh: [sha(1), sha(2)],
  superseded: [`${A2}/${sha(8)}`, `${A2}/${sha(9)}`],
};

describe("sealFoldRecord", () => {
  test("encodes the fields in order and keys the record by its floor, attempt and body hash", async () => {
    const sealed = await sealFoldRecord(P, RECORD);
    const text = new TextDecoder().decode(sealed.bytes);
    expect(text).toBe(
      JSON.stringify({
        format: "baerly-tree-fold-record-proto",
        schema_version: 1,
        attempt: A1,
        base: RECORD.base,
        result: RECORD.result,
        fresh: RECORD.fresh,
        superseded: RECORD.superseded,
      }),
    );
    expect(sealed.sha256).toBe(await sha256Hex(sealed.bytes));
    expect(parseTreeRecordKey(P, sealed.key)).toEqual({
      floor: 7,
      attempt: A1,
      sha256: sealed.sha256,
    });
  });

  test("an empty result with nothing fresh, and a fresh head's base, encode", async () => {
    const sealed = await sealFoldRecord(P, {
      ...RECORD,
      base: { floor: 0, root: null, attempt: null, generation: null },
      result: { floor: 1, root: null },
      fresh: [],
      superseded: [],
    });
    expect(parseTreeRecordKey(P, sealed.key)?.floor).toBe(0);
  });

  const many = (n: number): string[] => Array.from({ length: n }, (_, i) => sha(i));

  test.each<[string, Partial<FoldRecord>]>([
    ["a malformed attempt", { attempt: A1.toUpperCase() }],
    ["a malformed installer", { base: { ...RECORD.base, attempt: "x" } }],
    [
      "a base root that is a node key",
      { base: { ...RECORD.base, root: `${P}/_v99/n/${A2}/${sha(9)}` } },
    ],
    ["a fractional base floor", { base: { ...RECORD.base, floor: 1.5 } }],
    ["a fold end at the base floor", { result: { floor: 7, root: sha(2) } }],
    ["a new root that is not fresh", { result: { floor: 9, root: sha(3) } }],
    ["unsorted fresh", { fresh: [sha(2), sha(1)] }],
    ["repeated fresh", { fresh: [sha(2), sha(2)] }],
    ["unsorted superseded", { superseded: [`${A2}/${sha(9)}`, `${A2}/${sha(8)}`] }],
    ["a superseded node of the record's own attempt", { superseded: [`${A1}/${sha(8)}`] }],
    [
      "more keys than the cap",
      {
        result: { floor: 9, root: null },
        fresh: many(TREE_GC_RECORD_MAX_KEYS - 1),
        superseded: [`${A2}/${sha(8)}`, `${A2}/${sha(9)}`],
      },
    ],
  ])("%s is Internal", async (_name, change) => {
    await expect(sealFoldRecord(P, { ...RECORD, ...change })).rejects.toMatchObject({
      code: "Internal",
    });
  });

  test("a record exactly at the key cap encodes", async () => {
    const sealed = await sealFoldRecord(P, {
      ...RECORD,
      result: { floor: 9, root: null },
      fresh: many(TREE_GC_RECORD_MAX_KEYS - 2),
    });
    expect(sealed.bytes.byteLength).toBeGreaterThan(TREE_GC_RECORD_MAX_KEYS * 60);
  });
});
