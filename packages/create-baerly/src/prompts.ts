/**
 * Interactive wizard for `create-baerly`. Invoked only when the
 * process is attached to a real TTY and at least one required arg
 * (`projectName` / `target`) is missing. Non-TTY callers (CI, agents,
 * piped stdin) and `--json` callers retain the flag-driven path and
 * unchanged JSON envelope — see `index.ts`.
 *
 * API surface (`@clack/prompts` v0.7+): `intro`, `text`, `select`,
 * `confirm`, `outro`, `isCancel`, `cancel`. `isCancel(value)` returns
 * `true` when the user hits Ctrl+C; in that case we call `cancel()`
 * and `process.exit(1)` (same exit code as a user error).
 */
import { cancel, confirm, intro, isCancel, select, text } from "@clack/prompts";
import pc from "picocolors";

const TARGETS = [
  {
    value: "cloudflare",
    label: "Cloudflare Workers",
    hint: "R2 + Workers, deploy via wrangler",
  },
  {
    value: "node-railway",
    label: "Node (Railway / Render / DO App Platform)",
    hint: "Managed PaaS, auto-build, no Dockerfile",
  },
  {
    value: "node-docker",
    label: "Node (Docker / k8s / VPS)",
    hint: "Distroless Dockerfile, container registries",
  },
] as const;

export interface WizardInput {
  /** When non-undefined, skip the projectName prompt and use this. */
  readonly projectName?: string;
  /** When non-undefined, skip the target prompt and use this. */
  readonly target?: "cloudflare" | "node-railway" | "node-docker";
  /** When non-undefined, skip the install confirm and use this. */
  readonly install?: boolean;
}

export interface WizardOutput {
  readonly projectName: string;
  readonly target: "cloudflare" | "node-railway" | "node-docker";
  readonly install: boolean;
}

export const runWizard = async (input: WizardInput): Promise<WizardOutput> => {
  intro(pc.bold(pc.cyan("create-baerly")));
  const projectName = input.projectName ?? (await promptProjectName());
  const target = input.target ?? (await promptTarget());
  const install = input.install ?? (await promptInstall());
  return { projectName, target, install };
};

const promptProjectName = async (): Promise<string> => {
  const v = await text({
    message: "Project name",
    placeholder: "my-app",
    validate: (raw) => {
      if (raw.length === 0) return "name must be non-empty";
      // MUST mirror the regex in `scaffold.ts:117`. See ticket 02.
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(raw)) {
        return "lowercase, alphanumeric + - / _, starting with [a-z0-9]";
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

const promptTarget = async (): Promise<"cloudflare" | "node-railway" | "node-docker"> => {
  const v = await select({
    message: "Deploy target",
    options: [...TARGETS],
    initialValue: "cloudflare",
  });
  if (isCancel(v)) {
    cancel("Cancelled.");
    process.exit(1);
  }
  return v as "cloudflare" | "node-railway" | "node-docker";
};

const promptInstall = async (): Promise<boolean> => {
  const v = await confirm({ message: "Install dependencies?", initialValue: true });
  if (isCancel(v)) {
    cancel("Cancelled.");
    process.exit(1);
  }
  return v as boolean;
};
