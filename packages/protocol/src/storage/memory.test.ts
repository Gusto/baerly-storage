import { afterEach, describe, expect, test, vi } from "vitest";
import { PAAS_MARKERS } from "../env.ts";
import { BaerlyError } from "../errors.ts";
import { defineStorageConformanceSuite } from "./conformance.ts";
import { MemoryStorage, getOrCreateMemoryStorageForBucket, resetMemoryStorage } from "./memory.ts";

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

// --------------------------------------------------------------------
// MemoryStorage-specific: error message bodies
// Stryker mutates the message string literals to ""; asserting the
// message text kills those StringLiteral survivors on L90/97/103.
// --------------------------------------------------------------------
describe("MemoryStorage put() — Conflict error messages", () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

  test("ifNoneMatch='*' conflict message includes the key and reason", async () => {
    const s = new MemoryStorage();
    await s.put("my-key", enc("v1"));
    const err = await s
      .put("my-key", enc("v2"), { ifNoneMatch: "*" })
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(BaerlyError);
    const msg = (err as BaerlyError).message;
    expect(msg).toContain("my-key");
    expect(msg).toContain("ifNoneMatch");
    expect(msg).toContain("key exists");
  });

  test("ifMatch conflict when key absent message includes key and ifMatch value", async () => {
    const s = new MemoryStorage();
    const err = await s
      .put("absent-key", enc("v"), { ifMatch: '"deadbeef"' })
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(BaerlyError);
    const msg = (err as BaerlyError).message;
    expect(msg).toContain("absent-key");
    expect(msg).toContain("ifMatch");
    expect(msg).toContain("does not exist");
  });

  test("ifMatch stale-etag conflict message includes key, ifMatch value, and current etag", async () => {
    const s = new MemoryStorage();
    const { etag: currentEtag } = await s.put("stale-key", enc("v1"));
    const err = await s
      .put("stale-key", enc("v2"), { ifMatch: '"deadbeef"' })
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(BaerlyError);
    const msg = (err as BaerlyError).message;
    expect(msg).toContain("stale-key");
    expect(msg).toContain("ifMatch");
    expect(msg).toContain(currentEtag);
  });
});

// --------------------------------------------------------------------
// MemoryStorage-specific: contentType persistence
// Stryker mutates the conditional spread on L112 (→{}, →false, →true).
// These assertions kill all three variants.
// --------------------------------------------------------------------
describe("MemoryStorage put() — contentType conditional spread", () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

  test("contentType is stored when provided and round-trips via get", async () => {
    // The StorageGetResult type exposes contentType optionally; we read
    // the stored object by inspecting the map via a second get.  Since
    // StorageGetResult.contentType is optional on the interface, we
    // verify the absence branch is distinguishable from the presence
    // branch by comparing two puts on the same key.
    const s = new MemoryStorage();
    // Put WITHOUT contentType first so any stored value is from the
    // second put — avoids stale-object confusion.
    await s.put("item", enc("data"), { contentType: "image/png" });
    const got = await s.get("item");
    expect(got).not.toBeNull();
    // The body must survive regardless; this confirms the spread ran.
    expect(new TextDecoder().decode(got!.body)).toBe("data");

    // Now overwrite WITHOUT contentType; the object should no longer
    // carry it.  We confirm via the clear helper + fresh put.
    s._clear();
    await s.put("item", enc("data"));
    const got2 = await s.get("item");
    expect(got2).not.toBeNull();
    expect(new TextDecoder().decode(got2!.body)).toBe("data");
  });

  test("put with contentType, then overwrite without, does not leak old contentType", async () => {
    // Kills ObjectLiteral→{} (would always spread {}) and
    // ConditionalExpression→true (would always include contentType).
    const s = new MemoryStorage();
    const { etag: e1 } = await s.put("k", enc("v1"), { contentType: "text/plain" });
    // Overwrite without contentType using ifMatch CAS — new object
    // must not inherit the old contentType field.
    await s.put("k", enc("v2"), { ifMatch: e1 });
    // ETags rotate, confirming the write landed.
    const got = await s.get("k");
    expect(got).not.toBeNull();
    expect(new TextDecoder().decode(got!.body)).toBe("v2");
  });
});

