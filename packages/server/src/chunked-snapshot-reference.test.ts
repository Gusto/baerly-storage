import { fc, test as fcTest } from "@fast-check/vitest";
import { BaerlyError, type DocumentData, type DocumentValue } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import {
  foldChunkedSnapshotReference,
  type ReferenceMutation,
  type ReferenceRow,
} from "./chunked-snapshot-reference.ts";
import { compareDocIds } from "./snapshot-doc-id.ts";

const row = (id: string, version: number): ReferenceRow => ({
  _id: id,
  body: {
    _id: id,
    version,
    nested: { active: version % 2 === 0 },
    labels: [`v${version}`],
  },
});

const mutation = (
  op: "I" | "U",
  id: string,
  version: number,
): Extract<ReferenceMutation, { readonly op: "I" | "U" }> => ({
  op,
  doc_id: id,
  after: row(id, version).body,
});

const expectInvalidResponse = (action: () => unknown): void => {
  expect(action).toThrow(BaerlyError);
  try {
    action();
  } catch (error) {
    expect((error as BaerlyError).code).toBe("InvalidResponse");
  }
};

const slowFold = (
  rows: readonly ReferenceRow[],
  indexedMutations: readonly { readonly seq: number; readonly mutation: ReferenceMutation }[],
  floor: number,
  endExclusive: number,
): readonly ReferenceRow[] => {
  const ids = rows.map(({ _id }) => _id);
  const bodies = rows.map(({ body }) => body);
  for (const { seq, mutation: entry } of indexedMutations) {
    if (seq < floor || seq >= endExclusive) {
      continue;
    }
    const index = ids.indexOf(entry.doc_id);
    if (entry.op === "D") {
      if (index !== -1) {
        ids.splice(index, 1);
        bodies.splice(index, 1);
      }
    } else if (index === -1) {
      ids.push(entry.doc_id);
      bodies.push(entry.after);
    } else {
      bodies[index] = entry.after;
    }
  }
  return ids
    .map((_id, index) => ({ _id, body: bodies[index]! }))
    .toSorted((left, right) => compareDocIds(left._id, right._id));
};

