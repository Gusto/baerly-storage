/**
 * Interactive wizard for `create-baerly-storage`. Invoked only when the
 * process is attached to a real TTY and at least one required arg
 * (`projectName` / `target`) is missing. Non-TTY callers (CI, agents,
 * piped stdin) and `--json` callers retain the flag-driven path and
 * unchanged JSON envelope — see `index.ts`.
 *
 * API surface (`@clack/prompts` v1+): `intro`, `text`, `select`,
 * `confirm`, `outro`, `isCancel`, `cancel`. `isCancel(value)` returns
 * `true` when the user hits Ctrl+C; in that case we call `cancel()`
 * and `process.exit(1)` (same exit code as a user error).
 */
import { cancel, confirm, intro, isCancel, note, select, text } from "@clack/prompts";
import pc from "picocolors";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defaultGitRunner, type GitRunner } from "./git.ts";
import type { Addon } from "./scaffold.ts";

const TARGETS = [
  {
    value: "cloudflare",
    label: "Cloudflare Workers",
    hint: "R2 + Workers, deploy via wrangler",
  },
  {
    value: "node",
    label: "Node",
    hint: "Any host that runs `node server.js` (Railway, Render, Fly without Docker, Heroku, a VM)",
  },
] as const;

const STARTERS = [
  {
    value: "minimal",
    label: "Minimal",
    hint: "Server only — no UI framework",
  },
  {
    value: "react",
    label: "React",
    hint: "React + Vite SPA over a sample notes collection",
  },
] as const;

export interface WizardInput {
  /** When non-undefined, skip the projectName prompt and use this. */
  readonly projectName?: string;
  /** When non-undefined, skip the target prompt and use this. */
  readonly target?: "cloudflare" | "node";
  /** When non-undefined, skip the starter prompt and use this. */
  readonly starter?: "minimal" | "react";
  /**
   * When non-undefined, skip the per-add-on confirms and use this set.
   * Today only `"docker"` is a meaningful element (and only when
   * `target === "node"`).
   */
  readonly withAddons?: readonly Addon[];
  /** When non-undefined, skip the install confirm and use this. */
  readonly install?: boolean;
  /**
   * When non-undefined, skip the git-init confirm and use this. The
   * wizard also skips the prompt — defaulting to `false` — when the
   * current directory is already inside a git work tree, since
   * `create-baerly-storage` won't nest a new repo inside an existing one
   * either way.
   */
  readonly git?: boolean;
  /** Tenant pin passed through from --tenant; bolt-on mode uses it directly. */
  readonly tenant?: string;
}

export type WizardOutput = ScaffoldWizardOutput | BoltOnWizardOutput;

export interface ScaffoldWizardOutput {
  readonly mode: "scaffold";
  /**
   * May be `"."` — the sentinel for "scaffold into the current
   * directory". Callers must not blindly compose this with a path
   * (e.g. `path.join(cwd, projectName)`); branch on `=== "."`
   * first or pass it straight through to `scaffold()`.
   */
  readonly projectName: string;
  readonly target: "cloudflare" | "node";
  readonly starter: "minimal" | "react";
  readonly withAddons: readonly Addon[];
  readonly install: boolean;
  readonly git: boolean;
}

export interface BoltOnWizardOutput {
  readonly mode: "bolt-on";
  readonly projectName: string;
  readonly tenant: string;
  readonly install: boolean;
}

