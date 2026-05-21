import { describe, test, expect } from "vitest";
import { formatBundleSizeLine } from "../helpers/bundle-size-report.ts";

describe("formatBundleSizeLine", () => {
  test("emits canonical greppable line for raw kind", () => {
    const line = formatBundleSizeLine({
      entry: "client.js",
      kind: "raw",
      measured: 12000,
      budget: 10000,
      chunks: ["client.js", "chunk-abc.js"],
    });
    expect(line).toBe(
      "BUNDLE_SIZE entry=client.js kind=raw measured=12000 budget=10000 delta=+2000 chunks=client.js,chunk-abc.js",
    );
  });

  test("formats negative delta when under budget", () => {
    const line = formatBundleSizeLine({
      entry: "auth.js",
      kind: "gz",
      measured: 500,
      budget: 1000,
      chunks: ["auth.js"],
    });
    expect(line).toContain("delta=-500");
  });
});
