import { describe, expect, test } from "vitest";
import { BaerlyError } from "@baerly/protocol";
import {
  isMonotonicRead,
  isReadYourWrite,
  isTransientReadError,
  missingAckedSlots,
} from "../fixtures/session-guarantees.ts";

// These predicates are the decision core the causal cascade asserts
// against (SG-1/SG-2/SG-3 + the poll-loop read-error policy). The cascade
// exercises them under concurrency; here we pin the exact boundary each
// one draws, so a refactor that silently makes an assertion un-fireable
// (e.g. a comparison that degrades to always-true) turns red here.

describe("SG-1 missingAckedSlots (no-lost-writes)", () => {
  test("holds when every acked slot is durable", () => {
    expect(missingAckedSlots([1, 2, 3], new Set([1, 2, 3, 4]))).toEqual([]);
  });

  test("reports acked slots absent from the durable set", () => {
    expect(missingAckedSlots([1, 2, 3], new Set([1, 3]))).toEqual([2]);
  });

  test("reports every missing slot, preserving acked order", () => {
    expect(missingAckedSlots([5, 2, 9], new Set([2]))).toEqual([5, 9]);
  });

  test("empty ack ledger trivially holds", () => {
    expect(missingAckedSlots([], new Set([1, 2]))).toEqual([]);
  });
});

describe("SG-2 isReadYourWrite", () => {
  test("holds when the self-read resolves the won slot", () => {
    expect(isReadYourWrite(7, 7)).toBe(true);
  });

  test("holds when the self-read resolves a newer slot", () => {
    expect(isReadYourWrite(8, 7)).toBe(true);
  });

  test("violated when the self-read resolves an older slot", () => {
    expect(isReadYourWrite(6, 7)).toBe(false);
  });

  test("violated when the self-read resolved nothing", () => {
    expect(isReadYourWrite(undefined, 0)).toBe(false);
  });
});

describe("SG-3 isMonotonicRead", () => {
  test("holds when the read advances", () => {
    expect(isMonotonicRead(5, 4)).toBe(true);
  });

  test("holds when the read repeats the last slot", () => {
    expect(isMonotonicRead(5, 5)).toBe(true);
  });

  test("holds against the -1 sentinel (first observation)", () => {
    expect(isMonotonicRead(0, -1)).toBe(true);
  });

  test("violated when the read goes backward", () => {
    expect(isMonotonicRead(4, 5)).toBe(false);
  });
});

describe("isTransientReadError (poll-loop read-error policy)", () => {
  test("BaerlyError is transient — swallowed, retried next tick", () => {
    expect(isTransientReadError(new BaerlyError("NetworkError", "flip"))).toBe(true);
  });

  test("a failed assertion (plain Error) is fatal — must surface", () => {
    expect(isTransientReadError(new Error("monotonic-reads violated"))).toBe(false);
  });

  test("a non-error throw is fatal", () => {
    expect(isTransientReadError("boom")).toBe(false);
  });
});
