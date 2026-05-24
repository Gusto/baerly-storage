import { describe, test, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boltOnExistingWrangler } from "./bolt-on.ts";

const STOCK_WRANGLER = `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "test-app",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-24"
}
`;

const STOCK_PACKAGE_JSON = JSON.stringify(
  {
    name: "test-app",
    version: "0.0.0",
    private: true,
    scripts: { dev: "wrangler dev", deploy: "wrangler deploy" },
    devDependencies: { wrangler: "^4.0.0" },
  },
  null,
  2,
);

const fixtureDir = async (): Promise<string> => {
  const parent = await mkdtemp(join(tmpdir(), "create-baerly-bolt-"));
  const dir = join(parent, "stock-wrangler");
  await mkdir(dir);
  await writeFile(join(dir, "wrangler.jsonc"), STOCK_WRANGLER);
  await writeFile(join(dir, "package.json"), STOCK_PACKAGE_JSON);
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src", "index.ts"), `// stock wrangler create hello world\n`);
  return dir;
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

describe("boltOnExistingWrangler", () => {
  test("patches wrangler.jsonc, seeds .dev.vars, writes baerly.config.ts, leaves src/index.ts alone", async () => {
    const dir = await fixtureDir();
    const result = await boltOnExistingWrangler({
      outDir: dir,
      tenant: "default",
      runInstall: false,
    });
    expect(result.app).toBe("test-app");

    const wrangler = await readFile(join(dir, "wrangler.jsonc"), "utf8");
    expect(wrangler).toContain(`"binding": "BUCKET"`);
    expect(wrangler).toContain(`"bucket_name": "test-app"`);
    expect(wrangler).toContain(`"TENANT": "default"`);

    await expect(fileExists(join(dir, ".dev.vars"))).resolves.toBe(true);
    const devVars = await readFile(join(dir, ".dev.vars"), "utf8");
    expect(devVars).toContain("SHARED_SECRET=");

    await expect(fileExists(join(dir, "baerly.config.ts"))).resolves.toBe(true);
    const config = await readFile(join(dir, "baerly.config.ts"), "utf8");
    expect(config).toContain(`app: "test-app"`);

    const idx = await readFile(join(dir, "src", "index.ts"), "utf8");
    expect(idx).toBe("// stock wrangler create hello world\n");

    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.["baerly-storage"]).toBeDefined();

    expect(result.snippet).toContain(`baerlyWorker<AppEnv>`);
    expect(result.snippetTarget).toBe("src/index.ts");
  });

  test("re-running is idempotent", async () => {
    const dir = await fixtureDir();
    await boltOnExistingWrangler({ outDir: dir, tenant: "default", runInstall: false });
    const wranglerAfterFirst = await readFile(join(dir, "wrangler.jsonc"), "utf8");

    const second = await boltOnExistingWrangler({
      outDir: dir,
      tenant: "default",
      runInstall: false,
    });
    const wranglerAfterSecond = await readFile(join(dir, "wrangler.jsonc"), "utf8");
    expect(wranglerAfterSecond).toBe(wranglerAfterFirst);
    expect(second.changes).toEqual([]);
  });

  test("preserves an existing .dev.vars (skip-if-exists)", async () => {
    const dir = await fixtureDir();
    await writeFile(join(dir, ".dev.vars"), "SHARED_SECRET=user-already-set\n");
    await boltOnExistingWrangler({ outDir: dir, tenant: "default", runInstall: false });
    const devVars = await readFile(join(dir, ".dev.vars"), "utf8");
    expect(devVars).toBe("SHARED_SECRET=user-already-set\n");
  });

  test("appends .dev.vars to .gitignore when absent", async () => {
    const dir = await fixtureDir();
    await writeFile(join(dir, ".gitignore"), "node_modules\n");
    await boltOnExistingWrangler({ outDir: dir, tenant: "default", runInstall: false });
    const gi = await readFile(join(dir, ".gitignore"), "utf8");
    expect(gi).toContain(".dev.vars");
  });

  test("does NOT duplicate .dev.vars when already covered by .env*.local pattern", async () => {
    const dir = await fixtureDir();
    await writeFile(join(dir, ".gitignore"), ".dev.vars\nnode_modules\n");
    await boltOnExistingWrangler({ outDir: dir, tenant: "default", runInstall: false });
    const gi = await readFile(join(dir, ".gitignore"), "utf8");
    const matches = gi.split("\n").filter((l) => l === ".dev.vars").length;
    expect(matches).toBe(1);
  });

  test("preserves an existing baerly.config.ts without --force", async () => {
    const dir = await fixtureDir();
    const existing = `// user-authored config\nexport default { app: "user-app", tenant: "x", target: "cloudflare" };\n`;
    await writeFile(join(dir, "baerly.config.ts"), existing);
    await boltOnExistingWrangler({ outDir: dir, tenant: "default", runInstall: false });
    const after = await readFile(join(dir, "baerly.config.ts"), "utf8");
    expect(after).toBe(existing);
  });

  test("overwrites baerly.config.ts when --force passed", async () => {
    const dir = await fixtureDir();
    await writeFile(join(dir, "baerly.config.ts"), "// old\n");
    await boltOnExistingWrangler({
      outDir: dir,
      tenant: "default",
      force: true,
      runInstall: false,
    });
    const after = await readFile(join(dir, "baerly.config.ts"), "utf8");
    expect(after).toContain(`app: "test-app"`);
  });
});
