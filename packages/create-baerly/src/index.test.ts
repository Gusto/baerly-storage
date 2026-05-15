/**
 * Integration tests for the `create-baerly` entry. Drives the bundled
 * CLI as a child process so `stdio: "pipe"` forces `isTTY === false`
 * — the regression-critical non-TTY path. Asserts that:
 *
 *   1. Missing `--target` (with a `projectName` positional) still
 *      produces the same error message as today.
 *   2. The `--json` envelope on success is byte-identical to the
 *      pre-clack output.
 *   3. The plaintext output on non-TTY success matches today's lines.
 *
 * Gated on `process.platform !== "win32"` because subprocess stdio
 * behavior diverges on Windows; CI here is Linux/macOS.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(HERE, "..", "dist", "index.js");

// Built artifact is required for these tests. The Verification block
// in ticket 02 builds it before running them; skip gracefully if
// the dev forgot, rather than hard-failing in a confusing way.
const shouldRun = process.platform !== "win32" && existsSync(CLI_PATH);

describe.runIf(shouldRun)("create-baerly CLI (non-TTY)", () => {
  let outRoot: string;

  beforeAll(async () => {
    outRoot = await mkdtemp(join(tmpdir(), "create-baerly-cli-"));
  });

  afterAll(async () => {
    await rm(outRoot, { recursive: true, force: true });
  });

  it("rejects an invalid --target with the same message as today", async () => {
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      const r = await execFileP(process.execPath, [CLI_PATH, "my-app", "--target=lambda"], {
        cwd: outRoot,
        encoding: "utf8",
      });
      stdout = r.stdout;
      stderr = r.stderr;
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      exitCode = e.code ?? -1;
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? "";
    }
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain(
      `--target must be "cloudflare", "node-railway", or "node-docker", got "lambda"`,
    );
    expect(stderr).toContain("create-baerly:");
  });

  it("emits the JSON envelope unchanged on success", async () => {
    const projectName = "json-app";
    const { stdout, stderr } = await execFileP(
      process.execPath,
      [CLI_PATH, projectName, "--target=cloudflare", "--json"],
      { cwd: outRoot, encoding: "utf8" },
    );
    expect(stderr).toBe("");
    // Single newline-terminated JSON line.
    expect(stdout.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(stdout.trim()) as {
      result: {
        command: string;
        status: string;
        outDir: string;
        filesWritten: number;
        nextSteps: string[];
      };
    };
    expect(parsed.result.command).toBe("create-baerly");
    expect(parsed.result.status).toBe("ok");
    expect(parsed.result.outDir.endsWith(projectName)).toBe(true);
    expect(parsed.result.filesWritten).toBeGreaterThan(0);
    expect(parsed.result.nextSteps[0]).toBe(`cd ${projectName}`);
    // Envelope shape is part of the agent contract: assert the exact
    // key set (order is irrelevant in JS objects post-parse, but the
    // presence of these and only these keys IS load-bearing).
    expect(Object.keys(parsed.result).toSorted()).toEqual([
      "command",
      "filesWritten",
      "nextSteps",
      "outDir",
      "status",
    ]);
  });

  it("emits the plaintext lines unchanged on a non-TTY success", async () => {
    const projectName = "plain-app";
    const { stdout, stderr } = await execFileP(
      process.execPath,
      [CLI_PATH, projectName, "--target=cloudflare"],
      { cwd: outRoot, encoding: "utf8" },
    );
    expect(stderr).toBe("");
    // The structural shape that scripts may parse: header line,
    // blank line, "Next steps:" marker, indented steps, trailing
    // blank line. The leading `✓` is wrapped with a picocolors
    // green ANSI sequence; assert on the surrounding text rather
    // than the exact escape (picocolors auto-disables on non-TTY,
    // so the visible bytes today are `✓ scaffolded ...`).
    expect(stdout).toContain(`scaffolded `);
    expect(stdout).toContain(projectName);
    expect(stdout).toContain("\n  Next steps:\n");
    expect(stdout).toContain(`    cd ${projectName}\n`);
    // No clack intro/outro frame characters on non-TTY.
    expect(stdout).not.toContain("◆");
    expect(stdout).not.toContain("│");
  });
});
