/**
 * Which package manager invoked us. Read from
 * `npm_config_user_agent` — set by npm/pnpm/yarn when they run
 * their `create` shorthand. Defaults to `"npm"` on any parse
 * failure (most conservative — npm has the widest install base).
 */
export type Pm = "npm" | "pnpm" | "yarn";

export const detectPm = (userAgent: string | undefined = process.env.npm_config_user_agent): Pm => {
  if (userAgent === undefined) return "npm";
  // user-agent format: "<pm>/<version> node/<v> <platform> <arch>"
  const m = /^(npm|pnpm|yarn)\//.exec(userAgent);
  if (m === null) return "npm";
  return m[1] as Pm;
};

/**
 * The install command for the detected PM. Used in the post-
 * scaffold "next steps" output.
 */
export const installCommand = (pm: Pm): string =>
  pm === "npm" ? "npm install" : pm === "pnpm" ? "pnpm install" : "yarn install";

/**
 * The run-script invocation prefix. `pnpm dev` / `npm run dev` /
 * `yarn dev`. The scaffolded `package.json` scripts assume this
 * shape.
 */
export const runCommand = (pm: Pm, script: string): string =>
  pm === "pnpm" ? `pnpm ${script}` : pm === "yarn" ? `yarn ${script}` : `npm run ${script}`;
