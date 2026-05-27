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

  test("does NOT duplicate .dev.vars when already present literally", async () => {
    const dir = await fixtureDir();
    await writeFile(join(dir, ".gitignore"), ".dev.vars\nnode_modules\n");
    await boltOnExistingWrangler({ outDir: dir, tenant: "default", runInstall: false });
    const gi = await readFile(join(dir, ".gitignore"), "utf8");
    const matches = gi.split("\n").filter((l) => l === ".dev.vars").length;
    expect(matches).toBe(1);
  });

  test("does NOT add .dev.vars when .gitignore has a recognised cover pattern (.env*.local)", async () => {
    const dir = await fixtureDir();
    await writeFile(join(dir, ".gitignore"), ".env*.local\nnode_modules\n");
    await boltOnExistingWrangler({ outDir: dir, tenant: "default", runInstall: false });
    const gi = await readFile(join(dir, ".gitignore"), "utf8");
    const matches = gi.split("\n").filter((l) => l === ".dev.vars").length;
    expect(matches).toBe(0);
    expect(gi).toContain(".env*.local");
  });

  test("does NOT add .dev.vars when .gitignore has .dev.vars* (wrangler-create default)", async () => {
    const dir = await fixtureDir();
    await writeFile(join(dir, ".gitignore"), ".dev.vars*\n!.dev.vars.example\n.wrangler/\n");
    await boltOnExistingWrangler({ outDir: dir, tenant: "default", runInstall: false });
    const gi = await readFile(join(dir, ".gitignore"), "utf8");
    const matches = gi.split("\n").filter((l) => l === ".dev.vars").length;
    expect(matches).toBe(0);
    expect(gi).toContain(".dev.vars*");
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

  test("throws InvalidConfig when package.json is not valid JSON", async () => {
    const dir = await fixtureDir();
    await writeFile(join(dir, "package.json"), "{ not json");
    await expect(
      boltOnExistingWrangler({ outDir: dir, tenant: "default", runInstall: false }),
    ).rejects.toThrow(/package\.json is not valid JSON/);
  });
});

describe("boltOnExistingWrangler --with=agent-rules", () => {
  test("without agentRules, no agent file is created or modified", async () => {
    const dir = await fixtureDir();
    const result = await boltOnExistingWrangler({
      outDir: dir,
      tenant: "default",
      runInstall: false,
    });
    await expect(fileExists(join(dir, "AGENTS.md"))).resolves.toBe(false);
    await expect(fileExists(join(dir, ".claude", "rules", "baerly.md"))).resolves.toBe(false);
    await expect(fileExists(join(dir, ".cursor", "rules", "baerly.md"))).resolves.toBe(false);
    expect(result.agentRules).toBeUndefined();
    expect(result.changes.some((c) => c.includes("agent-rules"))).toBe(false);
  });

  test("creates AGENTS.md when no agent file or rules dir exists", async () => {
    const dir = await fixtureDir();
    const result = await boltOnExistingWrangler({
      outDir: dir,
      tenant: "default",
      runInstall: false,
      agentRules: true,
    });
    expect(result.agentRules).toEqual({
      path: join(dir, "AGENTS.md"),
      action: "created",
    });
    const agents = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(agents).toContain("<!-- baerly:start -->");
    expect(agents).toContain("<!-- baerly:end -->");
    expect(agents).toContain("baerly-storage");
    expect(agents).toContain("node_modules/baerly-storage/dist/API.md");
    expect(result.changes).toContain("AGENTS.md: created agent-rules block");
  });

  test("appends to a pre-existing AGENTS.md without touching the user's content", async () => {
    const dir = await fixtureDir();
    const userContent = "# My agent rules\n\nDo the thing.\n";
    await writeFile(join(dir, "AGENTS.md"), userContent);
    const result = await boltOnExistingWrangler({
      outDir: dir,
      tenant: "default",
      runInstall: false,
      agentRules: true,
    });
    expect(result.agentRules?.action).toBe("appended");
    const after = await readFile(join(dir, "AGENTS.md"), "utf8");
    // User content is byte-identical at the front of the file.
    expect(after.startsWith(userContent)).toBe(true);
    expect(after).toContain("<!-- baerly:start -->");
    expect(after).toContain("<!-- baerly:end -->");
  });

  test("writes to .claude/rules/baerly.md when that directory exists", async () => {
    const dir = await fixtureDir();
    await mkdir(join(dir, ".claude", "rules"), { recursive: true });
    const result = await boltOnExistingWrangler({
      outDir: dir,
      tenant: "default",
      runInstall: false,
      agentRules: true,
    });
    expect(result.agentRules?.path).toBe(join(dir, ".claude", "rules", "baerly.md"));
    expect(result.agentRules?.action).toBe("created");
    await expect(fileExists(join(dir, "AGENTS.md"))).resolves.toBe(false);
    await expect(fileExists(join(dir, ".claude", "rules", "baerly.md"))).resolves.toBe(true);
  });

  test("writes to .cursor/rules/baerly.md when only .cursor/rules exists", async () => {
    const dir = await fixtureDir();
    await mkdir(join(dir, ".cursor", "rules"), { recursive: true });
    const result = await boltOnExistingWrangler({
      outDir: dir,
      tenant: "default",
      runInstall: false,
      agentRules: true,
    });
    expect(result.agentRules?.path).toBe(join(dir, ".cursor", "rules", "baerly.md"));
    await expect(fileExists(join(dir, "AGENTS.md"))).resolves.toBe(false);
  });

  test("second run is idempotent — block replaced in place, file not doubled", async () => {
    const dir = await fixtureDir();
    const userContent = "# My agent rules\n\nDo the thing.\n";
    await writeFile(join(dir, "AGENTS.md"), userContent);
    await boltOnExistingWrangler({
      outDir: dir,
      tenant: "default",
      runInstall: false,
      agentRules: true,
    });
    const afterFirst = await readFile(join(dir, "AGENTS.md"), "utf8");

    const second = await boltOnExistingWrangler({
      outDir: dir,
      tenant: "default",
      runInstall: false,
      agentRules: true,
    });
    const afterSecond = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(afterSecond).toBe(afterFirst);
    expect(second.agentRules?.action).toBe("replaced");
    // The managed block appears exactly once.
    const startCount = afterSecond.split("<!-- baerly:start -->").length - 1;
    expect(startCount).toBe(1);
  });
});
