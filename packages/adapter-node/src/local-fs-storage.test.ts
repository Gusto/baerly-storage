import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { localFsStorage } from "./local-fs-storage.ts";

const collectKeys = async (s: ReturnType<typeof localFsStorage>): Promise<string[]> => {
  const out: string[] = [];
  for await (const e of s.list("")) {
    out.push(e.key);
  }
  return out;
};

describe("localFsStorage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("round-trips under an explicit dataDir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "baerly-lfs-arg-"));
    try {
      const s = localFsStorage({ dataDir: dir });
      await s.put("k", new TextEncoder().encode("v"));
      const got = await s.get("k");
      expect(got).not.toBeNull();
      expect(new TextDecoder().decode(got!.body)).toBe("v");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("honors BAERLY_DATA_DIR when no arg is given", async () => {
    const dir = await mkdtemp(join(tmpdir(), "baerly-lfs-env-"));
    vi.stubEnv("BAERLY_DATA_DIR", dir);
    try {
      const s = localFsStorage();
      await s.put("k", new TextEncoder().encode("v"));
      await expect(collectKeys(localFsStorage({ dataDir: dir }))).resolves.toContain("k");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("defaults to <cwd>/.baerly-data when neither arg nor BAERLY_DATA_DIR is set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "baerly-lfs-cwd-"));
    vi.stubEnv("BAERLY_DATA_DIR", undefined as unknown as string);
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
    try {
      await localFsStorage().put("k", new TextEncoder().encode("v"));
      // Data must land under <cwd>/.baerly-data — read it back via an
      // explicit dataDir pointed at the same resolved path.
      await expect(
        collectKeys(localFsStorage({ dataDir: join(dir, ".baerly-data") })),
      ).resolves.toContain("k");
    } finally {
      cwdSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("explicit dataDir wins over BAERLY_DATA_DIR", async () => {
    const argDir = await mkdtemp(join(tmpdir(), "baerly-lfs-win-"));
    const envDir = await mkdtemp(join(tmpdir(), "baerly-lfs-lose-"));
    vi.stubEnv("BAERLY_DATA_DIR", envDir);
    try {
      await localFsStorage({ dataDir: argDir }).put("k", new TextEncoder().encode("v"));
      await expect(collectKeys(localFsStorage({ dataDir: argDir }))).resolves.toContain("k");
      await expect(collectKeys(localFsStorage({ dataDir: envDir }))).resolves.not.toContain("k");
    } finally {
      await rm(argDir, { recursive: true, force: true });
      await rm(envDir, { recursive: true, force: true });
    }
  });
});
