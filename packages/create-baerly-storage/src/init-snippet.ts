/**
 * Render the worker-entry paste-string that the create-baerly-storage
 * bolt-on flow prints after patching `wrangler.jsonc`. The user
 * copies this verbatim into the path declared in
 * `wrangler.jsonc:main`, replacing the stock `wrangler create`
 * hello world. baerly never writes user code (Convex-style:
 * structured config is fair game; the worker entry is sacred).
 */

import { relative, dirname, normalize } from "node:path/posix";

export interface SnippetContext {
  /**
   * Tenant identifier the bolt-on flow seeds into `wrangler.jsonc:vars.TENANT`.
   * The snippet itself does NOT interpolate this — it references the runtime
   * `env.TENANT`. The field lives on this context type so callers pass a
   * single object to both the snippet renderer and the wrangler patcher.
   */
  readonly tenant: string;
  /** Verbatim `wrangler.jsonc:main` — drives the import-to-config relpath. */
  readonly wranglerMain: string;
}

/**
 * Compute the JS import path from `wranglerMain` to `./baerly.config.ts`.
 * Both inputs are repo-root-relative; the output is the import string
 * the snippet emits. Always carries the explicit `.ts` extension
 * (project convention; see CLAUDE.md "Imports are relative, with
 * explicit `.ts`/`.tsx` extensions").
 */
// Callers must pass forward-slash paths. POSIX normalize treats `\\` as a
// literal character, not a separator, so backslash-style Windows paths
// would be misinterpreted. `wrangler.jsonc:main` always uses forward slashes
// on every host, so this is safe in practice.
export const computeConfigImportPath = (wranglerMain: string): string => {
  const normalised = normalize(wranglerMain);
  const fromDir = dirname(normalised);
  if (fromDir === "." || fromDir === "") {
    return "./baerly.config.ts";
  }
  const rel = relative(fromDir, "baerly.config.ts");
  return rel.startsWith("..") ? rel : `./${rel}`;
};

export const renderWorkerEntrySnippet = (ctx: SnippetContext): string => {
  const configPath = computeConfigImportPath(ctx.wranglerMain);
  return `import { baerlyWorker, type BaerlyEnv } from "baerly-storage/cloudflare";
import { sharedSecret } from "baerly-storage/auth";
import config from "${configPath}";

interface AppEnv extends BaerlyEnv {
  readonly TENANT: string;
  readonly SHARED_SECRET: string;
}

export default baerlyWorker<AppEnv>((env) => ({
  verifier: sharedSecret({ secret: env.SHARED_SECRET, tenantPrefix: env.TENANT }),
  config,
}));
`;
};
