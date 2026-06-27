/**
 * In-process tests for the `create-baerly-storage` runner. Drives `runCreateBaerly`
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
 *   7. --with=agent-rules is rejected in scaffold mode with a default-on
 *      bolt-on explanation.
 *   8. Bolt-on mode writes agent rules by default, preserves existing
 *      AGENTS.md content, and honors --no-agent-rules.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { GitRunner } from "./git.ts";
import { runCreateBaerly } from "./runner.ts";

// This whole file is real-subprocess + full-template-copy integration:
// `runCreateBaerly` copies ~129 template files and shells out to git. In
// isolation that's ~1.7s, but under the full fork-pool suite the spawns +
// FS I/O starve past vitest's 5s default `testTimeout` (`vitest.config.ts`)
// — a timeout here is load, not a real hang. 30s matches the repo's
// integration floor (`maintenance-e2e`, `reads-pure`, the `MINIO=1`
// global). `hookTimeout` too: the `mkdtemp` in `freshTmpdir` and the
// recursive `rm` in `afterEach` are I/O that can also starve.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * `it.skipIf` guard for the integration tests that shell out to real
 * git. CI runners and dev machines all have git, but it's worth being
 * explicit so the file passes on a barebones host.
 */
const hasGit = spawnSync("git", ["--version"]).status === 0;

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

describe("create-baerly-storage runner (non-TTY)", () => {
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
    expect(err).toContain("create-baerly-storage:");
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
    expect(parsed.result.command).toBe("create-baerly-storage");
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
    expect(err).toContain("Available add-ons:");
    expect(err).toContain("docker");
    expect(err).toContain("agent-rules");
  });

  test("rejects --with=agent-rules in scaffold mode (default-on bolt-on compatibility token)", async () => {
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runCreateBaerly([
        "agent-rules-on-scaffold",
        "--target=cloudflare",
        "--with=agent-rules",
      ]);
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    const err = stderr.captured.join("");
    expect(err).toContain("--with=agent-rules is unnecessary in scaffold mode");
    expect(err).toContain("--no-agent-rules");
    expect(err).toContain("Scaffolded apps already include");
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
    // Pin npm_config_user_agent so detectPm() resolves to "npm" regardless
    // of which PM ran this suite. Same save/restore shape as pm-detect.test.ts.
    const savedUA = process.env["npm_config_user_agent"];
    process.env["npm_config_user_agent"] = "npm/10.5.0 node/v24.0.0 darwin x64";
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
      if (savedUA === undefined) {
        delete process.env["npm_config_user_agent"];
      } else {
        process.env["npm_config_user_agent"] = savedUA;
      }
    }
    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cwd.endsWith(projectName)).toBe(true);
    expect(calls[0]!.pm).toBe("npm");
  });

  test("warns but exits 0 when the installer reports a non-zero code", async () => {
    const projectName = "fail-install-app";
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    // Pin npm_config_user_agent so the recovery hint reads `npm install …`
    // regardless of which PM ran this suite.
    const savedUA = process.env["npm_config_user_agent"];
    process.env["npm_config_user_agent"] = "npm/10.5.0 node/v24.0.0 darwin x64";
    let exitCode: number;
    try {
      exitCode = await runCreateBaerly([projectName, "--target=cloudflare", "--install"], {
        installer: { run: async () => ({ code: 7 }) },
      });
    } finally {
      stdout.restore();
      stderr.restore();
      if (savedUA === undefined) {
        delete process.env["npm_config_user_agent"];
      } else {
        process.env["npm_config_user_agent"] = savedUA;
      }
    }
    // Scaffold succeeded; only the install failed. The directory is on
    // disk and the user can re-run install themselves, so we don't roll
    // back. We exit 0 but write a visible warning to stderr.
    expect(exitCode).toBe(0);
    const err = stderr.captured.join("");
    expect(err).toContain("install exited with code 7");
    // Recovery hint: the warning must also tell the user how to retry by hand.
    expect(err).toContain("npm install");
    expect(err).toContain("manually");
  });
});

/**
 * Tests for the optional post-scaffold `git init` + initial commit.
 * Each test gets its own tmpdir so one test's `git init` doesn't bleed
 * into another's "fresh tmpdir" assertions. The whole block is
 * `skipIf(!hasGit)` so a host without `git` still passes (the runner
 * itself reports `git-not-available` in that case — see the stubbed
 * tests further down).
 */
