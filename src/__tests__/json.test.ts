import { expect, test, describe } from "bun:test";
import { JSONArrayless, diff, fold, merge } from "json";
import { uuid } from "types";

const doc = {
  boolean: true,
  number: 0,
  string: "",
  object: {
    nested: {},
  },
};

const rndDoc = (): JSONArrayless => {
  const choice = Math.floor(Math.random() * 4);
  if (choice === 0) {
    return Math.random() - 0.5;
  } else if (choice === 1) {
    return Math.random() > 0.5;
  } else if (choice === 2) {
    return uuid().substring(0, 8);
  } else {
    const fields = Math.floor(Math.random() * 3);
    return {
      ...(fields > 0 && { a: rndDoc() }),
      ...(fields > 1 && { b: rndDoc() }),
    };
  }
};

const rndStructuredDoc = (): JSONArrayless => {
  const doc: JSONArrayless = {};
  if (Math.random() > 0.5) {
    // add a scalar
    const key = "scalar-" + Math.floor(Math.random() * 2);
    const choice = Math.floor(Math.random() * 3);
    if (choice === 0) {
      doc[key] = Math.random() - 0.5;
    } else if (choice === 1) {
      doc[key] = Math.random() > 0.5;
    } else {
      doc[key] = uuid().substring(0, 8);
    }
  }
  if (Math.random() > 0.5) {
    // add a nested doc
    const key = "subdoc-" + Math.floor(Math.random() * 2);
    doc[key] = rndStructuredDoc();
  }
  return doc;
};

const testCase = (
  label: string,
  expr: (...args: any[]) => any,
  expected: (...args: any[]) => any
) =>
  test(`${label}: ${expr.toString()} == ${expected}`, () => {
    if (expr.length > 0) {
      repeat(() => {
        const args = Array.from({ length: expr.length }).map(rndDoc);
        expect(expr(...args)).toEqual(expected(...args));
      })();
    } else {
      expect(expr()).toEqual(expected());
    }
  });

const TRIALS = 10000;

const repeat = (fn: () => void) => {
  return () => {
    for (let i = 0; i < TRIALS; i++) {
      fn();
    }
  };
};

describe("JSON Merge Patch (RFC 7386)", () => {
  testCase(
    "identity",
    (a) => merge(a, undefined),
    (a) => a
  );

  testCase(
    "case",
    () => merge<JSONArrayless>(0, {}),
    () => ({})
  );

  testCase(
    "case",
    () => merge({ a: "" }, {}),
    () => ({ a: "" })
  );

  testCase(
    "deletion",
    (a) => merge(a, null),
    (a) => undefined
  );

  testCase(
    "case",
    () => merge<JSONArrayless>(true, { a: {} }),
    () => ({ a: {} })
  );

  testCase(
    "case",
    () => merge({}, { a: {} }),
    () => ({ a: {} })
  );

  testCase(
    "case",
    () => merge<JSONArrayless>({ a: false }, true),
    () => true
  );

  test(
    "associative: merge(a, merge(b, c)) == merge(merge(a, b), c) for structured docs",
    repeat(() => {
      const a = rndStructuredDoc();
      const b = rndStructuredDoc();
      const c = rndStructuredDoc();
      expect(merge(a, merge(b, c))).toEqual(merge(merge(a, b), c));
    })
  );

  testCase(
    "idempotent",
    (a) => merge(a, a),
    (a) => a
  );

  describe("fold", () => {
    testCase(
      "idempotent",
      (a, b, c) => fold(a, b, c),
      (a, b, c) => fold<JSONArrayless>(fold(a, b, c), a, b, c)
    );

    testCase(
      "log repair",
      (a, b, c) => fold<JSONArrayless>(fold(a, c), b, c),
      (a, b, c) => fold(a, b, c)
    );
  });
});

// describe diff
describe("JSON-merge-diff", () => {
  testCase(
    "identity",
    (a) => diff(a, undefined),
    (a) => a
  );

  testCase(
    "identity",
    (a) => diff(a, a),
    (a) => undefined
  );

  testCase(
    "case",
    () => diff<JSONArrayless>({}, 0),
    () => ({})
  );

  testCase(
    "case",
    () => diff({ a: {} }, {}),
    () => ({ a: {} })
  );

  testCase(
    "case",
    () => diff({}, { a: {} }),
    () => ({ a: null })
  );

  testCase(
    "case",
    () => diff({ a: false }, { a: 0 }),
    () => ({ a: false })
  );

  testCase(
    "case",
    () => diff({ a: {} }, { a: true }),
    () => ({ a: {} })
  );

  testCase(
    "inverse",
    (a, b) => merge(a, diff(b, a)),
    (a, b) => b
  );

  test(
    "inverse: diff(a, b) = c <=> merge(b, c) = a",
    repeat(() => {
      const a = rndDoc();
      const b = rndDoc();
      const c = diff(a, b);
      expect(merge(b, c)).toEqual(a);
    })
  );
});
