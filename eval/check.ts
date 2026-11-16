import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawn } from "node:child_process";
import type { Verdict } from "./types.ts";

export interface CheckOpts {
  readonly taskDir: string;
  readonly solutionPath: string;
  /** Set when the caller already ran `typecheckAll` and this solution passed. */
  readonly typechecked?: boolean;
  readonly repoRoot: string;
}

/**
 * Environment for processes that run model-written code (tsgo, the runner):
 * only what node/pnpm need, so credentials in the parent env (AWS_*, CF_*,
 * tokens) never reach it.
 */
export function minimalEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"]) {
    if (base[k] !== undefined) {
      env[k] = base[k];
    }
  }
  return env;
}

interface RunResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
  readonly error?: Error;
}

/** Async spawn with a timeout, so concurrent checks do not block each other. */
function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: minimalEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: null, signal: null, output, error });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({
        status,
        signal,
        output,
        ...(timedOut ? { error: new Error("ETIMEDOUT") } : {}),
      });
    });
  });
}

/** Temp tsconfig mapping the public package to the BUILT dist/*.d.ts (the fed surface).
 * MUST stay faithful to publishConfig.exports and eval/resolve-package.mjs:
 * several subpaths resolve to differently-named dist files (e.g. /config → app-config.d.ts),
 * so a lossy glob would falsely fail typecheck for canonical agent imports.
 */
function writeTsconfig(dir: string, repoRoot: string, solutionPaths: readonly string[]): string {
  const dist = join(repoRoot, "dist");
  // publishConfig.exports subpath → dist .d.ts (keep in sync with resolve-package.mjs)
  const subpathToEntry: Record<string, string> = {
    ".": "index",
    "./auth": "auth",
    "./http": "http",
    "./cloudflare": "cloudflare",
    "./node": "node",
    "./s3": "s3",
    "./gcs": "gcs",
    "./maintenance": "maintenance",
    "./observability": "observability",
    "./config": "app-config",
    "./client": "client",
    "./client/react": "client-react",
    "./dev": "dev",
    "./dev/vite": "dev-vite",
  };
  const pkg = "@gusto/baerly-storage";
  const paths: Record<string, string[]> = {};
  for (const [sub, entry] of Object.entries(subpathToEntry)) {
    const key = sub === "." ? pkg : `${pkg}/${sub.slice(2)}`;
    paths[key] = [join(dist, `${entry}.d.ts`)];
  }
  // Fallback glob for any unlisted subpath (explicit entries above take precedence in TS resolution)
  paths[`${pkg}/*`] = [join(dist, "*.d.ts")];
  const cfg = {
    compilerOptions: {
      module: "esnext",
      target: "es2023",
      moduleResolution: "bundler",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [] as string[],
      paths,
    },
    files: [...solutionPaths],
  };
  const p = join(dir, "tsconfig.json");
  writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

/**
 * One tsgo pass over several solutions. Returns a failing Verdict per solution
 * path that has errors (or all of them when tsgo fails without naming a file).
 */
export async function typecheckAll(
  repoRoot: string,
  solutionPaths: readonly string[],
): Promise<Map<string, Verdict>> {
  const tmp = mkdtempSync(join(tmpdir(), "eval-tsc-"));
  const failures = new Map<string, Verdict>();
  try {
    const tsconfig = writeTsconfig(tmp, repoRoot, solutionPaths);
    const r = await run(
      join(repoRoot, "node_modules", ".bin", "tsgo"),
      ["--noEmit", "--pretty", "false", "-p", tsconfig],
      repoRoot,
      60_000,
    );
    if (r.status === 0 && r.signal == null) {
      return failures;
    }
    const timedOut = r.error?.message === "ETIMEDOUT";
    const prefix = timedOut ? "typecheck timed out:\n" : "typecheck failed:\n";
    const lines = r.output.trim().split("\n");
    // tsgo prints paths relative to the repo root.
    const own = new Map(
      solutionPaths.map((path) => [
        path,
        lines.filter((l) => l.startsWith(relative(repoRoot, path))).slice(0, 8),
      ]),
    );
    const named = [...own].filter(([, l]) => l.length > 0);
    // Errors that name no solution (tool failure) fail every solution.
    const blamed =
      named.length > 0 ? named : solutionPaths.map((p) => [p, lines.slice(0, 8)] as const);
    for (const [path, detail] of blamed) {
      failures.set(path, { pass: false, reason: `${prefix}${detail.join("\n")}` });
    }
    return failures;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function checkSolution(opts: CheckOpts): Promise<Verdict> {
  if (opts.typechecked !== true) {
    const failures = await typecheckAll(opts.repoRoot, [opts.solutionPath]);
    const tcFail = failures.get(opts.solutionPath);
    if (tcFail) {
      return tcFail;
    }
  }

  // Runtime in a subprocess so the dist runtime alias lives in the child, not here.
  const outDir = mkdtempSync(join(tmpdir(), "eval-run-"));
  const outFile = join(outDir, "verdict.json");
  try {
    const r = await run(
      "node",
      [
        "--import",
        join(opts.repoRoot, "bench/register-hooks.mjs"),
        "--import",
        join(opts.repoRoot, "eval/resolve-package.mjs"),
        join(opts.repoRoot, "eval/run-solution.ts"),
        `--solution=${opts.solutionPath}`,
        `--task=${opts.taskDir}`,
        `--out=${outFile}`,
      ],
      opts.repoRoot,
      60_000,
    );
    try {
      return JSON.parse(readFileSync(outFile, "utf8")) as Verdict;
    } catch {
      const timedOut = r.error?.message === "ETIMEDOUT";
      const detail = r.output.trim().split("\n").slice(-8).join("\n");
      const prefix = timedOut ? "runner timed out:\n" : "runner produced no/invalid verdict:\n";
      return { pass: false, reason: `${prefix}${detail}` };
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