describe("chunked snapshot reference fold", () => {
  test("applies insert, full-post-image update, and delete", () => {
    const result = foldChunkedSnapshotReference(
      [row("b", 0), row("c", 0)],
      [mutation("I", "a", 1), mutation("U", "b", 2), { op: "D", doc_id: "c" }],
    );

    expect(result).toEqual([row("a", 1), row("b", 2)]);
  });

  test("uses last-write-wins semantics for repeated document mutations", () => {
    expect(
      foldChunkedSnapshotReference(
        [row("a", 0)],
        [
          mutation("U", "a", 1),
          { op: "D", doc_id: "a" },
          mutation("I", "a", 3),
          mutation("U", "a", 4),
        ],
      ),
    ).toEqual([row("a", 4)]);
  });

  test("sorts by scalar document order and freezes the emitted collection", () => {
    const result = foldChunkedSnapshotReference(
      [row("\u{10000}", 0), row("e\u0301", 0), row("é", 0)],
      [],
    );

    expect(result.map(({ _id }) => _id)).toEqual(["e\u0301", "é", "\u{10000}"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.every(Object.isFrozen)).toBe(true);
  });

  test("detaches the result from initial-row bodies without freezing caller input", () => {
    const input = row("a", 0);
    const result = foldChunkedSnapshotReference([input], []);

    input.body["version"] = 99;
    (input.body["nested"] as DocumentData)["active"] = false;

    expect(Object.isFrozen(input.body)).toBe(false);
    expect(result).toEqual([row("a", 0)]);
  });

  test("detaches the result from mutation post-images without freezing caller input", () => {
    const input = mutation("I", "a", 1);
    const result = foldChunkedSnapshotReference([], [input]);

    input.after["version"] = 99;
    (input.after["labels"] as DocumentValue[]).push("caller mutation");

    expect(Object.isFrozen(input.after)).toBe(false);
    expect(result).toEqual([row("a", 1)]);
  });

  test("deeply freezes nested objects and arrays in emitted bodies", () => {
    const result = foldChunkedSnapshotReference([row("a", 0)], []);
    const body = result[0]!.body;
    const nested = body["nested"] as DocumentData;
    const labels = body["labels"] as DocumentValue[];

    expect(Object.isFrozen(body)).toBe(true);
    expect(Object.isFrozen(nested)).toBe(true);
    expect(Object.isFrozen(labels)).toBe(true);
    expect(() => {
      nested["active"] = false;
    }).toThrow(TypeError);
    expect(() => labels.push("output mutation")).toThrow(TypeError);
    expect(result).toEqual([row("a", 0)]);
  });

  test("rejects duplicate stored IDs but permits repeated mutations", () => {
    expectInvalidResponse(() => foldChunkedSnapshotReference([row("a", 0), row("a", 1)], []));
    expect(() =>
      foldChunkedSnapshotReference([], [mutation("I", "a", 1), mutation("U", "a", 2)]),
    ).not.toThrow();
  });

  test("requires every post-image identity to equal its mutation document ID", () => {
    expectInvalidResponse(() =>
      foldChunkedSnapshotReference([], [{ op: "I", doc_id: "a", after: { _id: "b", version: 1 } }]),
    );
  });

  test.each([
    ["non-object row", [null], []],
    ["invalid row ID", [{ _id: "\ud800", body: { _id: "\ud800" } }], []],
    ["row identity mismatch", [{ _id: "a", body: { _id: "b" } }], []],
    ["array row body", [{ _id: "a", body: [] }], []],
    ["null stored value", [{ _id: "a", body: { _id: "a", value: null } }], []],
    ["non-finite stored number", [{ _id: "a", body: { _id: "a", value: Infinity } }], []],
    ["non-object mutation", [], [null]],
    ["unknown mutation op", [], [{ op: "X", doc_id: "a" }]],
    ["invalid mutation ID", [], [{ op: "D", doc_id: "a/b" }]],
    ["missing post-image", [], [{ op: "I", doc_id: "a" }]],
    ["invalid post-image", [], [{ op: "U", doc_id: "a", after: { _id: "a", value: undefined } }]],
  ])("rejects %s as InvalidResponse", (_label, rows, mutations) => {
    expectInvalidResponse(() =>
      foldChunkedSnapshotReference(
        rows as unknown as readonly ReferenceRow[],
        mutations as unknown as readonly ReferenceMutation[],
      ),
    );
  });
});

const idArb = fc.oneof(
  fc.stringMatching(/^[a-z][a-z0-9]{0,5}$/),
  fc.constantFrom("é", "e\u0301", "\u{10000}", "\u{1f4a9}"),
);

fcTest.prop({
  ids: fc.uniqueArray(idArb, { minLength: 2, maxLength: 12 }),
  instructions: fc.array(
    fc.record({
      op: fc.constantFrom<"I" | "U" | "D">("I", "U", "D"),
      target: fc.nat(),
      version: fc.integer(),
    }),
    { minLength: 2, maxLength: 30 },
  ),
  floor: fc.integer({ min: 7, max: 1000 }),
  prefixSeed: fc.nat(),
})(
  "matches an independent slow model for nonzero floors and deterministic partial prefixes",
  ({ ids, instructions, floor, prefixSeed }) => {
    const initialCount = Math.max(1, Math.floor(ids.length / 2));
    const initial = ids.slice(0, initialCount).map((id, index) => row(id, index));
    const entries = instructions.map(({ op, target, version }, index) => {
      const id = ids[target % ids.length]!;
      const entry: ReferenceMutation = op === "D" ? { op, doc_id: id } : mutation(op, id, version);
      return { seq: floor + index, mutation: entry };
    });
    const prefixLength = 1 + (prefixSeed % (entries.length - 1));
    const endExclusive = floor + prefixLength;
    const prefix = entries
      .filter(({ seq }) => seq >= floor && seq < endExclusive)
      .map(({ mutation: entry }) => entry);

    expect(foldChunkedSnapshotReference(initial, prefix)).toEqual(
      slowFold(initial, entries, floor, endExclusive),
    );
  },
);
