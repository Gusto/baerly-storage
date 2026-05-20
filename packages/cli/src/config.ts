/**
 * `baerly.config.ts` loader for `baerly deploy` / `baerly doctor`.
 *
 * Mirrors the shape of `BaerlyAppConfig` from `baerly-storage/config`
 * but lives in `@baerly/cli` so the validator/loader doesn't depend on
 * the rolldown'd umbrella bundle. The scaffolder emits the config file;
 * the CLI reads it. Both sides agree on the wire shape (informally —
 * the duplication is small and intentional).
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { BaerlyError } from "@baerly/protocol";
import type { BaerlyConfig, IndexDefinition } from "@baerly/server";

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
 *
 * Exported so the collection-aware loader (and future consumers) can
 * reuse the same resolution order without re-implementing it.
 */
export const locateConfig = (cwd: string): string | null => {
  for (const base of CONFIG_BASENAMES) {
    const abs = resolve(cwd, base);
    if (existsSync(abs)) {
      return abs;
    }
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
    } catch (error) {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly: failed to read ${cfgPath}: ${(error as Error).message}`,
        error,
      );
    }
    try {
      raw = JSON.parse(text) as unknown;
    } catch (error) {
      throw new BaerlyError(
        "InvalidConfig",
        `baerly: failed to parse ${cfgPath}: ${(error as Error).message}`,
        error,
      );
    }
  } else {
    let mod: { default?: unknown };
    try {
      mod = (await import(pathToFileURL(cfgPath).href)) as { default?: unknown };
    } catch (error) {
      const hint = cfgPath.endsWith(".ts")
        ? " (Node cannot import .ts directly without a TS loader — point at the compiled .js or use a .json config)"
        : "";
      throw new BaerlyError(
        "InvalidConfig",
        `baerly: failed to load ${cfgPath}: ${(error as Error).message}${hint}`,
        error,
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

/**
 * Lightweight per-collection index reflection. Mirrors the shape the
 * runtime `BaerlyConfig` carries, but only the fields the doctor needs.
 *
 * `indexes` is an empty array when the collection declared none.
 */
export interface LoadedCollection {
  readonly name: string;
  readonly indexes: readonly IndexDefinition[];
}

/**
 * Load `baerly.config.{ts,js,mjs,json}` AND return the parsed
 * `collections[*]` shape alongside the narrow {@link AppConfig}. Lets
 * the doctor reflect on declared indexes without forcing every consumer
 * to widen `AppConfig`. Returns `undefined` for `collections` when the
 * config doesn't declare any (the doctor downgrades the drift check to
 * a no-op `info` finding in that case).
 *
 * Re-uses {@link loadAppConfig}'s parse/validate path, so the
 * `AppConfig` invariants are still enforced.
 */
export const loadAppConfigWithCollections = async (
  cwd: string = process.cwd(),
): Promise<{
  readonly config: AppConfig;
  readonly collections: readonly LoadedCollection[] | undefined;
}> => {
  const config = await loadAppConfig(cwd);
  const cfgPath = locateConfig(cwd);
  if (cfgPath === null) {
    return { config, collections: undefined };
  }

  // Re-parse the raw default-export to pluck `collections[*]`. We
  // don't validate the inner shape here — at the doctor surface,
  // anything that isn't an object is reported as "no filtered
  // indexes" rather than throwing, so a partially-typed config
  // doesn't fail the whole check.
  let raw: unknown;
  if (cfgPath.endsWith(".json")) {
    let text: string;
    try {
      text = await readFile(cfgPath, "utf8");
    } catch {
      return { config, collections: undefined };
    }
    try {
      raw = JSON.parse(text);
    } catch {
      return { config, collections: undefined };
    }
  } else {
    try {
      const mod = (await import(pathToFileURL(cfgPath).href)) as { default?: unknown };
      raw = mod.default;
    } catch {
      // Node can't `import` a .ts file without a TS loader. The
      // narrow `loadAppConfig` already surfaced the InvalidConfig if
      // that path was unreadable; here we silently downgrade to
      // "no collections" rather than re-throw.
      return { config, collections: undefined };
    }
  }

  if (raw === undefined || raw === null || typeof raw !== "object") {
    return { config, collections: undefined };
  }
  const colsRaw = (raw as { collections?: unknown }).collections;
  if (colsRaw === undefined || colsRaw === null || typeof colsRaw !== "object") {
    return { config, collections: undefined };
  }

  const out: LoadedCollection[] = [];
  for (const [name, decl] of Object.entries(colsRaw as Record<string, unknown>)) {
    if (decl === null || typeof decl !== "object") {
      continue;
    }
    const indexes = (decl as { indexes?: unknown }).indexes;
    if (!Array.isArray(indexes)) {
      out.push({ name, indexes: [] });
      continue;
    }
    // Pass-through cast: the runtime IndexDefinition validation
    // lives in `@baerly/server`; the doctor only reads `name`, `on`,
    // and `predicate`, so a partial shape still gives an actionable
    // finding rather than a SchemaError throw at config-load time.
    out.push({ name, indexes: indexes as readonly IndexDefinition[] });
  }
  return { config, collections: out };
};

/**
 * Load the declared `IndexDefinition[]` for a single collection from a
 * `baerly.config.{js,mjs,json}`. Used by `baerly inspect` (key-count
 * probes) and `baerly admin rebuild-index` (resolving the `on` field).
 *
 * `.ts` configs are rejected — Node can't `import` them without a TS
 * loader; point at the compiled `.js` output instead.
 *
 * `commandName` is woven into thrown error messages so the operator
 * sees the calling command name in the prefix.
 *
 * @throws BaerlyError code="InvalidConfig" — `.ts` extension, JSON
 *   parse error, missing default export, or missing
 *   `collections[table]`.
 */
export const loadCollectionIndexes = async (
  configPath: string,
  table: string,
  commandName: string,
): Promise<readonly IndexDefinition[]> => {
  if (configPath.endsWith(".ts")) {
    throw new BaerlyError(
      "InvalidConfig",
      `${commandName}: --config must point at compiled JS / JSON (got .ts: ${JSON.stringify(configPath)})`,
    );
  }
  let cfg: BaerlyConfig;
  if (configPath.endsWith(".json")) {
    const text = await readFile(configPath, "utf8");
    try {
      cfg = JSON.parse(text) as BaerlyConfig;
    } catch (error) {
      throw new BaerlyError(
        "InvalidConfig",
        `${commandName}: --config JSON parse error in ${JSON.stringify(configPath)}: ${(error as Error).message}`,
      );
    }
  } else {
    const abs = configPath.startsWith("file://") ? fileURLToPath(configPath) : resolve(configPath);
    const mod = (await import(pathToFileURL(abs).href)) as { default?: BaerlyConfig };
    if (mod.default === undefined) {
      throw new BaerlyError(
        "InvalidConfig",
        `${commandName}: --config ${JSON.stringify(configPath)} has no default export`,
      );
    }
    cfg = mod.default;
  }
  return cfg.collections?.[table]?.indexes ?? [];
};
