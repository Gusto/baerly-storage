import { BaerlyError } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { layoutWithoutRule } from "../../../../tests/fixtures/tree-mutants.ts";
import { LEAF_MAX_BODY_BYTES } from "./constants.ts";
import {
  createTreeConfig,
  DEFAULT_TREE_CONFIG,
  TREE_LAYOUT,
  TREE_LAYOUT_RULES,
  type TreeLayout,
} from "./layout.ts";

/** The small-scope layout that makes 20 short rows a depth-3 tree. */
const SMALL_SCOPE: TreeLayout = {
  leafTargetBytes: 32,
  leafMinBytes: 16,
  leafMaxBytes: 48,
  leafIsolationDocumentBytes: 48,
  branchFanoutMin: 2,
  branchFanoutTarget: 2,
  branchFanoutMax: 3,
  singleLeafMaxBytes: 0,
  singleLeafMaxRows: 0,
};

const layout = (overrides: Record<string, unknown>): TreeLayout =>
  ({ ...TREE_LAYOUT, ...overrides }) as TreeLayout;

/**
 * For each rule, a layout that breaks that rule and no other, so the
 * mutant missing the rule must accept it.
 */
const VIOLATIONS: Readonly<Record<string, TreeLayout>> = {
  // The decoder's leaf body ceiling is not a layout field.
  fields: layout({ leafMaxBodyBytes: 4 * LEAF_MAX_BODY_BYTES }),
  "safe-integers": layout({ singleLeafMaxRows: 1.5 }),
  "leaf-min-below-target": layout({ leafMinBytes: 0, leafMaxBytes: 32_768 }),
  "leaf-max-derived": layout({ leafMaxBytes: 24_577 }),
  "leaf-max-ceiling": layout({ leafTargetBytes: 300_000, leafMaxBytes: 591_808 }),
  "isolation-lower-bound": layout({ leafIsolationDocumentBytes: 16_385 }),
  "isolation-upper-bound": layout({ leafIsolationDocumentBytes: 24_577 }),
  "fanout-target-power-of-two": layout({ branchFanoutTarget: 33 }),
  "fanout-min-max": layout({ branchFanoutMin: 1 }),
  "single-leaf-bytes-range": layout({ singleLeafMaxBytes: 1_048_577 }),
  "single-leaf-rows-range": layout({ singleLeafMaxRows: 65_537 }),
};

const refusal = (candidate: TreeLayout, steps = {}): BaerlyError | null => {
  try {
    createTreeConfig({ layout: candidate, steps });
    return null;
  } catch (error) {
    return error as BaerlyError;
  }
};

const expectRefused = (candidate: TreeLayout): void => {
  const error = refusal(candidate);
  expect(error).toBeInstanceOf(BaerlyError);
  expect(error?.code).toBe("InvalidConfig");
};

