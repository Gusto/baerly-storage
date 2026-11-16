import { describe, test, expect } from "vitest";
import { loadSurface } from "./surface.ts";

describe("loadSurface", () => {
  test("strict surface is non-empty, hashed, and excludes AGENTS.md content", () => {
    const s = loadSurface({ withAgentsMd: false });
    expect(s.text.length).toBeGreaterThan(1000);
    expect(s.text).toContain("Db.create"); // from dist/API.md / .d.ts
    expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(s.kind).toBe("api-md+dts");
    // strict surface must NOT contain the AGENTS.md STOP banner
    expect(s.text).not.toContain("STOP — read this before writing any storage code");
  });

  test("hash is stable across calls for the same inputs", () => {
    expect(loadSurface({ withAgentsMd: false }).sha256).toBe(
      loadSurface({ withAgentsMd: false }).sha256,
    );
  });

  test("--with-agents-md changes kind, grows text, and changes the hash", () => {
    const strict = loadSurface({ withAgentsMd: false });
    const withMd = loadSurface({ withAgentsMd: true });
    expect(withMd.kind).toBe("api-md+dts+agents-md");
    expect(withMd.text.length).toBeGreaterThan(strict.text.length);
    expect(withMd.sha256).not.toBe(strict.sha256);
    expect(withMd.text).toContain("STOP — read this before writing any storage code");
  });
});
