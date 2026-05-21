/**
 * In-process tests for the `create-baerly` runner. Drives `runCreateBaerly`
 * directly so we don't depend on `dist/index.js` being current. Vitest
 * forks have no TTY (`process.stdin.isTTY === undefined`), so the wizard
 * branch is unreachable — same property the prior subprocess test got
 * from `stdio: "pipe"`.
 *
 * Asserts:
 *   1. Invalid --target produces the same error message as today.
 *   2. The --json envelope on success is byte-identical to the
 *      pre-refactor output.
 *   3. The plaintext output on non-TTY success matches today's lines.
 *   4. --with=docker scaffolds the three docker files on --target=node.
 *   5. --with=docker on --target=cloudflare is rejected with an
 *      actionable message.
 *   6. --with=junk lists the available add-ons.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { runCreateBaerly } from "./runner.ts";

const captureStream = (
  stream: NodeJS.WriteStream,
): { restore: () => void; readonly captured: string[] } => {
  const captured: string[] = [];
  const original = stream.write.bind(stream);
  stream.write = ((chunk: unknown): boolean => {
    captured.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof stream.write;
  return {
    captured,
    restore: () => {
      stream.write = original;
    },
  };
};

describe("create-baerly runner (non-TTY)", () => {
  let outRoot: string;
  let originalCwd: string;

  beforeAll(async () => {
    outRoot = await mkdtemp(join(tmpdir(), "create-baerly-runner-"));
  });

  afterAll(async () => {
    await rm(outRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    originalCwd = process.cwd();
    process.chdir(outRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  test("rejects an invalid --target at parse time", async () => {
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runCreateBaerly(["my-app", "--target=lambda"]);
    } finally {
      stdout.restore();
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    expect(stdout.captured.join("")).toBe("");
    const err = stderr.captured.join("");
    // citty 0.2.2's `type: "enum"` rejects invalid values at parse time
    // with this wording.
    expect(err).toMatch(/Invalid value for argument.*--target/);
    expect(err).toContain("create-baerly:");
  });

  test("emits the JSON envelope unchanged on success", async () => {
    const projectName = "json-app";
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runCreateBaerly([projectName, "--target=cloudflare", "--json"]);
    } finally {
      stdout.restore();
      stderr.restore();
    }
    expect(exitCode).toBe(0);
    expect(stderr.captured.join("")).toBe("");
    const out = stdout.captured.join("");
    expect(out.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(out.trim()) as {
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
    expect(Object.keys(parsed.result).toSorted()).toEqual([
      "command",
      "filesWritten",
      "nextSteps",
      "outDir",
      "status",
    ]);
  });

  test("accepts --with=docker on --target=node and emits the Dockerfile", async () => {
    const projectName = "with-docker";
    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runCreateBaerly([projectName, "--target=node", "--with=docker", "--json"]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.captured.join("").trim()) as {
      result: { status: string; outDir: string; filesWritten: number };
    };
    expect(parsed.result.status).toBe("ok");
    expect(existsSync(join(parsed.result.outDir, "Dockerfile"))).toBe(true);
    expect(existsSync(join(parsed.result.outDir, "healthcheck.js"))).toBe(true);
    expect(existsSync(join(parsed.result.outDir, ".dockerignore"))).toBe(true);
  });

  test("rejects --with=docker on --target=cloudflare with an actionable message", async () => {
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runCreateBaerly(["docker-on-cf", "--target=cloudflare", "--with=docker"]);
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    const err = stderr.captured.join("");
    expect(err).toContain("--with=docker only applies to --target=node");
    expect(err).toContain("--target=cloudflare");
  });

  test("rejects --with=junk with an actionable message", async () => {
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runCreateBaerly(["junk-addon", "--target=node", "--with=junk"]);
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    const err = stderr.captured.join("");
    expect(err).toContain(`Unknown add-on "junk"`);
    expect(err).toContain("Available add-ons: docker");
  });

  test("emits the plaintext lines unchanged on a non-TTY success", async () => {
    const projectName = "plain-app";
    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runCreateBaerly([projectName, "--target=cloudflare"]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const out = stdout.captured.join("");
    expect(out).toContain(`scaffolded `);
    expect(out).toContain(projectName);
    expect(out).toContain("\n  Next steps:\n");
    expect(out).toContain(`    cd ${projectName}\n`);
    expect(out).not.toContain("◆");
    expect(out).not.toContain("│");
  });

  test("does not call the installer when --install is not passed", async () => {
    const projectName = "no-install-app";
    const calls: Array<{ pm: string; cwd: string }> = [];
    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runCreateBaerly([projectName, "--target=cloudflare", "--json"], {
        installer: {
          run: async (pm, cwd) => {
            calls.push({ pm, cwd });
            return { code: 0 };
          },
        },
      });
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    expect(calls).toEqual([]);
  });

  test("calls the installer in outDir when --install is passed", async () => {
    const projectName = "yes-install-app";
    const calls: Array<{ pm: string; cwd: string }> = [];
    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runCreateBaerly(
        [projectName, "--target=cloudflare", "--install", "--json"],
        {
          installer: {
            run: async (pm, cwd) => {
              calls.push({ pm, cwd });
              return { code: 0 };
            },
          },
        },
      );
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cwd.endsWith(projectName)).toBe(true);
  });

  test("warns but exits 0 when the installer reports a non-zero code", async () => {
    const projectName = "fail-install-app";
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runCreateBaerly([projectName, "--target=cloudflare", "--install"], {
        installer: { run: async () => ({ code: 7 }) },
      });
    } finally {
      stdout.restore();
      stderr.restore();
    }
    // Scaffold succeeded; only the install failed. The directory is on
    // disk and the user can re-run install themselves, so we don't roll
    // back. We exit 0 but write a visible warning to stderr.
    expect(exitCode).toBe(0);
    const err = stderr.captured.join("");
    expect(err).toContain("install exited with code 7");
  });
});
