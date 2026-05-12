/**
 * `baerly.config.ts` loader for `baerly deploy` / `baerly doctor`.
 *
 * Mirrors the shape of {@link BaerlyAppConfig} in `create-baerly`
 * but lives in `@baerly/cli` so the CLI doesn't have to take a
 * runtime dep on `create-baerly`. The scaffolder emits the config
 * file; the CLI reads it. Both sides agree on the wire shape
 * (informally — there is no shared types package, only matching
 * fields).
 *
 * Resolution order:
 *   1. `<cwd>/baerly.config.ts`
 *   2. `<cwd>/baerly.config.js`
 *   3. `<cwd>/baerly.config.mjs`
 *   4. `<cwd>/baerly.config.json`
 *
 * The `.ts` form requires the user to have a TS-aware Node entry
 * point (`tsx`, `--experimental-strip-types`, or a build step that
 * produced the `.js` alongside). If `import()` throws on the `.ts`
 * file, we re-wrap as `InvalidConfig` with a hint pointing at the
 * `.js` / `.json` fallbacks.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BaerlyError } from "@baerly/protocol";

export interface AppConfig {
  readonly app: string;
  readonly tenant: string;
  readonly target: "cloudflare" | "node";
  readonly domain?: string;
  readonly requiredSecrets?: readonly string[];
  readonly cloudflareAccess?: {
    readonly teamDomain: string;
    readonly audienceTag: string;
  };
  /** Absolute path to the repo root that contained the config. */
  readonly repoRoot: string;
}

const CONFIG_BASENAMES: readonly string[] = [
  "baerly.config.ts",
  "baerly.config.js",
  "baerly.config.mjs",
  "baerly.config.json",
];

/**
 * Locate the first `baerly.config.*` file under `cwd`. Returns the
 * absolute path or `null` if none exists.
 */
const locateConfig = (cwd: string): string | null => {
  for (const base of CONFIG_BASENAMES) {
    const abs = resolve(cwd, base);
    if (existsSync(abs)) return abs;
  }
  return null;
};

/**
 * Load `baerly.config.{ts,js,mjs,json}` from `cwd` (defaults to
 * `process.cwd()`). Validates the required fields and the
 * locked-shape optionals; returns an `AppConfig` decorated with the
 * `repoRoot` it was loaded from.
 *
 * @throws BaerlyError code="InvalidConfig" — file missing, default
 *   export missing, or any field has the wrong shape / type.
 */
export const loadAppConfig = async (cwd: string = process.cwd()): Promise<AppConfig> => {
  const cfgPath = locateConfig(cwd);
  if (cfgPath === null) {
    throw new BaerlyError(
      "InvalidConfig",
      `baerly: no baerly.config.{ts,js,mjs,json} at ${cwd}. Are you in a baerly app directory?`,
    );
  }

  let raw: unknown;
  if (cfgPath.endsWith(".json")) {
    let text: string;
    try {
      text = await readFile(cfgPath, "utf8");
    } catch (e) {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly: failed to read ${cfgPath}: ${(e as Error).message}`,
        e,
      );
    }
    try {
      raw = JSON.parse(text) as unknown;
    } catch (e) {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly: failed to parse ${cfgPath}: ${(e as Error).message}`,
        e,
      );
    }
  } else {
    let mod: { default?: unknown };
    try {
      mod = (await import(pathToFileURL(cfgPath).href)) as { default?: unknown };
    } catch (e) {
      const hint = cfgPath.endsWith(".ts")
        ? " (Node cannot import .ts directly without a TS loader — point at the compiled .js or use a .json config)"
        : "";
      throw new BaerlyError(
        "InvalidConfig",
        `baerly: failed to load ${cfgPath}: ${(e as Error).message}${hint}`,
        e,
      );
    }
    raw = mod.default;
  }

  if (raw === undefined || typeof raw !== "object" || raw === null) {
    throw new BaerlyError(
      "InvalidConfig",
      `baerly: ${cfgPath} must default-export a BaerlyAppConfig object`,
    );
  }

  const obj = raw as Record<string, unknown>;
  const app = obj["app"];
  const tenant = obj["tenant"];
  const target = obj["target"];
  if (typeof app !== "string" || app.length === 0) {
    throw new BaerlyError(
      "InvalidConfig",
      `baerly: ${cfgPath}: \`app\` must be a non-empty string`,
    );
  }
  if (typeof tenant !== "string" || tenant.length === 0) {
    throw new BaerlyError(
      "InvalidConfig",
      `baerly: ${cfgPath}: \`tenant\` must be a non-empty string`,
    );
  }
  if (target !== "cloudflare" && target !== "node") {
    throw new BaerlyError(
      "InvalidConfig",
      `baerly: ${cfgPath}: \`target\` must be "cloudflare" or "node" (got ${JSON.stringify(target)})`,
    );
  }

  const domainRaw = obj["domain"];
  if (domainRaw !== undefined && typeof domainRaw !== "string") {
    throw new BaerlyError(
      "InvalidConfig",
      `baerly: ${cfgPath}: \`domain\` must be a string when set`,
    );
  }

  const secretsRaw = obj["requiredSecrets"];
  let requiredSecrets: readonly string[] | undefined;
  if (secretsRaw !== undefined) {
    if (!Array.isArray(secretsRaw) || !secretsRaw.every((s) => typeof s === "string")) {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly: ${cfgPath}: \`requiredSecrets\` must be an array of strings`,
      );
    }
    requiredSecrets = secretsRaw as readonly string[];
  }

  const cfaRaw = obj["cloudflareAccess"];
  let cloudflareAccess: AppConfig["cloudflareAccess"];
  if (cfaRaw !== undefined) {
    if (typeof cfaRaw !== "object" || cfaRaw === null) {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly: ${cfgPath}: \`cloudflareAccess\` must be an object when set`,
      );
    }
    const cfa = cfaRaw as Record<string, unknown>;
    const td = cfa["teamDomain"];
    const aud = cfa["audienceTag"];
    if (typeof td !== "string" || td.length === 0) {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly: ${cfgPath}: \`cloudflareAccess.teamDomain\` must be a non-empty string`,
      );
    }
    if (typeof aud !== "string" || aud.length === 0) {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly: ${cfgPath}: \`cloudflareAccess.audienceTag\` must be a non-empty string`,
      );
    }
    cloudflareAccess = { teamDomain: td, audienceTag: aud };
  }

  return {
    app,
    tenant,
    target,
    ...(domainRaw !== undefined && { domain: domainRaw }),
    ...(requiredSecrets !== undefined && { requiredSecrets }),
    ...(cloudflareAccess !== undefined && { cloudflareAccess }),
    repoRoot: cwd,
  };
};
