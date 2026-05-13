import { describe, expect, it } from "vitest";
import { substitute } from "./substitute.ts";

describe("substitute", () => {
  it("replaces a single placeholder", () => {
    expect(substitute("hello {{world}}", { world: "agent" })).toBe("hello agent");
  });

  it("replaces multiple distinct placeholders", () => {
    expect(substitute("a {{x}} b {{y}}", { x: "1", y: "2" })).toBe("a 1 b 2");
  });

  it("leaves unknown placeholders untouched (passthrough)", () => {
    expect(substitute("a {{x}} b", {})).toBe("a {{x}} b");
  });

  it("replaces every occurrence (replaceAll, not first)", () => {
    expect(substitute("a {{x}} b {{x}}", { x: "1" })).toBe("a 1 b 1");
  });

  it("does not match placeholders with internal whitespace", () => {
    expect(substitute("a {{ x }} b", { x: "1" })).toBe("a {{ x }} b");
  });

  it("supports underscores inside the key", () => {
    expect(substitute("a {{x_y}} b", { x_y: "1" })).toBe("a 1 b");
  });
});
