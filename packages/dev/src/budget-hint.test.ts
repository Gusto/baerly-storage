import { describe, expect, test } from "vitest";
import { freeTierBudgetHint } from "./budget-hint.ts";

describe("freeTierBudgetHint", () => {
  test("returns a hint quoting R2 free-tier ops and write-equivalents", () => {
    const hint = freeTierBudgetHint();
    expect(hint.key).toBe("budget");
    expect(hint.value).toContain("R2 free tier");
    expect(hint.value).toContain("1.0M"); // Class A free tier
    expect(hint.value).toContain("333k"); // 1M / 3-op write-amp
    expect(hint.value).toContain("10 GB-mo"); // storage cap
  });
});