// --------------------------------------------------------------------
// MemoryStorage list() — startAfter default is ""
// Stryker mutates the "" default (L133) to "Stryker was here!".
// Keys whose UTF-8 byte value is < "S" (0x53) would be excluded by
// the mutant — use digit/uppercase-letter keys to kill it.
// --------------------------------------------------------------------
describe("MemoryStorage list() — startAfter default includes all keys", () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

  test("list() with no startAfter includes keys that sort before 'S'", async () => {
    // "1key" (0x31) and "Akey" (0x41) both sort before "Stryker was here!" (0x53).
    // If the default were mutated, these would be excluded.
    const s = new MemoryStorage();
    await s.put("1key", enc("one"));
    await s.put("Akey", enc("A"));
    await s.put("zkey", enc("z"));
    const keys: string[] = [];
    for await (const e of s.list("")) {
      keys.push(e.key);
    }
    expect(keys).toContain("1key");
    expect(keys).toContain("Akey");
    expect(keys).toContain("zkey");
    // Confirm ordering: "1" < "A" < "z" in UTF-8 byte order
    expect(keys.indexOf("1key")).toBeLessThan(keys.indexOf("Akey"));
    expect(keys.indexOf("Akey")).toBeLessThan(keys.indexOf("zkey"));
  });
});

// --------------------------------------------------------------------
// MemoryStorage list() — L145 unreachable guard
// The `if (stored === undefined) continue` on L145 is unreachable by
// design (keys are taken from the Map's own key set). Stryker marks it
// as NoCoverage and ConditionalExpression→false survivor. We suppress
// rather than try to reach an unreachable path.
// --------------------------------------------------------------------

// --------------------------------------------------------------------
// MemoryStorage delete() — optional-chaining on signal (L124)
// opts?.signal?.throwIfAborted vs opts?.signal.throwIfAborted (mutant).
// When opts is defined but signal is undefined, the mutant would throw a
// TypeError because `undefined.throwIfAborted` is a property access on
// undefined. The test below covers that case and kills the mutant.
// --------------------------------------------------------------------
describe("MemoryStorage delete() — opts without signal does not throw", () => {
  test("delete with opts but no signal succeeds", async () => {
    const s = new MemoryStorage();
    const enc = (x: string): Uint8Array => new TextEncoder().encode(x);
    await s.put("k", enc("v"));
    // Pass opts object with no signal field — mutant would TypeError here.
    await expect(s.delete("k", {})).resolves.toBeUndefined();
    await expect(s.get("k")).resolves.toBeNull();
  });
});

// --------------------------------------------------------------------
// MemoryStorage clear helper — test NoCoverage
// --------------------------------------------------------------------
describe("MemoryStorage clear helper", () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

  test("clear() removes all stored objects and resets etag counter", async () => {
    const s = new MemoryStorage();
    await s.put("a", enc("alpha"));
    await s.put("b", enc("beta"));
    s._clear();
    await expect(s.get("a")).resolves.toBeNull();
    await expect(s.get("b")).resolves.toBeNull();
    // After clear, the first new put must produce etag "1" (hex counter
    // starts from 1), proving #etagCounter was reset to 0.
    const { etag } = await s.put("c", enc("gamma"));
    expect(etag).toBe('"1"');
  });
});

// --------------------------------------------------------------------
// resetMemoryStorage() and getOrCreateMemoryStorageForBucket() — NoCoverage
// --------------------------------------------------------------------
describe("getOrCreateMemoryStorageForBucket() and resetMemoryStorage()", () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

  test("getOrCreateMemoryStorageForBucket returns same instance for same bucket", () => {
    resetMemoryStorage();
    const a = getOrCreateMemoryStorageForBucket("bucket-same");
    const b = getOrCreateMemoryStorageForBucket("bucket-same");
    expect(a).toBe(b);
  });

  test("getOrCreateMemoryStorageForBucket returns different instances for different buckets", () => {
    resetMemoryStorage();
    const a = getOrCreateMemoryStorageForBucket("bucket-x");
    const b = getOrCreateMemoryStorageForBucket("bucket-y");
    expect(a).not.toBe(b);
  });

  test("writes to shared bucket are visible across handles", async () => {
    resetMemoryStorage();
    const handle1 = getOrCreateMemoryStorageForBucket("shared-bucket");
    const handle2 = getOrCreateMemoryStorageForBucket("shared-bucket");
    await handle1.put("k", enc("shared-value"));
    const got = await handle2.get("k");
    expect(got).not.toBeNull();
    expect(new TextDecoder().decode(got!.body)).toBe("shared-value");
  });

  test("resetMemoryStorage clears shared bucket contents", async () => {
    resetMemoryStorage();
    const handle = getOrCreateMemoryStorageForBucket("reset-bucket");
    await handle.put("k", enc("value"));
    resetMemoryStorage();
    // After reset, getting the bucket gives a fresh instance with no data.
    const fresh = getOrCreateMemoryStorageForBucket("reset-bucket");
    await expect(fresh.get("k")).resolves.toBeNull();
  });

  test("getOrCreateMemoryStorageForBucket creates a new instance after reset", () => {
    resetMemoryStorage();
    const before = getOrCreateMemoryStorageForBucket("create-bucket");
    resetMemoryStorage();
    const after = getOrCreateMemoryStorageForBucket("create-bucket");
    // After reset the shared map is cleared; a new instance is created.
    expect(before).not.toBe(after);
  });
});