export const runWizard = async (
  input: WizardInput,
  opts: { readonly gitRunner?: GitRunner } = {},
): Promise<WizardOutput> => {
  intro(pc.bold(pc.cyan("create-baerly-storage")));
  const projectName = input.projectName ?? (await promptProjectName());
  const outDir = projectName === "." ? process.cwd() : resolve(process.cwd(), projectName);
  const wranglerPath = resolve(outDir, "wrangler.jsonc");
  if (existsSync(wranglerPath)) {
    note("Detected existing Cloudflare Worker — bolting baerly on instead of scaffolding.");
    const install = input.install ?? (await promptInstall());
    return {
      mode: "bolt-on",
      projectName,
      tenant: input.tenant ?? "default",
      install,
    };
  }
  const target = input.target ?? (await promptTarget());
  const starter = input.starter ?? (await promptStarter());
  // Add-on prompts are gated per-target. Today only `docker` exists
  // and only applies when `target === "node"`; on `cloudflare` we
  // skip the prompt and emit an empty addon list.
  let withAddons: readonly Addon[];
  if (input.withAddons !== undefined) {
    withAddons = input.withAddons;
  } else if (target === "node") {
    withAddons = (await promptDocker()) ? ["docker"] : [];
  } else {
    withAddons = [];
  }
  const install = input.install ?? (await promptInstall());
  // Skip the git prompt entirely when we're already inside a git
  // work tree — `initRepoAndCommit` would skip with `already-in-repo`
  // anyway, and asking the question would only confuse a user who
  // can't usefully answer it. `opts.gitRunner` makes this stubbable
  // for the wizard-flow tests. Pre-filled `input.git` short-circuits
  // BEFORE the spawn so pure-prompt tests don't incur the side effect.
  let git: boolean;
  if (input.git !== undefined) {
    git = input.git;
  } else {
    const gitRunner = opts.gitRunner ?? defaultGitRunner;
    const insideRepo =
      gitRunner.run(["rev-parse", "--is-inside-work-tree"], process.cwd()).stdout.trim() === "true";
    git = insideRepo ? false : await promptGit();
  }
  return { mode: "scaffold", projectName, target, starter, withAddons, install, git };
};

const promptProjectName = async (): Promise<string> => {
  const v = await text({
    message: "Project name (use '.' for current directory)",
    placeholder: "my-app",
    // `@clack/prompts` v1 widened the `validate` callback's parameter
    // to `string | undefined`. Treat `undefined` as the empty string
    // so the existing "non-empty" guard fires.
    validate: (raw = "") => {
      if (raw.length === 0) {
        return "name must be non-empty";
      }
      // `"."` (exactly one character) is the shorthand for "scaffold
      // into the current directory" — `scaffold.ts` derives `appName`
      // from `basename(cwd)` and applies the same regex below to that
      // derived value.
      if (raw === ".") {
        return undefined;
      }
      // MUST mirror the validation regex in `scaffold.ts`'s `scaffold()`.
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(raw)) {
        return "lowercase, alphanumeric + - / _, starting with [a-z0-9] (or '.' for current directory)";
      }
      return undefined;
    },
  });
  if (isCancel(v)) {
    cancel("Cancelled.");
    process.exit(1);
  }
  return v as string;
};

const promptTarget = async (): Promise<"cloudflare" | "node"> => {
  const v = await select({
    message: "Deploy target",
    options: [...TARGETS],
    initialValue: "cloudflare",
  });
  if (isCancel(v)) {
    cancel("Cancelled.");
    process.exit(1);
  }
  return v as "cloudflare" | "node";
};

const promptStarter = async (): Promise<"minimal" | "react"> => {
  const v = await select({
    message: "Starter template",
    options: [...STARTERS],
    initialValue: "minimal",
  });
  if (isCancel(v)) {
    cancel("Cancelled.");
    process.exit(1);
  }
  return v as "minimal" | "react";
};

const promptDocker = async (): Promise<boolean> => {
  const v = await confirm({
    message: "Add a production Dockerfile?",
    initialValue: false,
  });
  if (isCancel(v)) {
    cancel("Cancelled.");
    process.exit(1);
  }
  return v as boolean;
};

const promptInstall = async (): Promise<boolean> => {
  const v = await confirm({ message: "Install dependencies?", initialValue: true });
  if (isCancel(v)) {
    cancel("Cancelled.");
    process.exit(1);
  }
  return v as boolean;
};

const promptGit = async (): Promise<boolean> => {
  const v = await confirm({
    message: "Initialise a git repo and create the initial commit?",
    initialValue: true,
  });
  if (isCancel(v)) {
    cancel("Cancelled.");
    process.exit(1);
  }
  return v as boolean;
};
