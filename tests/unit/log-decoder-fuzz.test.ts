/**
 * Mutation fuzzing of the log decoders over the frozen fold-stage0 log
 * corpus (`tests/fixtures/fold-stage0/pre-change/log/`, read-only).
 *
 * Decoders under test:
 * - `readLogEntry` / `walkLogRange` (`packages/server/src/log-walk.ts`):
 *   stored body bytes → `LogEntry`.
 * - `probeTailChunk` (`packages/server/src/log-tail.ts`), strict and
 *   tolerant: the same decode on the forward-probe path.
 * - `lsnParts` (`packages/protocol/src/log.ts`): `lsn` → `{ session, seq }`.
 *
 * The body decoders are deliberately shape-lenient (the freeze suite pins
 * that all nine stored bodies, malformed `lsn` included, decode). So the
 * oracle is faithfulness: valid JSON decodes to exactly `JSON.parse` of the
 * stored text, and anything else surfaces as `BaerlyError` code
 * `InvalidResponse` — never a raw `SyntaxError` / `TypeError` /
 * `RangeError`, and never a partial value.
 */
import {
  BaerlyError,
  COUNT_BIT_WIDTH,
  countKey,
  logObjectKey,
  lsnParts,
  MemoryStorage,
} from "@baerly/protocol";
import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";
import { probeTailChunk } from "../../packages/server/src/log-tail.ts";
import { readLogEntry, walkLogRange } from "../../packages/server/src/log-walk.ts";
import {
  frozenFixturesByContract,
  loadStage0CompatibilityManifest,
  readFrozenFixtureBytes,
} from "../fixtures/fold-stage0/frozen-corpus.ts";

const PREFIX = "fuzz/tickets";
const KEY = logObjectKey(PREFIX, 0);

const manifest = await loadStage0CompatibilityManifest();
const CORPUS: ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }> =
  await Promise.all(
    frozenFixturesByContract(manifest, "log").map(async ({ path }) => ({
      path,
      bytes: await readFrozenFixtureBytes(path),
    })),
  );
const CORPUS_LSNS: readonly string[] = CORPUS.map(
  ({ bytes }) => (JSON.parse(new TextDecoder().decode(bytes)) as { lsn: string }).lsn,
);

const utf8 = (s: string): number[] => [...new TextEncoder().encode(s)];

/**
 * Byte sequences that steer a mutation toward JSON-significant or
 * decoder-hostile input: structural tokens, escapes, lone surrogates,
 * overflowing numbers, `__proto__`, invalid UTF-8, a BOM.
 */
const HOSTILE_TOKENS: readonly (readonly number[])[] = [
  ...['"', "\\", "{", "}", "[", "]", ",", ":", " ", "\n"].map(utf8),
  ...["null", "true", "1e999", "-0", "\\u", "\\ud800", "\\u0000", '"__proto__"'].map(utf8),
  [0xff],
  [0xc0, 0x80],
  [0xed, 0xa0, 0x80],
  [0xef, 0xbb, 0xbf],
  [0x00],
];

type ByteMutation =
  | { readonly kind: "flip"; readonly at: number; readonly bit: number }
  | { readonly kind: "set"; readonly at: number; readonly byte: number }
  | { readonly kind: "insert"; readonly at: number; readonly bytes: readonly number[] }
  | { readonly kind: "delete"; readonly at: number; readonly len: number }
  | { readonly kind: "truncate"; readonly at: number }
  | { readonly kind: "duplicate"; readonly at: number; readonly len: number };

const byteMutation: fc.Arbitrary<ByteMutation> = fc.oneof(
  fc.record({
    kind: fc.constant("flip" as const),
    at: fc.nat(),
    bit: fc.integer({ min: 0, max: 7 }),
  }),
  fc.record({
    kind: fc.constant("set" as const),
    at: fc.nat(),
    byte: fc.integer({ min: 0, max: 255 }),
  }),
  fc.record({
    kind: fc.constant("insert" as const),
    at: fc.nat(),
    bytes: fc.oneof(
      fc.constantFrom(...HOSTILE_TOKENS),
      fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 4 }),
    ),
  }),
  fc.record({
    kind: fc.constant("delete" as const),
    at: fc.nat(),
    len: fc.integer({ min: 1, max: 16 }),
  }),
  fc.record({ kind: fc.constant("truncate" as const), at: fc.nat() }),
  fc.record({
    kind: fc.constant("duplicate" as const),
    at: fc.nat(),
    len: fc.integer({ min: 1, max: 16 }),
  }),
);

