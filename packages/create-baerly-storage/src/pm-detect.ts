/**
 * Which package manager invoked us. Read from
 * `npm_config_user_agent` — set by npm/pnpm/yarn when they run
 * their `create` shorthand. Defaults to `"npm"` on any parse
 * failure (most conservative — npm has the widest install base).
 */
import { spawnSync } from "node:child_process";

export type Pm = "npm" | "pnpm" | "yarn";

export const detectPm = (
  userAgent: string | undefined = process.env["npm_config_user_agent"],
): Pm => {
  if (userAgent === undefined) {
    return "npm";
  }
  // user-agent format: "<pm>/<version> node/<v> <platform> <arch>"
  const m = /^(npm|pnpm|yarn)\//.exec(userAgent);
  if (m === null) {
    return "npm";
  }
  return m[1] as Pm;
};

/**
 * The install command for the detected PM. Used in the post-
 * scaffold "next steps" output.
 */
export const installCommand = (pm: Pm): string => {
  if (pm === "npm") {
    return "npm install";
  }
  if (pm === "pnpm") {
    return "pnpm install";
  }
  return "yarn install";
};

/**
 * The run-script invocation prefix. `pnpm dev` / `npm run dev` /
 * `yarn dev`. The scaffolded `package.json` scripts assume this
 * shape.
 */
export const runCommand = (pm: Pm, script: string): string => {
  if (pm === "pnpm") {
    return `pnpm ${script}`;
  }
  if (pm === "yarn") {
    return `yarn ${script}`;
  }
  return `npm run ${script}`;
};

/**
 * Best-effort `<pm> --version` probe. Returns the trimmed version
 * string on success, or `undefined` if the pm binary can't be
 * spawned or returns non-zero. Used by the `git init` commit-message
 * body — a missing pm version is a stylistic loss, not a hard error,
 * so callers should pass the result through unchecked.
 */
export const probePmVersion = (pm: Pm): string | undefined => {
  const res = spawnSync(pm, ["--version"], { encoding: "utf8" });
  if (res.error !== undefined || res.status !== 0) {
    return undefined;
  }
  const out = (res.stdout ?? "").trim();
  return out.length > 0 ? out : undefined;
};
