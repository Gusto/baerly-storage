/** The tree GC state codec (`./gc-state.ts`). */
import { describe, expect, test } from "vitest";
import { encodeJsonBytes } from "@baerly/protocol";
import { TREE_GC_MAX_SWEEP_MARKS, TREE_GC_MAX_WORK_ENTRIES } from "./constants.ts";
import {
  decodeTreeGcState,
  emptyTreeGcState,
  encodeTreeGcState,
  type TreeGcState,
} from "./gc-state.ts";

const KEY = "app/a/tenant/t/manifests/c/_v99/gc-pending.json";
const REF = `${"0".repeat(31)}1/${"f".repeat(64)}`;
const AT = "2026-01-05T00:15:00.000Z";

const FULL: TreeGcState = {
  generation: "0a",
  floor_seen: 23,
  ticks: 7,
  clock: "2026-01-05T00:00:00.000Z",
  probed_local_at: "2026-01-05T00:00:01.000Z",
  resolved_through: 20,
  stuck: { floor: 21, since: null },
  work: [
    { floor: 0, winner: REF, quarantined: false, due_at: AT, next: 3, loser: null },
    {
      floor: 20,
      winner: REF,
      quarantined: true,
      due_at: null,
      next: 0,
      loser: { record: REF, next: 2 },
    },
  ],
  sweep: {
    cursor: "app/a/tenant/t/manifests/c/_v99/n/x",
    marks: [{ key: REF, floor: 20, due_at: AT }],
  },
};

describe("tree GC state", () => {
  test("a state round-trips through its canonical body", () => {
    for (const state of [FULL, emptyTreeGcState(null, 0)]) {
      expect(decodeTreeGcState(KEY, encodeTreeGcState(state))).toEqual({ kind: "state", state });
    }
  });

  test.each<[string, (state: TreeGcState) => unknown]>([
    ["a non-instant clock", (s) => ({ ...s, clock: "yesterday" })],
    ["a fractional floor", (s) => ({ ...s, floor_seen: 1.5 })],
    ["a malformed winner", (s) => ({ ...s, work: [{ ...s.work[0]!, winner: "x" }] })],
    ["work out of floor order", (s) => ({ ...s, work: s.work.toReversed() })],
    [
      "a repeated mark",
      (s) => ({ ...s, sweep: { ...s.sweep, marks: [s.sweep.marks[0]!, s.sweep.marks[0]!] } }),
    ],
    [
      "too many work entries",
      (s) => ({
        ...s,
        work: Array.from({ length: TREE_GC_MAX_WORK_ENTRIES + 1 }, (_, i) => ({
          ...s.work[0]!,
          floor: i,
        })),
      }),
    ],
    [
      "too many marks",
      (s) => ({
        ...s,
        sweep: {
          ...s.sweep,
          marks: Array.from({ length: TREE_GC_MAX_SWEEP_MARKS + 1 }, (_, i) => ({
            key: `${String(i).padStart(32, "0")}/${"f".repeat(64)}`,
            floor: 0,
            due_at: null,
          })),
        },
      }),
    ],
  ])("%s is refused by the encoder and malformed to the decoder", (_name, edit) => {
    const state = edit(FULL) as TreeGcState;
    expect(() => encodeTreeGcState(state)).toThrow(expect.objectContaining({ code: "Internal" }));
    const body = encodeJsonBytes({
      format: "baerly-tree-gc-state-proto",
      schema_version: 1,
      ...state,
    });
    expect(decodeTreeGcState(KEY, body).kind).toBe("malformed");
  });

  test("a non-canonical body, another format or a non-number schema is malformed", () => {
    const text = new TextDecoder().decode(encodeTreeGcState(FULL));
    for (const body of [
      text.replace(",", ", "),
      text.replace('"ticks":7', '"ticks":7,"extra":1'),
      text.replace("gc-state-proto", "gc-state-other"),
      text.replace('"schema_version":1', '"schema_version":"1"'),
      "[]",
      "{",
    ]) {
      expect(decodeTreeGcState(KEY, new TextEncoder().encode(body)).kind).toBe("malformed");
    }
  });

  test("a state of another schema version is InvalidResponse that says GC is paused", () => {
    const body = new TextDecoder()
      .decode(encodeTreeGcState(FULL))
      .replace('"schema_version":1', '"schema_version":2');
    expect(() => decodeTreeGcState(KEY, new TextEncoder().encode(body))).toThrow(
      expect.objectContaining({
        code: "InvalidResponse",
        message: expect.stringContaining("paused"),
      }),
    );
  });
});
