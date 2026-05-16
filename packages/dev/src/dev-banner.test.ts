import { describe, expect, test } from "vitest";
import { printDevBanner } from "./dev-banner.ts";

// ANSI CSI sequences: ESC (0x1b) followed by "[".
// We construct the ESC char from its code point to avoid embedding
// a literal control character in the source file.
const ESC_BRACKET = String.fromCodePoint(0x1b) + "[";
const hasAnsi = (s: string) => s.includes(ESC_BRACKET);

describe("printDevBanner", () => {
  test("TTY mode with both URLs contains open-this marker and all hints", () => {
    const chunks: string[] = [];
    printDevBanner({
      name: "helpdesk",
      primaryUrl: { label: "app", url: "http://localhost:5173" },
      apiUrl: { label: "api", url: "http://localhost:3000", note: "proxied via /v1" },
      hints: [
        { key: "data", value: ".baerly-data/" },
        { key: "bearer", value: "dev-helpdesk-secret  (dev only)" },
      ],
      plain: false,
      write: (chunk) => chunks.push(chunk),
    });
    const out = chunks.join("");
    expect(out).toContain("▎ baerly");
    expect(out).toContain("http://localhost:5173");
    expect(out).toContain("← open this");
    expect(out).toContain(".baerly-data/");
    expect(out).toContain("dev-helpdesk-secret");
  });

  test("TTY mode with API only — no open-this marker, banner present", () => {
    const chunks: string[] = [];
    printDevBanner({
      name: "helpdesk",
      apiUrl: { label: "api", url: "http://localhost:3000" },
      plain: false,
      write: (chunk) => chunks.push(chunk),
    });
    const out = chunks.join("");
    expect(out).toContain("▎ baerly");
    expect(out).not.toContain("← open this");
    expect(out).toContain("http://localhost:3000");
  });

  test("plain mode — no ANSI escapes, no arrows, no border char", () => {
    const chunks: string[] = [];
    printDevBanner({
      name: "helpdesk",
      primaryUrl: { label: "app", url: "http://localhost:5173" },
      apiUrl: { label: "api", url: "http://localhost:3000", note: "proxied via /v1" },
      hints: [{ key: "data", value: ".baerly-data/" }],
      plain: true,
      write: (chunk) => chunks.push(chunk),
    });
    const out = chunks.join("");
    expect(hasAnsi(out)).toBe(false);
    expect(out).not.toContain("←");
    expect(out).not.toContain("▎");
    expect(out).toContain("http://localhost:5173");
    expect(out).toContain(".baerly-data/");
  });

  test("write sink captures entire output", () => {
    const chunks: string[] = [];
    printDevBanner({
      name: "test",
      hints: [{ key: "foo", value: "bar" }],
      plain: true,
      write: (chunk) => chunks.push(chunk),
    });
    expect(chunks.length).toBeGreaterThan(0);
    const out = chunks.join("");
    expect(out).toContain("baerly");
    expect(out).toContain("foo");
    expect(out).toContain("bar");
  });

  test("empty hints array — no extra blank trailer", () => {
    const chunks: string[] = [];
    printDevBanner({
      name: "test",
      hints: [],
      plain: true,
      write: (chunk) => chunks.push(chunk),
    });
    const out = chunks.join("");
    expect(out.endsWith("\n\n")).toBe(false);
  });
});
