import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Outcome of one spawned process. */
export interface SpawnResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SpawnOpts {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly input: string;
  readonly timeoutMs: number;
}

/** Process spawner. The real one runs `claude`; the self-tests inject a fake. */
export type Spawner = (
  cmd: string,
  args: readonly string[],
  opts: SpawnOpts,
) => Promise<SpawnResult>;

export interface RunAgentOpts {
  readonly surface: string;
  readonly prompt: string;
  /** Claude Code model alias (`opus`, `sonnet`, `haiku`) or a full model id. */
  readonly model: string;
  /** Per-run working directory, outside the repo; the agent writes solution.ts here. */
  readonly sandboxDir: string;
  readonly spawner?: Spawner;
  readonly timeoutMs?: number;
}

export interface RunAgentResult {
  readonly solutionPath: string | null;
  /** Non-empty when the CLI exited non-zero or timed out. */
  readonly error: string | null;
}

export const realSpawner: Spawner = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], { cwd: opts.cwd, env: opts.env, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.stdin.end(opts.input);
  });

const INSTRUCTIONS = `You are given the COMPLETE public surface of a library (its API reference and
type declarations) and a task. Write a single file \`solution.ts\` in the current
directory using ONLY the documented API. Do not invent methods that are not in
the surface. Use the Write tool to create solution.ts, then stop. You cannot
read files or run commands; everything you need is below.`;

/**
 * Flags that keep the agent hermetic: only the Write tool, no CLAUDE.md /
 * settings / MCP servers, no persisted session. `--bare` is deliberately
 * absent: it skips keychain reads and so drops the subscription login.
 * `acceptEdits` lets Write run without an interactive prompt.
 */
export function claudeArgs(model: string): string[] {
  return [
    "-p",
    "--tools",
    "Write",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--permission-mode",
    "acceptEdits",
    "--model",
    model,
  ];
}

/** The child must not believe it is nested inside another Claude Code session, and must bill the login. */
export function childEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env["CLAUDECODE"];
  // A set key would silently move billing off the Claude Code login.
  delete env["ANTHROPIC_API_KEY"];
  delete env["ANTHROPIC_AUTH_TOKEN"];
  return env;
}

export async function claudeVersion(spawner: Spawner = realSpawner): Promise<string> {
  const r = await spawner("claude", ["--version"], {
    cwd: process.cwd(),
    env: childEnv(process.env),
    input: "",
    timeoutMs: 30_000,
  });
  if (r.status !== 0) {
    throw new Error(`claude --version failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r.stdout.trim();
}

export async function runAgent(opts: RunAgentOpts): Promise<RunAgentResult> {
  const spawner = opts.spawner ?? realSpawner;
  const input = `${INSTRUCTIONS}\n\n${opts.surface}\n\n===== TASK =====\n${opts.prompt}\n`;
  const r = await spawner("claude", claudeArgs(opts.model), {
    cwd: opts.sandboxDir,
    env: childEnv(process.env),
    input,
    timeoutMs: opts.timeoutMs ?? 600_000,
  });
  const solutionPath = join(opts.sandboxDir, "solution.ts");
  const error =
    r.status === 0
      ? null
      : `claude exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 500)}`;
  return { solutionPath: existsSync(solutionPath) ? solutionPath : null, error };
}
