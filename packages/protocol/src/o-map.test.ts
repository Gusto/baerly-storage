import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { OMap } from "./o-map";

const idKey = (k: string) => k;

describe("OMap invariants", () => {
  test.prop({
    entries: fc.array(fc.tuple(fc.string(), fc.anything())),
  })("set/get round-trip on the latest write per key", ({ entries }) => {
    const m = new OMap<string, unknown>(idKey, entries);
    const latest = new Map<string, unknown>();
    for (const [k, v] of entries) latest.set(k, v);
    for (const [k, v] of latest) {
      expect(m.has(k)).toBe(true);
      expect(m.get(k)).toEqual(v);
    }
    expect(m.size).toBe(latest.size);
  });

  test.prop({
    entries: fc.array(fc.tuple(fc.string(), fc.anything())),
  })("delete clears has() and decrements size", ({ entries }) => {
    const m = new OMap<string, unknown>(idKey, entries);
    const uniqueKeys = [...new Set(entries.map(([k]) => k))];
    for (const k of uniqueKeys) {
      const sizeBefore = m.size;
      expect(m.delete(k)).toBe(true);
      expect(m.has(k)).toBe(false);
      expect(m.size).toBe(sizeBefore - 1);
    }
    expect(m.size).toBe(0);
  });

  test.prop({
    entries: fc.array(fc.tuple(fc.string(), fc.anything())),
  })("keys() yields insertion order of unique keys", ({ entries }) => {
    const m = new OMap<string, unknown>(idKey, entries);
    const expected: string[] = [];
    const seen = new Set<string>();
    for (const [k] of entries) {
      if (!seen.has(k)) {
        seen.add(k);
        expected.push(k);
      }
    }
    expect([...m.keys()]).toEqual(expected);
  });
});

type Cmd = fc.Command<Map<string, number>, OMap<string, number>>;

const setCmd = (k: string, v: number): Cmd => ({
  check: () => true,
  run: (model, real) => {
    model.set(k, v);
    real.set(k, v);
    expect(real.get(k)).toBe(v);
    expect(real.has(k)).toBe(true);
    expect(real.size).toBe(model.size);
  },
  toString: () => `set(${JSON.stringify(k)}, ${v})`,
});

const deleteCmd = (k: string): Cmd => ({
  check: () => true,
  run: (model, real) => {
    const expected = model.delete(k);
    expect(real.delete(k)).toBe(expected);
    expect(real.has(k)).toBe(false);
    expect(real.size).toBe(model.size);
  },
  toString: () => `delete(${JSON.stringify(k)})`,
});

const cmdArbs: fc.Arbitrary<Cmd>[] = [
  fc.tuple(fc.string(), fc.integer()).map(([k, v]) => setCmd(k, v)),
  fc.string().map((k) => deleteCmd(k)),
];

test.prop({ cmds: fc.commands(cmdArbs, { size: "+1" }) })(
  "OMap matches Map<string,V> reference under arbitrary command sequences",
  ({ cmds }) => {
    fc.modelRun(
      () => ({
        model: new Map<string, number>(),
        real: new OMap<string, number>(idKey),
      }),
      cmds,
    );
  },
  60000,
);