describe("TreeLayout", () => {
  test("the production layout and the small-scope layout are valid", () => {
    expect(createTreeConfig().layout).toEqual(TREE_LAYOUT);
    expect(createTreeConfig({ layout: SMALL_SCOPE }).layout).toEqual(SMALL_SCOPE);
    expect(DEFAULT_TREE_CONFIG.layout).toEqual(TREE_LAYOUT);
  });

  test("the leaf body ceiling is a fixed decoder constant, not a layout field", () => {
    expect(LEAF_MAX_BODY_BYTES).toBe(2_097_152);
    expect(Object.keys(TREE_LAYOUT)).not.toContain("leafMaxBodyBytes");
    expect(refusal(VIOLATIONS["fields"]!)?.code).toBe("InvalidConfig");
  });

  test("the resolved config is frozen and does not alias the override", () => {
    const override = { ...SMALL_SCOPE };
    const config = createTreeConfig({ layout: override });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.layout)).toBe(true);
    expect(Object.isFrozen(config.steps)).toBe(true);
    override.branchFanoutMax = 1;
    expect(config.layout.branchFanoutMax).toBe(3);
  });

  test("every rule has a violation fixture", () => {
    expect(Object.keys(VIOLATIONS).toSorted()).toEqual(
      TREE_LAYOUT_RULES.map((r) => r.name).toSorted(),
    );
  });

  test.each(TREE_LAYOUT_RULES.map((r) => r.name))(
    "a layout breaking only rule %s is refused as InvalidConfig, naming the rule",
    (name) => {
      const error = refusal(VIOLATIONS[name]!);
      expect(error).toBeInstanceOf(BaerlyError);
      expect(error?.code).toBe("InvalidConfig");
      expect(error?.message).toContain(`rule ${name} failed`);
    },
  );

  test("the isolation lower bound refuses the leaf-count counterexample", () => {
    // leafMinBytes 16 with leafIsolationDocumentBytes 20 would let 310
    // bytes of alternating 11- and 20-byte documents make 20 leaves,
    // above the ⌊bytes / (leafMinBytes + 1)⌋ + 1 = 19 the scan bound uses.
    const error = refusal({ ...SMALL_SCOPE, leafIsolationDocumentBytes: 20 });
    expect(error?.message).toContain("rule isolation-lower-bound failed");
  });

  test.each([
    [
      "a missing field",
      (() => {
        const { singleLeafMaxRows: _dropped, ...rest } = TREE_LAYOUT;
        return rest as TreeLayout;
      })(),
    ],
    ["NaN", layout({ branchFanoutMax: Number.NaN })],
    ["Infinity", layout({ singleLeafMaxBytes: Number.POSITIVE_INFINITY })],
    ["a numeric string", layout({ branchFanoutMax: "128" })],
    ["an unsafe integer", layout({ singleLeafMaxBytes: 2 ** 53 })],
    ["leafMinBytes equal to the target", layout({ leafMinBytes: 16_384, leafMaxBytes: 16_384 })],
    ["branchFanoutTarget 1", layout({ branchFanoutTarget: 1 })],
    ["branchFanoutTarget 2^17", layout({ branchFanoutTarget: 131_072 })],
    ["branchFanoutMin above branchFanoutMax", layout({ branchFanoutMin: 129 })],
    ["branchFanoutMax 257", layout({ branchFanoutMax: 257 })],
    ["negative singleLeafMaxBytes", layout({ singleLeafMaxBytes: -1 })],
    ["negative singleLeafMaxRows", layout({ singleLeafMaxRows: -1 })],
  ])("%s is refused", (_label, candidate) => {
    expectRefused(candidate);
  });

  test.each<[string, TreeLayout]>([
    [
      "a non-enumerable extra field",
      Object.defineProperty({ ...TREE_LAYOUT }, "extra", { value: 1 }),
    ],
    ["a symbol-keyed extra field", { ...TREE_LAYOUT, [Symbol("extra")]: 1 } as TreeLayout],
    [
      "a non-enumerable field",
      Object.defineProperty({ ...TREE_LAYOUT }, "branchFanoutMax", {
        value: 128,
        enumerable: false,
      }),
    ],
    [
      "a field inherited from the prototype",
      Object.assign(
        Object.create({ singleLeafMaxRows: TREE_LAYOUT.singleLeafMaxRows }) as object,
        (({ singleLeafMaxRows: _dropped, ...rest }) => rest)(TREE_LAYOUT),
      ) as TreeLayout,
    ],
  ])("%s is refused by the fields rule", (_label, candidate) => {
    expect(refusal(candidate)?.message).toContain("rule fields failed");
  });

  test("a getter field is refused before it is read, so no later read can differ", () => {
    let reads = 0;
    const candidate = Object.defineProperty({ ...TREE_LAYOUT }, "branchFanoutMax", {
      enumerable: true,
      get: () => (reads++ === 0 ? 128 : 100_000),
    });
    expect(refusal(candidate)?.message).toContain("rule fields failed");
    expect(reads).toBe(0);
  });

  test("the config holds the values that were validated, not a later read of the override", () => {
    const override = { ...SMALL_SCOPE };
    const config = createTreeConfig({ layout: override });
    override.branchFanoutMax = 100_000;
    expect(config.layout.branchFanoutMax).toBe(3);
    expect(Object.getPrototypeOf(config.layout)).toBe(Object.prototype);
  });

  test("a BigInt field is refused as InvalidConfig with a readable message", () => {
    const error = refusal(layout({ branchFanoutMax: 128n }));
    expect(error).toBeInstanceOf(BaerlyError);
    expect(error?.code).toBe("InvalidConfig");
    expect(error?.message).toContain("rule safe-integers failed");
    expect(error?.message).toContain("branchFanoutMax: 128n");
  });

  test.each([
    ["isolation exactly 2 × (leafMinBytes + 1)", layout({ leafIsolationDocumentBytes: 16_386 })],
    [
      "leafMaxBytes exactly at its ceiling",
      layout({ leafTargetBytes: 266_240, leafMaxBytes: 524_288 }),
    ],
    ["branchFanoutTarget 2", layout({ branchFanoutTarget: 2 })],
    ["branchFanoutTarget 2^16", layout({ branchFanoutTarget: 65_536 })],
    [
      "branchFanoutMin = branchFanoutMax = 256",
      layout({ branchFanoutMin: 256, branchFanoutMax: 256 }),
    ],
    ["the depth-0 rule disabled", layout({ singleLeafMaxBytes: 0, singleLeafMaxRows: 0 })],
    [
      "the depth-0 rule at its ceilings",
      layout({ singleLeafMaxBytes: 1_048_576, singleLeafMaxRows: 65_536 }),
    ],
  ])("%s is accepted", (_label, candidate) => {
    expect(refusal(candidate)).toBeNull();
  });
});

describe("mutation", () => {
  test.each(TREE_LAYOUT_RULES.map((r) => r.name))(
    "a validator missing rule %s accepts that rule's violation",
    (name) => {
      expect(refusal(VIOLATIONS[name]!, layoutWithoutRule(name).options.steps)).toBeNull();
    },
  );
});