describe.skipIf(!hasGit)("git init (integration, real git)", () => {
  let originalCwd: string;
  let cleanup: string[] = [];

  beforeEach(() => {
    originalCwd = process.cwd();
    cleanup = [];
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    for (const dir of cleanup) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  const freshTmpdir = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), "create-baerly-git-"));
    cleanup.push(d);
    process.chdir(d);
    return d;
  };

  test("--git on a fresh tmpdir creates .git/, ends on main, with one initial commit", async () => {
    const root = await freshTmpdir();
    const projectName = "git-init-app";
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runCreateBaerly([projectName, "--target=cloudflare", "--git", "--json"]);
    } finally {
      stdout.restore();
      stderr.restore();
    }
    expect(exitCode).toBe(0);
    const outDir = join(root, projectName);
    expect(existsSync(join(outDir, ".git"))).toBe(true);
    // Branch is `main` regardless of which git version is on PATH —
    // the fallback path in `initWithMainBranch` covers gits older
    // than 2.28.
    const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: outDir,
      encoding: "utf8",
    });
    expect(branch.stdout.trim()).toBe("main");
    // Exactly one commit, and its subject matches the rich body's
    // first line.
    const log = spawnSync("git", ["log", "--oneline"], { cwd: outDir, encoding: "utf8" });
    const lines = log.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Initial commit (by create-baerly-storage)");
    // The commit body must include the version + target + starter
    // stamps so a future user can grep `git log` for them.
    const body = spawnSync("git", ["log", "-1", "--format=%B"], {
      cwd: outDir,
      encoding: "utf8",
    });
    expect(body.stdout).toContain("create-baerly-storage = ");
    expect(body.stdout).toContain(`project name  = ${projectName}`);
    expect(body.stdout).toContain("target        = cloudflare");
    expect(body.stdout).toContain("starter       = minimal");
  });

  test("--no-git does not create .git/", async () => {
    const root = await freshTmpdir();
    const projectName = "no-git-app";
    const stdout = captureStream(process.stdout);
    try {
      const code = await runCreateBaerly([
        projectName,
        "--target=cloudflare",
        "--no-git",
        "--json",
      ]);
      expect(code).toBe(0);
    } finally {
      stdout.restore();
    }
    expect(existsSync(join(root, projectName, ".git"))).toBe(false);
  });

  test("default (no --git flag, non-TTY) does not run git", async () => {
    // Mirrors the `install` flag default: in flag-driven mode, the
    // step is opt-in. CI/agents that have never passed `--git` see
    // no behaviour change.
    const root = await freshTmpdir();
    const projectName = "default-no-git-app";
    const stdout = captureStream(process.stdout);
    try {
      const code = await runCreateBaerly([projectName, "--target=cloudflare", "--json"]);
      expect(code).toBe(0);
    } finally {
      stdout.restore();
    }
    expect(existsSync(join(root, projectName, ".git"))).toBe(false);
  });

  test("--git inside an existing git repo silently skips re-init", async () => {
    // Parent tmpdir is itself a git repo (e.g. the user is scaffolding
    // into an existing monorepo). The scaffold proceeds, but git init
    // is skipped — nested repos are a footgun and the host repo owns
    // the history.
    const root = await freshTmpdir();
    const initRoot = spawnSync("git", ["init", "--initial-branch=main"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(initRoot.status).toBe(0);
    const projectName = "nested-app";
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    try {
      const code = await runCreateBaerly([projectName, "--target=cloudflare", "--git", "--json"]);
      expect(code).toBe(0);
    } finally {
      stdout.restore();
      stderr.restore();
    }
    // No nested .git inside the scaffolded sub-directory.
    expect(existsSync(join(root, projectName, ".git"))).toBe(false);
    // And the parent repo still has no commits — `git add .` was never
    // called on it (silent skip).
    const log = spawnSync("git", ["log", "--oneline"], { cwd: root, encoding: "utf8" });
    expect(log.status).not.toBe(0); // exit 128 on an empty repo
    // The skip is silent — no "git init skipped" warning leaks to stderr.
    expect(stderr.captured.join("")).not.toContain("git init skipped");
  });
});