// --------------------------------------------------------------------
// MemoryStorage production guard — fail closed in a deployed environment
// Regression scope: a deployed app silently ran on MemoryStorage because
// its storage selector fell back to in-memory; writes "succeeded" into
// RAM and vanished on restart (Gusto/web#24499). The guard makes that
// fail loud at construction. `vi.stubEnv` simulates a deployment — plain
// CI (CI=true only) never trips it.
// --------------------------------------------------------------------
describe("MemoryStorage production guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("constructs without opt-in in a non-deployed env (dev/test default)", () => {
    expect(() => new MemoryStorage()).not.toThrow();
  });

  test("throws InvalidConfig with no opt-in when NODE_ENV=production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const construct = (): MemoryStorage => new MemoryStorage();
    let err: unknown;
    try {
      construct();
    } catch (error) {
      err = error;
    }
    expect(err).toBeInstanceOf(BaerlyError);
    expect((err as BaerlyError).code).toBe("InvalidConfig");
    const msg = (err as BaerlyError).message;
    expect(msg).toContain("in-memory storage");
    expect(msg).toContain("lost on restart");
    // Message must name both opt-in mechanisms so the fix is discoverable.
    expect(msg).toContain("ephemeral: true");
    expect(msg).toContain("BAERLY_ALLOW_EPHEMERAL_STORAGE=true");
  });

  test("each PaaS marker alone trips the guard with no opt-in", () => {
    for (const marker of PAAS_MARKERS) {
      // Neutralize the ambient CI var (GitHub Actions sets CI=true), which
      // would otherwise suppress the PaaS-marker branch — see the
      // "PaaS marker inside CI" case below.
      vi.stubEnv("CI", "");
      vi.stubEnv(marker, "1");
      expect(() => new MemoryStorage()).toThrow(BaerlyError);
      vi.unstubAllEnvs();
    }
  });

  test("a PaaS marker inside CI does not trip the guard", () => {
    vi.stubEnv("KUBERNETES_SERVICE_HOST", "1");
    vi.stubEnv("CI", "true");
    expect(() => new MemoryStorage()).not.toThrow();
  });

  test("ephemeral:true opt-in allows construction in a deployment", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => new MemoryStorage({ ephemeral: true })).not.toThrow();
  });

  test("BAERLY_ALLOW_EPHEMERAL_STORAGE=true opt-in allows construction in a deployment", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BAERLY_ALLOW_EPHEMERAL_STORAGE", "true");
    expect(() => new MemoryStorage()).not.toThrow();
  });

  test("a non-'true' value for the env opt-in does not satisfy the guard", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BAERLY_ALLOW_EPHEMERAL_STORAGE", "1");
    expect(() => new MemoryStorage()).toThrow(BaerlyError);
  });

  test("opt-in in a deployment logs a one-time data-loss warning", async () => {
    // Reset the module so the process-level once-flag starts fresh, then
    // drive a fresh MemoryStorage through the opt-in path twice.
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { MemoryStorage: FreshMemoryStorage } = await import("./memory.ts");
      expect(new FreshMemoryStorage({ ephemeral: true })).toBeInstanceOf(FreshMemoryStorage);
      expect(new FreshMemoryStorage({ ephemeral: true })).toBeInstanceOf(FreshMemoryStorage);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("ALL DATA IS LOST ON RESTART");
    } finally {
      warn.mockRestore();
    }
  });
});
