import { describe, expect, test } from "vitest";
import { defineStorageConformanceSuite } from "./conformance.ts";
import { MemoryStorage } from "./memory.ts";

// `caseSensitiveKeys: true` is the in-memory impl's behavior — keys
// are stored verbatim in a `Map<string, …>`. The default in
// `ConformanceOptions` matches; pinned here for explicit documentation.
defineStorageConformanceSuite("MemoryStorage", async () => ({ storage: new MemoryStorage() }), {
  caseSensitiveKeys: true,
});

// The shared conformance suite uses ASCII-only keys, where UTF-16 and
// UTF-8 orderings coincide. This pins the non-ASCII case directly: the
// reference backend must sort by UTF-8 bytes, like S3/R2 — not by JS's
// default UTF-16 code-unit order.
describe("MemoryStorage list() UTF-8 byte order", () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  // Discriminating key set (written as escapes to keep the source
  // ASCII). BMP is U+E000 (UTF-8 first byte 0xEE); EMOJI is U+1F600
  // (supplementary plane, UTF-8 first byte 0xF0). In UTF-8 byte order
  // BMP < EMOJI, but under UTF-16 code units EMOJI's high surrogate
  // (0xD83D) sorts BEFORE 0xE000 — so the two orderings disagree.
  // "a" (0x61) is first either way. U+E000 is Private-Use with no
  // Unicode decomposition, so it can't trip a filesystem store's
  // normalization quirks (this same set is reused by the LocalFs test).
  const BMP = "\uE000";
  const EMOJI = "\u{1F600}";
  const collectKeys = async (s: MemoryStorage, opts?: { startAfter?: string }) => {
    const out: string[] = [];
    for await (const e of s.list("", opts)) {
      out.push(e.key);
    }
    return out;
  };

  test("list() yields keys in UTF-8 byte order, not UTF-16", async () => {
    const s = new MemoryStorage();
    await s.put(EMOJI, enc("emoji"));
    await s.put(BMP, enc("bmp"));
    await s.put("a", enc("ascii"));
    await expect(collectKeys(s)).resolves.toEqual(["a", BMP, EMOJI]);
  });

  test("startAfter cursor is evaluated in UTF-8 byte order", async () => {
    const s = new MemoryStorage();
    await s.put(EMOJI, enc("emoji"));
    await s.put(BMP, enc("bmp"));
    await s.put("a", enc("ascii"));
    await expect(collectKeys(s, { startAfter: "a" })).resolves.toEqual([BMP, EMOJI]);
  });
});
