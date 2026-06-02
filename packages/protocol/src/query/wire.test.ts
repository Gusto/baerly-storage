/**
 * Tests for wire-format predicate types.
 *
 * Strategy: assert the exact structure of EMPTY_PREDICATE_WIRE so that
 * ArrayDeclaration and ObjectLiteral mutants die.
 */

import { describe, expect, test } from "vitest";

import { EMPTY_PREDICATE_WIRE } from "./wire.ts";

describe("EMPTY_PREDICATE_WIRE", () => {
  test("has empty clauses array", () => {
    expect(EMPTY_PREDICATE_WIRE.clauses).toEqual([]);
  });

  test("is a PredicateWire with only clauses field", () => {
    // If the ObjectLiteral { clauses: [] } is mutated to {},
    // the clauses property will be undefined. This test verifies
    // that the object structure is correct.
    expect(EMPTY_PREDICATE_WIRE).toEqual({ clauses: [] });
  });

  test("clauses array is empty, not populated", () => {
    // If the ArrayDeclaration [] is mutated to ["Stryker was here"] or similar,
    // the length will be non-zero. This test ensures the array is truly empty.
    expect(EMPTY_PREDICATE_WIRE.clauses).toHaveLength(0);
  });
});
