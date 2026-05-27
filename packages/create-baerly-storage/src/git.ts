/**
 * Optional post-scaffold `git init` + initial commit. Mirrors what
 * `create-vite`, `create-next-app`, and Cloudflare's `c3` already do
 * — gives the user (and any subsequent diff-driven workflow, human
 * or agent) a clean baseline-vs-HEAD diff for their first edits.
 *
 * Skips silently when:
 *   - `outDir` is already inside a git work tree (nested repos confuse
 *     more than they help; the user is scaffolding into an existing
 *     workspace and the host repo owns the history).
 *   - `git` is not installed (`git --version` fails).
 *   - No global `user.name` / `user.email` is configured (the commit
 *     would fail anyway; better to skip with a clear warning than to
 *     leave a half-initialised `.git/` behind).
 *
 * DI'd via `GitRunner` so tests can stub spawning. The default impl
 * shells out via `spawnSync` (short calls; no need for the async
 * pump). Mirrors the `Installer` DI seam in `install.ts`.
 */
import { spawnSync } from "node:child_process";
import type { Pm } from "./pm-detect.ts";

export interface GitRunner {
  /**
   * Run `git <args>` in `cwd`. Returns the child's exit code and
   * captured stdout/stderr. Never throws on a non-zero exit — callers
   * branch on `code`. A missing `git` binary surfaces as `code: 127`
   * with the spawn error on `stderr`, so callers don't need a separate
   * try/catch for ENOENT.
   */
  run(args: readonly string[], cwd: string): { code: number; stdout: string; stderr: string };
}

export const defaultGitRunner: GitRunner = {
  run: (args, cwd) => {
    const res = spawnSync("git", [...args], { cwd, encoding: "utf8" });
    if (res.error !== undefined) {
      return { code: 127, stdout: "", stderr: res.error.message };
    }
    return {
      code: res.status ?? 1,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
    };
  },
};

export type GitInitOutcome =
  | { readonly initialized: true; readonly branch: "main" }
  | {
      readonly initialized: false;
      readonly reason:
        | "already-in-repo"
        | "git-not-available"
        | "no-identity"
        | "init-failed"
        | "add-failed"
        | "commit-failed";
      readonly message?: string;
    };

export interface GitInitDetails {
  /** Absolute path to the freshly-scaffolded directory. */
  readonly outDir: string;
  /** `create-baerly` package version. Stamped into the commit body. */
  readonly cliVersion: string;
  /** Substituted `appName` sentinel from the scaffold. */
  readonly appName: string;
  readonly target: "cloudflare" | "node";
  readonly starter: "minimal" | "react";
  readonly pm: Pm;
  /** Optional; resolved by the runner via `probePmVersion()`. */
  readonly pmVersion?: string;
}

const trim = (s: string): string => s.trim();

const isInsideGitWorkTree = (cwd: string, runner: GitRunner): boolean => {
  const res = runner.run(["rev-parse", "--is-inside-work-tree"], cwd);
  return res.code === 0 && trim(res.stdout) === "true";
};

const probeGitVersion = (cwd: string, runner: GitRunner): string | undefined => {
  const res = runner.run(["--version"], cwd);
  if (res.code !== 0) {
    return undefined;
  }
  // "git version 2.54.0" — strip the prefix when present, otherwise
  // pass through whatever the shim emitted.
  const m = /^git version (\S+)/.exec(trim(res.stdout));
  return m === null ? trim(res.stdout) : m[1];
};

const hasIdentity = (cwd: string, runner: GitRunner): boolean => {
  const name = runner.run(["config", "user.name"], cwd);
  const email = runner.run(["config", "user.email"], cwd);
  return (
    name.code === 0 &&
    email.code === 0 &&
    trim(name.stdout).length > 0 &&
    trim(email.stdout).length > 0
  );
};

const commitMessage = (details: GitInitDetails, gitVersion: string): string => {
  const pmLine =
    details.pmVersion === undefined ? details.pm : `${details.pm}@${details.pmVersion}`;
  return [
    "Initial commit (by create-baerly)",
    "",
    "Details:",
    `  create-baerly = ${details.cliVersion}`,
    `  project name  = ${details.appName}`,
    `  target        = ${details.target}`,
    `  starter       = ${details.starter}`,
    `  package mgr   = ${pmLine}`,
    `  git           = ${gitVersion}`,
    "",
  ].join("\n");
};

/**
 * `git init --initial-branch=main` is rejected by gits older than
 * 2.28 (released 2020). Fall back to plain `git init` followed by
 * `symbolic-ref HEAD refs/heads/main` so the resulting branch is the
 * same regardless of which git the user has on PATH.
 */
const initWithMainBranch = (
  outDir: string,
  runner: GitRunner,
): { code: number; message: string } => {
  const first = runner.run(["init", "--initial-branch=main"], outDir);
  if (first.code === 0) {
    return { code: 0, message: trim(first.stdout) };
  }
  const fallback = runner.run(["init"], outDir);
  if (fallback.code !== 0) {
    return { code: fallback.code, message: trim(fallback.stderr) };
  }
  const setBranch = runner.run(["symbolic-ref", "HEAD", "refs/heads/main"], outDir);
  return { code: setBranch.code, message: trim(setBranch.stderr) };
};

/**
 * `outDir` must already exist on disk (scaffold has written into it).
 * Probes are all DI'd through the runner, so a test stub controls the
 * whole flow — including the "is this dir inside a repo?" question.
 */
export const initRepoAndCommit = (
  details: GitInitDetails,
  runner: GitRunner = defaultGitRunner,
): GitInitOutcome => {
  const gitVersion = probeGitVersion(details.outDir, runner);
  if (gitVersion === undefined) {
    return { initialized: false, reason: "git-not-available" };
  }
  if (isInsideGitWorkTree(details.outDir, runner)) {
    return { initialized: false, reason: "already-in-repo" };
  }
  if (!hasIdentity(details.outDir, runner)) {
    return { initialized: false, reason: "no-identity" };
  }
  const init = initWithMainBranch(details.outDir, runner);
  if (init.code !== 0) {
    return { initialized: false, reason: "init-failed", message: init.message };
  }
  const add = runner.run(["add", "."], details.outDir);
  if (add.code !== 0) {
    return { initialized: false, reason: "add-failed", message: trim(add.stderr) };
  }
  const commit = runner.run(
    ["commit", "-m", commitMessage(details, gitVersion), "--no-verify"],
    details.outDir,
  );
  if (commit.code !== 0) {
    return { initialized: false, reason: "commit-failed", message: trim(commit.stderr) };
  }
  return { initialized: true, branch: "main" };
};
