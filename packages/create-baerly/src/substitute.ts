/**
 * Manifest-driven content rewrite for the scaffolder. Two kinds of
 * edits happen at copy time:
 *
 *   1. Sentinel rename. Each entry in `manifest.renames` is a literal
 *      substring to replace, mapped to a user-supplied value via
 *      `fromKey`. Sentinels are applied longest-first so a longer
 *      sentinel (e.g. "minimal-cloudflare-server") rewrites before a
 *      shorter one it contains as a prefix ("minimal-cloudflare").
 *
 *   2. package.json normalisation. For files named `package.json`,
 *      any `workspace:*` value under a dep key matching `@baerly/*`
 *      *or* the literal `create-baerly` is pinned to `^<cliVersion>`
 *      (the scaffolder + CLI ship at the same version, and the
 *      emitted `baerly.config.ts` imports `create-baerly/config`),
 *      and any dep in `manifest.dropDevDeps` is removed from
 *      `devDependencies`. Indentation is preserved by round-tripping
 *      through `JSON.parse` + `JSON.stringify(_, null, 2)`.
 *
 * Literal substring substitution is deliberate: example sentinels are
 * unusual enough (`minimal-cloudflare`, `minimal-demo`, …) not to
 * collide with unrelated content, and substring matching covers the
 * full surface of code/JSON/Markdown/Dockerfile/systemd without per-
 * extension parsing.
 */

export interface ManifestRename {
  readonly from: string;
  readonly fromKey: string;
}

export interface ScaffoldManifest {
  readonly renames: readonly ManifestRename[];
  readonly excludePaths: readonly string[];
  readonly dropDevDeps: readonly string[];
}

export interface SubstituteContext {
  readonly manifest: ScaffoldManifest;
  readonly vars: Record<string, string>;
  readonly cliVersion: string;
}

/**
 * Rewrite text content (any non-JSON-aware file). Applies sentinel
 * renames longest-first. Unknown `fromKey` values cause the rename to
 * be skipped — that's a scaffolder authoring bug, not a user error,
 * and silent empty-substitution would hide it.
 */
export const substituteText = (text: string, ctx: SubstituteContext): string => {
  const sorted = ctx.manifest.renames.toSorted((a, b) => b.from.length - a.from.length);
  let out = text;
  for (const r of sorted) {
    if (!Object.hasOwn(ctx.vars, r.fromKey)) continue;
    out = out.replaceAll(r.from, ctx.vars[r.fromKey]!);
  }
  return out;
};

/**
 * Rewrite a package.json's text content. Applies sentinel renames
 * first (covers the `"name"` field and any other string), then pins
 * `@baerly/*` (and `create-baerly`) workspace deps to the CLI
 * version, and drops listed devDependencies.
 */
export const substitutePackageJson = (text: string, ctx: SubstituteContext): string => {
  const renamed = substituteText(text, ctx);
  const pkg = JSON.parse(renamed) as Record<string, unknown> & {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const pin = `^${ctx.cliVersion}`;
  for (const block of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const deps = pkg[block];
    if (deps === undefined) continue;
    for (const [name, value] of Object.entries(deps)) {
      if (value !== "workspace:*") continue;
      if (name.startsWith("@baerly/") || name === "create-baerly") deps[name] = pin;
    }
  }
  if (pkg.devDependencies !== undefined) {
    for (const drop of ctx.manifest.dropDevDeps) {
      delete pkg.devDependencies[drop];
    }
    if (Object.keys(pkg.devDependencies).length === 0) delete pkg.devDependencies;
  }
  return `${JSON.stringify(pkg, null, 2)}\n`;
};
