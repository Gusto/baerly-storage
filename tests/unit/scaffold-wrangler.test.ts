import { describe, expect, test } from "vitest";
import { scaffoldWranglerCompat, stripJsonc } from "../setup/scaffold-wrangler.ts";

describe("stripJsonc", () => {
  test("strips line, trailing and block comments and trailing commas", () => {
    const text = `{
      // whole-line note
      "a": 1, // trailing note
      /* block
         comment */
      "b": ["x", "y",], /* inline */
    }`;
    expect(JSON.parse(stripJsonc(text))).toEqual({ a: 1, b: ["x", "y"] });
  });

  test("leaves comment markers and escaped quotes inside strings alone", () => {
    const text = `{ "url": "https://example.com/a//b", "c": "/* not a comment */", "q": "say \\"hi\\" // x" }`;
    expect(JSON.parse(stripJsonc(text))).toEqual({
      url: "https://example.com/a//b",
      c: "/* not a comment */",
      q: 'say "hi" // x',
    });
  });
});

describe("scaffoldWranglerCompat", () => {
  test("reads the date and flags both Cloudflare scaffolds agree on", () => {
    const compat = scaffoldWranglerCompat();
    expect(compat.compatibilityDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(compat.compatibilityFlags).toContain("nodejs_compat");
  });
});