const applyByteMutation = (input: readonly number[], m: ByteMutation): number[] => {
  const out = [...input];
  const at = m.at % (out.length + 1);
  switch (m.kind) {
    case "flip": {
      if (at < out.length) {
        out[at] = out[at]! ^ (1 << m.bit);
      }
      return out;
    }
    case "set": {
      if (at < out.length) {
        out[at] = m.byte;
      }
      return out;
    }
    case "insert": {
      out.splice(at, 0, ...m.bytes);
      return out;
    }
    case "delete": {
      out.splice(at, m.len);
      return out;
    }
    case "truncate": {
      return out.slice(0, at);
    }
    case "duplicate": {
      out.splice(at, 0, ...out.slice(at, at + m.len));
      return out;
    }
  }
};

/** A frozen fixture plus 1–6 stacked byte mutations. */
const mutatedLogBody = fc
  .record({
    fixture: fc.constantFrom(...CORPUS),
    mutations: fc.array(byteMutation, { minLength: 1, maxLength: 6 }),
  })
  .map(({ fixture, mutations }) => ({
    fixture: fixture.path,
    bytes: Uint8Array.from(mutations.reduce(applyByteMutation, [...fixture.bytes])),
  }));

/** What a faithful decoder must produce for `bytes`. */
const oracle = (bytes: Uint8Array): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false };
  }
};

