import { describe, test, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv, claudeArgs, runAgent, type Spawner } from "./driver.ts";

describe("claudeArgs", () => {
  test("is hermetic: Write only, no settings, no MCP, no session, never --bare", () => {
    const a = claudeArgs("haiku");
    expect(a).toEqual(expect.arrayContaining(["--tools", "Write", "--strict-mcp-config"]));
    expect(a).toContain("--no-session-persistence");
    expect(a[a.indexOf("--setting-sources") + 1]).toBe("");
    expect(a[a.indexOf("--model") + 1]).toBe("haiku");
    expect(a).not.toContain("--bare");
  });
});

describe("childEnv", () => {
  test("drops CLAUDECODE and API credentials and keeps the rest", () => {
    const e = childEnv({
      CLAUDECODE: "1",
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_AUTH_TOKEN: "t",
      PATH: "/bin",
    });
    expect(e["CLAUDECODE"]).toBeUndefined();
    expect(e["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(e["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
    expect(e["PATH"]).toBe("/bin");
  });
});

describe("runAgent with a fake spawner", () => {
  test("passes surface+task on stdin, runs in the sandbox, returns solution.ts", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "eval-sbx-"));
    let seen: { cmd: string; cwd: string; input: string; env: NodeJS.ProcessEnv } | undefined;
    const fake: Spawner = async (cmd, _args, o) => {
      seen = { cmd, cwd: o.cwd, input: o.input, env: o.env };
      writeFileSync(join(o.cwd, "solution.ts"), "export async function main(db){return 1}");
      return { status: 0, stdout: "", stderr: "" };
    };
    const r = await runAgent({
      surface: "SURFACE TEXT",
      prompt: "TASK TEXT",
      model: "haiku",
      sandboxDir: sandbox,
      spawner: fake,
    });
    expect(seen?.cmd).toBe("claude");
    expect(seen?.cwd).toBe(sandbox);
    expect(seen?.input).toContain("SURFACE TEXT");
    expect(seen?.input).toContain("TASK TEXT");
    expect(seen?.env["CLAUDECODE"]).toBeUndefined();
    expect(r.error).toBeNull();
    expect(readFileSync(r.solutionPath!, "utf8")).toContain("main(db)");
  });

  test("reports a CLI failure and no solution", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "eval-sbx-"));
    const fake: Spawner = async () => ({ status: 1, stdout: "", stderr: "not logged in" });
    const r = await runAgent({
      surface: "s",
      prompt: "p",
      model: "opus",
      sandboxDir: sandbox,
      spawner: fake,
    });
    expect(r.solutionPath).toBeNull();
    expect(r.error).toMatch(/not logged in/);
  });
});