describe("create-baerly-storage runner — bolt-on dispatch (non-TTY)", () => {
  let outRoot: string;
  let originalCwd: string;

  beforeAll(async () => {
    outRoot = await mkdtemp(join(tmpdir(), "create-baerly-bolton-"));
  });

  afterAll(async () => {
    await rm(outRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  test("dispatches bolt-on when wrangler.jsonc exists in the outDir", async () => {
    const dir = join(outRoot, "wrangler-dir-1");
    await mkdir(dir);
    await writeFile(
      join(dir, "wrangler.jsonc"),
      `{
  "name": "test-app",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-24"
}
`,
    );
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "test-app", version: "0.0.0", private: true }, null, 2),
    );
    process.chdir(dir);
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runCreateBaerly([".", "--tenant=default"]);
    } finally {
      stdout.restore();
      stderr.restore();
    }
    expect(stderr.captured.join("")).toBe("");
    expect(exitCode).toBe(0);
    const out = stdout.captured.join("");
    expect(out).toContain("bolted baerly onto");
    expect(out).toContain(`baerlyWorker<AppEnv>`);
    expect(out).toContain("Paste this into src/index.ts");
    expect(existsSync(join(dir, "baerly.config.ts"))).toBe(true);
  });

  test("rejects --target=node when wrangler.jsonc is present", async () => {
    const dir = join(outRoot, "wrangler-dir-2");
    await mkdir(dir);
    await writeFile(
      join(dir, "wrangler.jsonc"),
      `{ "name": "x", "main": "src/index.ts", "compatibility_date": "2026-05-24" }`,
    );
    process.chdir(dir);
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runCreateBaerly([".", "--target=node"]);
    } finally {
      stdout.restore();
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    expect(stderr.captured.join("")).toMatch(/detected wrangler\.jsonc but --target=node/);
  });

  test("bolt-on writes the AGENTS.md router by default (no --with flag)", async () => {
    const dir = join(outRoot, "bolton-default-agent-rules");
    await mkdir(dir);
    await writeFile(
      join(dir, "wrangler.jsonc"),
      `{ "name": "test-app", "main": "src/index.ts", "compatibility_date": "2026-05-24" }`,
    );
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "test-app", version: "0.0.0", private: true }, null, 2),
    );
    process.chdir(dir);
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runCreateBaerly([".", "--json"]);
    } finally {
      stdout.restore();
      stderr.restore();
    }
    expect(stderr.captured.join("")).toBe("");
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout.captured.join("").trim()) as {
      result: { agentRules?: { path: string; action: string } };
    };
    // Default-on: agentRules block should be written.
    expect(out.result.agentRules).toBeDefined();
    expect(out.result.agentRules?.action).toBe("created");
    // The AGENTS.md file should exist with the managed sentinel.
    const agentsPath = join(dir, "AGENTS.md");
    expect(existsSync(agentsPath)).toBe(true);
    const { readFile: rf } = await import("node:fs/promises");
    const content = await rf(agentsPath, "utf8");
    expect(content).toContain("<!-- baerly:start -->");
    expect(content).toContain("<!-- baerly:end -->");
  });

  test("bolt-on preserves a pre-existing user AGENTS.md on the default-on path", async () => {
    const dir = join(outRoot, "bolton-preserve-agent-rules");
    await mkdir(dir);
    await writeFile(
      join(dir, "wrangler.jsonc"),
      `{ "name": "test-app", "main": "src/index.ts", "compatibility_date": "2026-05-24" }`,
    );
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "test-app", version: "0.0.0", private: true }, null, 2),
    );
    // User already has a hand-authored AGENTS.md — the default-on path
    // (`args["agent-rules"] !== false`, no flag passed) must NOT clobber it.
    const userContent = "# My App\n\nHand-authored rules the user wrote.\n";
    await writeFile(join(dir, "AGENTS.md"), userContent);
    process.chdir(dir);
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runCreateBaerly([".", "--json"]);
    } finally {
      stdout.restore();
      stderr.restore();
    }
    expect(stderr.captured.join("")).toBe("");
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout.captured.join("").trim()) as {
      result: { agentRules?: { path: string; action: string } };
    };
    // Default-on path ran and appended (file already existed).
    expect(out.result.agentRules).toBeDefined();
    expect(out.result.agentRules?.action).toBe("appended");
    // The user's original content survives byte-identical at the front,
    // and the managed baerly block is added.
    const { readFile: rf } = await import("node:fs/promises");
    const content = await rf(join(dir, "AGENTS.md"), "utf8");
    expect(content.startsWith(userContent)).toBe(true);
    expect(content).toContain("<!-- baerly:start -->");
    expect(content).toContain("<!-- baerly:end -->");
  });

  test("bolt-on skips the AGENTS.md router when --no-agent-rules is passed", async () => {
    const dir = join(outRoot, "bolton-no-agent-rules");
    await mkdir(dir);
    await writeFile(
      join(dir, "wrangler.jsonc"),
      `{ "name": "test-app", "main": "src/index.ts", "compatibility_date": "2026-05-24" }`,
    );
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "test-app", version: "0.0.0", private: true }, null, 2),
    );
    process.chdir(dir);
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runCreateBaerly([".", "--no-agent-rules", "--json"]);
    } finally {
      stdout.restore();
      stderr.restore();
    }
    expect(stderr.captured.join("")).toBe("");
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout.captured.join("").trim()) as {
      result: { agentRules?: unknown };
    };
    // --no-agent-rules: no block should be written.
    expect(out.result.agentRules).toBeUndefined();
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(dir, ".claude", "rules", "baerly.md"))).toBe(false);
  });
});

