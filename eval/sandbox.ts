import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Create the agent's working directory OUTSIDE the repo (os.tmpdir()), so no
 * repo file (CLAUDE.md, source) can reach the agent. Callers must remove it.
 */
export function createAgentDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `${label}-`));
}

/**
 * Create a per-attempt CHECK sandbox INSIDE the repo tree (NOT os.tmpdir()).
 *
 * A generated `solution.ts` must resolve third-party deps (e.g. `zod`) and the
 * package's own value-imports (`@gusto/baerly-storage/config`) the way an
 * installed app does, by walking up `node_modules`, which a `/tmp` directory
 * cannot. eval/resolve-package.mjs and the `paths` in the check.ts tsconfig
 * still force `@gusto/baerly-storage` itself to the built `dist/` surface, so
 * the solution is graded against the published package.
 *
 * The agent never runs here: its solution.ts is copied in from the agent dir
 * before checking. The directory is gitignored (`eval/.sandboxes/`); callers
 * must remove it.
 */
export function createSandboxDir(repoRoot: string, label: string): string {
  const base = join(repoRoot, "eval", ".sandboxes");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${label}-`));
}
