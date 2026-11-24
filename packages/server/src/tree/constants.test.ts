import { describe, expect, test } from "vitest";
import { GC_MARK_LIST_PAGE_KEYS } from "@baerly/protocol";
import {
  LEAF_MAX_BODY_BYTES,
  TREE_GC_RECORD_MAX_BODY_BYTES,
  TREE_GC_RECORD_MAX_KEYS,
  TREE_GC_SUPERSEDED_DELAY_MINUTES,
  TREE_GC_SWEEP_AGE_MINUTES,
  TREE_GC_SWEEP_LIST_KEYS,
  TREE_GC_TICK_CANDIDATES,
} from "./constants.ts";

describe("artifact GC constants", () => {
  test("a tick's candidate checks fit one record page and hold a sweep page", () => {
    expect(TREE_GC_TICK_CANDIDATES).toBeLessThanOrEqual(GC_MARK_LIST_PAGE_KEYS);
    expect(TREE_GC_SWEEP_LIST_KEYS).toBeLessThan(TREE_GC_TICK_CANDIDATES);
  });

  test("the sweep never deletes sooner after a supersession than the record path", () => {
    expect(TREE_GC_SWEEP_AGE_MINUTES).toBeGreaterThanOrEqual(TREE_GC_SUPERSEDED_DELAY_MINUTES);
  });

  test("a record at its key cap fits the record body ceiling", () => {
    // A superseded entry is `"<32 hex>/<64 hex>",`: 100 bytes. A fresh
    // entry is shorter. The envelope is well under 1 KiB.
    expect(TREE_GC_RECORD_MAX_KEYS * 100 + 1024).toBeLessThanOrEqual(TREE_GC_RECORD_MAX_BODY_BYTES);
    expect(TREE_GC_RECORD_MAX_BODY_BYTES).toBe(LEAF_MAX_BODY_BYTES);
  });
});