describe("git init (stubbed GitRunner)", () => {
  let outRoot: string;
  let originalCwd: string;

  beforeAll(async () => {
    outRoot = await mkdtemp(join(tmpdir(), "create-baerly-git-stub-"));
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

  /**
   * Build a `GitRunner` stub that returns canned responses per
   * argv-prefix. The first matching prefix wins; unmatched calls
   * default to `{ code: 0, stdout: "", stderr: "" }` so the stub is
   * easy to read at the call site.
   */
  const stubRunner = (
    canned: ReadonlyArray<{
      readonly when: readonly string[];
      readonly result: { code: number; stdout?: string; stderr?: string };
    }>,
  ): GitRunner => ({
    run: (args) => {
      for (const c of canned) {
        const matches = c.when.every((w, i) => args[i] === w);
        if (matches) {
          return {
            code: c.result.code,
            stdout: c.result.stdout ?? "",
            stderr: c.result.stderr ?? "",
          };
        }
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });

  test("warns but exits 0 when `git --version` fails (binary not on PATH)", async () => {
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runCreateBaerly(
        ["no-git-binary", "--target=cloudflare", "--git", "--json"],
        {
          gitRunner: stubRunner([
            { when: ["--version"], result: { code: 127, stderr: "spawn git ENOENT" } },
          ]),
        },
      );
    } finally {
      stdout.restore();
      stderr.restore();
    }
    expect(exitCode).toBe(0);
    const err = stderr.captured.join("");
    expect(err).toContain("git init skipped");
    expect(err).toContain("git is not installed");
    // Scaffold still wrote the project — the git step is best-effort.
    expect(existsSync(join(outRoot, "no-git-binary", "package.json"))).toBe(true);
    expect(existsSync(join(outRoot, "no-git-binary", ".git"))).toBe(false);
  });

  test("warns but exits 0 when git user.name / user.email are unset", async () => {
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runCreateBaerly(["no-identity", "--target=cloudflare", "--git", "--json"], {
        gitRunner: stubRunner([
          { when: ["--version"], result: { code: 0, stdout: "git version 2.54.0\n" } },
          { when: ["rev-parse", "--is-inside-work-tree"], result: { code: 128 } },
          { when: ["config", "user.name"], result: { code: 1, stdout: "" } },
          { when: ["config", "user.email"], result: { code: 1, stdout: "" } },
        ]),
      });
    } finally {
      stdout.restore();
      stderr.restore();
    }
    expect(exitCode).toBe(0);
    const err = stderr.captured.join("");
    expect(err).toContain("git init skipped");
    expect(err).toContain("user.name");
    expect(existsSync(join(outRoot, "no-identity", "package.json"))).toBe(true);
    expect(existsSync(join(outRoot, "no-identity", ".git"))).toBe(false);
  });
});