const settle = async <T>(
  p: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

const expectInvalidResponse = (error: unknown): void => {
  expect(error).toBeInstanceOf(BaerlyError);
  expect((error as BaerlyError).code).toBe("InvalidResponse");
};

const storageWith = async (bytes: Uint8Array): Promise<MemoryStorage> => {
  const storage = new MemoryStorage();
  await storage.put(KEY, bytes, { contentType: "application/json" });
  return storage;
};

describe("log decoder mutation fuzz: seed corpus", () => {
  test("seeds from all nine frozen log bodies, each of which decodes unmutated", async () => {
    expect(CORPUS).toHaveLength(9);
    for (const { bytes } of CORPUS) {
      const storage = await storageWith(bytes);
      await expect(readLogEntry(storage, KEY)).resolves.toEqual(
        JSON.parse(new TextDecoder().decode(bytes)),
      );
    }
  });
});

describe("log decoder mutation fuzz: stored body → LogEntry", () => {
  fcTest.prop({ body: mutatedLogBody })(
    "readLogEntry decodes faithfully or throws InvalidResponse",
    async ({ body }) => {
      const expected = oracle(body.bytes);
      const outcome = await settle(readLogEntry(await storageWith(body.bytes), KEY));
      if (expected.ok) {
        expect(outcome.ok).toBe(true);
        expect(outcome.ok && outcome.value).toEqual(expected.value);
      } else {
        expect(outcome.ok).toBe(false);
        expectInvalidResponse(!outcome.ok && outcome.error);
      }
    },
  );

  fcTest.prop({ body: mutatedLogBody, healthyBefore: fc.integer({ min: 0, max: 3 }) })(
    "walkLogRange decodes faithfully or throws InvalidResponse, whatever the slot",
    async ({ body, healthyBefore }) => {
      const storage = new MemoryStorage();
      for (let seq = 0; seq < healthyBefore; seq++) {
        await storage.put(logObjectKey(PREFIX, seq), CORPUS[seq]!.bytes, {
          contentType: "application/json",
        });
      }
      await storage.put(logObjectKey(PREFIX, healthyBefore), body.bytes, {
        contentType: "application/json",
      });
      const expected = oracle(body.bytes);
      const outcome = await settle(walkLogRange(storage, PREFIX, 0, healthyBefore + 1));
      if (expected.ok) {
        expect(outcome.ok).toBe(true);
        expect(outcome.ok && outcome.value[healthyBefore]).toEqual(expected.value);
      } else {
        expect(outcome.ok).toBe(false);
        expectInvalidResponse(!outcome.ok && outcome.error);
      }
    },
  );

  fcTest.prop({ body: mutatedLogBody })(
    "strict probeTailChunk counts the slot occupied and decodes it, or throws InvalidResponse",
    async ({ body }) => {
      const expected = oracle(body.bytes);
      const outcome = await settle(probeTailChunk(await storageWith(body.bytes), PREFIX, 0));
      if (expected.ok) {
        expect(outcome.ok && outcome.value).toEqual({
          kind: "exact",
          tail: 1,
          entries: [expected.value],
          complete: true,
        });
      } else {
        expect(outcome.ok).toBe(false);
        expectInvalidResponse(!outcome.ok && outcome.error);
      }
    },
  );

  fcTest.prop({ body: mutatedLogBody })(
    "tolerant probeTailChunk never throws and marks an undecodable slot incomplete",
    async ({ body }) => {
      const expected = oracle(body.bytes);
      const chunk = await probeTailChunk(await storageWith(body.bytes), PREFIX, 0, {
        tolerateMalformed: true,
      });
      expect(chunk).toEqual({
        kind: "exact",
        tail: 1,
        entries: expected.ok ? [expected.value] : [],
        complete: expected.ok,
      });
    },
  );
});

type CharMutation =
  | { readonly kind: "replace"; readonly at: number; readonly with: string }
  | { readonly kind: "insert"; readonly at: number; readonly text: string }
  | { readonly kind: "delete"; readonly at: number; readonly len: number };

const lsnChar = fc.oneof(
  fc.constantFrom(..."0123456789abcdefghijklmnopqrstuv_"),
  fc.constantFrom("w", "z", "A", "V", "-", ".", "+", " ", "\u0000", "\ud800", "\u{1f600}", "é"),
);

const charMutation: fc.Arbitrary<CharMutation> = fc.oneof(
  fc.record({ kind: fc.constant("replace" as const), at: fc.nat(), with: lsnChar }),
  fc.record({
    kind: fc.constant("insert" as const),
    at: fc.nat(),
    text: fc.array(lsnChar, { minLength: 1, maxLength: 3 }).map((cs) => cs.join("")),
  }),
  fc.record({
    kind: fc.constant("delete" as const),
    at: fc.nat(),
    len: fc.integer({ min: 1, max: 12 }),
  }),
);

const applyCharMutation = (input: string, m: CharMutation): string => {
  const at = m.at % (input.length + 1);
  switch (m.kind) {
    case "replace": {
      return input.slice(0, at) + m.with + input.slice(at + 1);
    }
    case "insert": {
      return input.slice(0, at) + m.text + input.slice(at);
    }
    case "delete": {
      return input.slice(0, at) + input.slice(at + m.len);
    }
  }
};

const mutatedLsn = fc
  .record({
    lsn: fc.constantFrom(...CORPUS_LSNS),
    mutations: fc.array(charMutation, { minLength: 0, maxLength: 4 }),
  })
  .map(({ lsn, mutations }) => mutations.reduce(applyCharMutation, lsn));

const SEQ_CHARS = Math.ceil(COUNT_BIT_WIDTH / 5);
const SEQ_SEGMENT_RE = new RegExp(`^[0-9a-v]{${SEQ_CHARS}}$`);
const MAX_SEQ = 2 ** COUNT_BIT_WIDTH - 1;

describe("log decoder mutation fuzz: lsnParts", () => {
  fcTest.prop({ lsn: mutatedLsn })(
    "lsnParts throws InvalidResponse on a bad segment count and otherwise returns the session segment",
    ({ lsn }) => {
      const parts = lsn.split("_");
      let result: ReturnType<typeof lsnParts>;
      try {
        result = lsnParts(lsn);
      } catch (error) {
        expectInvalidResponse(error);
        expect(parts).not.toHaveLength(3);
        return;
      }
      expect(parts).toHaveLength(3);
      expect(result.session).toBe(parts[1]);
    },
  );

  // `lsnParts` checks only the segment count. The seq round-trip is
  // asserted over the seq-segment shape the `/v1/since` gate (`LSN_RE`)
  // admits, restricted to values a `COUNT_BIT_WIDTH`-bit seq can hold.
  fcTest.prop({ lsn: mutatedLsn })(
    "lsnParts round-trips any in-range 11-digit base-32 seq segment",
    ({ lsn }) => {
      const parts = lsn.split("_");
      fc.pre(parts.length === 3 && SEQ_SEGMENT_RE.test(parts[2]!));
      fc.pre(Number.parseInt(parts[2]!, 32) <= MAX_SEQ);
      const { seq } = lsnParts(lsn);
      expect(Number.isSafeInteger(seq)).toBe(true);
      expect(seq).toBeGreaterThanOrEqual(0);
      expect(countKey(seq)).toBe(parts[2]);
    },
  );
});
