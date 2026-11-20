/**
 * The prototype tree (`packages/server/src/tree/`) is
 * unreachable from every shipped or exported entry point, and no public
 * option surface, env parser or non-test file can supply a layout.
 *
 * Four checks: (1) no package export or bundler entry reaches
 * `src/tree/`; (2) no non-test file outside `src/tree/`, `tests/` and
 * `bench/` imports it; (3) no env parser or package source names a
 * tree/layout env key; (4) collection, `Db` and app option types accept
 * no layout field. When the tree is integrated, check 1 becomes "only
 * the frozen constant is reachable; the override parameter is not".
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  type BaerlyAppConfig,
  type BaerlyConfig,
  type CollectionDefinition,
  MemoryStorage,
} from "@baerly/protocol";
import type { BaerlyNodeOptions } from "@baerly/adapter-node";
import type { Db } from "@baerly/server";
import type { MaintenanceOptions } from "../../packages/server/src/maintenance-options.ts";
import { parseMaintenanceEnv } from "../../packages/server/src/maintenance.ts";
import { TREE_LAYOUT } from "../../packages/server/src/tree/layout.ts";

const REPO = resolve(import.meta.dirname, "../..");
const TREE_DIR = join(REPO, "packages/server/src/tree");

// ---------------------------------------------------------------------
// Import-graph walker (textual; `.ts` extensions are mandatory).
// ---------------------------------------------------------------------

/**
 * Module specifiers a source file imports: static `import` / `import
 * type`, `export ... from`, side-effect `import "x"` and dynamic
 * `import("x")`. Whole-line comments are skipped; the scan otherwise
 * over-approximates (a specifier inside a string that looks like an
 * import counts), which only makes the guard stricter.
 */
const extractSpecifiers = (source: string): string[] => {
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
    .join("\n");
  const found: string[] = [];
  const patterns = [
    // import ... from "x" / import type ... from "x" / export ... from "x"
    /\b(?:import|export)\b[^;"'`]*?\bfrom\s*["']([^"']+)["']/g,
    // import "x"
    /\bimport\s*["']([^"']+)["']/g,
    // import("x")
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      found.push(match[1]!);
    }
  }
  return [...new Set(found)];
};

interface WorkspacePackage {
  readonly name: string;
  readonly dir: string;
  readonly exports: Record<string, unknown>;
}

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

/** Every string leaf of an `exports` value (all conditions). */
const exportTargets = (value: unknown): string[] => {
  if (typeof value === "string") {
    return [value];
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(exportTargets);
  }
  return [];
};

const loadWorkspacePackages = (): WorkspacePackage[] => {
  const dirs = [
    REPO,
    ...readdirSync(join(REPO, "packages"))
      .map((name) => join(REPO, "packages", name))
      .filter((dir) => existsSync(join(dir, "package.json"))),
  ];
  return dirs.map((dir) => {
    const pkg = readJson(join(dir, "package.json"));
    return {
      name: pkg["name"] as string,
      dir,
      exports: (pkg["exports"] ?? {}) as Record<string, unknown>,
    };
  });
};

const SOURCE_EXTENSIONS = [".ts", ".tsx"];

const isSourceFile = (path: string): boolean =>
  SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext)) && !path.endsWith(".d.ts");

/** Resolve a relative specifier textually; `null` for non-source targets (json, css, ...). */
const resolveRelative = (from: string, specifier: string): string | "unresolved" | null => {
  const base = resolve(dirname(from), specifier);
  if (!SOURCE_EXTENSIONS.some((ext) => specifier.endsWith(ext))) {
    return existsSync(base) && statSync(base).isFile() ? null : "unresolved";
  }
  return existsSync(base) && statSync(base).isFile() ? base : "unresolved";
};

/** Resolve `@baerly/x[/sub]` / `@gusto/baerly-storage[/sub]` through the workspace exports map. */
const resolveWorkspace = (
  packages: readonly WorkspacePackage[],
  specifier: string,
): string[] | null => {
  for (const pkg of packages) {
    if (specifier !== pkg.name && !specifier.startsWith(`${pkg.name}/`)) {
      continue;
    }
    const subpath = specifier === pkg.name ? "." : `.${specifier.slice(pkg.name.length)}`;
    return exportTargets(pkg.exports[subpath])
      .map((target) => resolve(pkg.dir, target))
      .filter(isSourceFile);
  }
  return null;
};

/** Source entry files named by every `package.json` `exports` map in the workspace. */
const exportEntries = (packages: readonly WorkspacePackage[]): string[] =>
  packages.flatMap((pkg) =>
    Object.values(pkg.exports)
      .flatMap(exportTargets)
      .map((target) => resolve(pkg.dir, target))
      .filter(isSourceFile),
  );

/** Bundler entries: the root rolldown `input` map and each package's `input: "src/x.ts"`. */
const bundlerEntries = (packages: readonly WorkspacePackage[]): string[] => {
  const entries: string[] = [];
  const rootConfig = readFileSync(join(REPO, "rolldown.config.ts"), "utf8");
  for (const match of rootConfig.matchAll(/"(packages\/[^"]+\.tsx?)"/g)) {
    entries.push(resolve(REPO, match[1]!));
  }
  for (const pkg of packages) {
    const configPath = join(pkg.dir, "rolldown.config.ts");
    if (pkg.dir === REPO || !existsSync(configPath)) {
      continue;
    }
    for (const match of readFileSync(configPath, "utf8").matchAll(/\binput:\s*"([^"]+\.tsx?)"/g)) {
      entries.push(resolve(pkg.dir, match[1]!));
    }
  }
  return entries;
};

interface Walk {
  readonly reachable: Set<string>;
  readonly unresolved: string[];
}

/** Every source file reachable from `entries` through relative and workspace imports. */
const walkImports = (
  entries: readonly string[],
  packages: readonly WorkspacePackage[],
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
  resolveRel: typeof resolveRelative = resolveRelative,
): Walk => {
  const reachable = new Set<string>();
  const unresolved: string[] = [];
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (reachable.has(file)) {
      continue;
    }
    reachable.add(file);
    for (const specifier of extractSpecifiers(read(file))) {
      if (specifier.startsWith(".")) {
        const target = resolveRel(file, specifier);
        if (target === "unresolved") {
          unresolved.push(`${relative(REPO, file)} -> ${specifier}`);
        } else if (target !== null) {
          queue.push(target);
        }
      } else {
        queue.push(...(resolveWorkspace(packages, specifier) ?? []));
      }
    }
  }
  return { reachable, unresolved };
};

describe("import walker (self-test)", () => {
  test("extracts every import form", () => {
    const source = [
      'import a from "./static.ts";',
      'import type { B } from "./type-only.ts";',
      'import { type C, d } from "./mixed.ts";',
      'import "./side-effect.ts";',
      'export { e } from "./reexport.ts";',
      'export * from "./star.ts";',
      'export * as ns from "./ns.ts";',
      'export type { F } from "./type-reexport.ts";',
      'const lazy = () => import("./dynamic.ts").then((m) => m.x);',
      'const awaited = await import( "./dynamic-spaced.ts" );',
      "import {",
      "  g,",
      "  h,",
      '} from "./multiline.ts";',
      ' * import("./in-jsdoc.ts") is documentation',
      '// import x from "./in-line-comment.ts";',
      'import pkg from "@baerly/server/http";',
    ].join("\n");
    expect(extractSpecifiers(source).toSorted()).toEqual(
      [
        "./static.ts",
        "./type-only.ts",
        "./mixed.ts",
        "./side-effect.ts",
        "./reexport.ts",
        "./star.ts",
        "./ns.ts",
        "./type-reexport.ts",
        "./dynamic.ts",
        "./dynamic-spaced.ts",
        "./multiline.ts",
        "@baerly/server/http",
      ].toSorted(),
    );
  });

  test("follows transitive imports and workspace specifiers, and reports dead ends", () => {
    const graph: Record<string, string> = {
      "/r/a.ts": 'import { b } from "./b.ts"; export * from "./missing.ts";',
      "/r/b.ts": 'const x = () => import("./c.ts");',
      "/r/c.ts": 'import type { D } from "@baerly/fake/sub";',
      "/r/fake-sub.ts": 'import "./leaf.ts";',
      "/r/leaf.ts": "",
    };
    const packages: WorkspacePackage[] = [
      { name: "@baerly/fake", dir: "/r", exports: { "./sub": { import: "./fake-sub.ts" } } },
    ];
    const walk = walkImports(
      ["/r/a.ts"],
      packages,
      (path) => graph[path] ?? "",
      (from, specifier) => {
        const target = resolve(dirname(from), specifier);
        return target in graph ? target : "unresolved";
      },
    );
    expect([...walk.reachable].toSorted()).toEqual([
      "/r/a.ts",
      "/r/b.ts",
      "/r/c.ts",
      "/r/fake-sub.ts",
      "/r/leaf.ts",
    ]);
    expect(walk.unresolved).toHaveLength(1);
    expect(walk.unresolved[0]).toMatch(/a\.ts -> \.\/missing\.ts$/);
  });
});

// ---------------------------------------------------------------------
// 1. Nothing exported or bundled reaches src/tree/.
// ---------------------------------------------------------------------

describe("tree isolation", () => {
  const packages = loadWorkspacePackages();
  const entries = [...new Set([...exportEntries(packages), ...bundlerEntries(packages)])];
  const walk = walkImports(entries, packages);

  test("the walk covers the published surface (not vacuous)", () => {
    const rel = (path: string): string => relative(REPO, path);
    const reached = new Set([...walk.reachable].map(rel));
    const expectedFiles = [
      "packages/server/src/index.ts",
      "packages/server/src/writer.ts",
      "packages/server/src/maintenance.ts",
      "packages/server/src/_internal/testing.ts",
      "packages/server/src/_internal/maintenance.ts",
      "packages/adapter-node/src/index.ts",
      "packages/adapter-cloudflare/src/worker.ts",
      "packages/protocol/src/constants.ts",
      "packages/cli/src/baerly.ts",
      "packages/create-baerly-storage/src/index.ts",
    ];
    expect(expectedFiles.filter((file) => !reached.has(file))).toEqual([]);
    expect(walk.reachable.size).toBeGreaterThan(200);
    expect(walk.unresolved).toEqual([]);
  });

  test("1. no export or bundler entry reaches packages/server/src/tree/", () => {
    const reachedTree = [...walk.reachable]
      .filter((path) => path.startsWith(`${TREE_DIR}/`))
      .map((path) => relative(REPO, path));
    expect(reachedTree).toEqual([]);
  });

  // -------------------------------------------------------------------
  // 2. No non-test file outside src/tree, tests/, bench/ imports it.
  // -------------------------------------------------------------------

  test("2. no non-test file outside src/tree/, tests/ or bench/ imports from src/tree/", () => {
    const files = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    )
      .split("\0")
      .filter(
        (path) => path !== "" && /\.(?:[cm]?[jt]sx?)$/.test(path) && existsSync(join(REPO, path)),
      );
    const exempt = (path: string): boolean =>
      path.startsWith("packages/server/src/tree/") ||
      path.startsWith("tests/") ||
      path.startsWith("bench/") ||
      /\.test(?:-d)?\.[cm]?[jt]sx?$/.test(path);
    const offenders: string[] = [];
    let scanned = 0;
    for (const path of files.filter((file) => !exempt(file))) {
      scanned += 1;
      const abs = join(REPO, path);
      for (const specifier of extractSpecifiers(readFileSync(abs, "utf8"))) {
        const resolved = specifier.startsWith(".") ? resolve(dirname(abs), specifier) : specifier;
        if (resolved.startsWith(`${TREE_DIR}/`) || /(?:^|\/)src\/tree(?:\/|$)/.test(resolved)) {
          offenders.push(`${path} -> ${specifier}`);
        }
      }
    }
    expect(scanned).toBeGreaterThan(300);
    expect(offenders).toEqual([]);
  });

  // -------------------------------------------------------------------
  // 3. No layout key in the env surface.
  // -------------------------------------------------------------------

  const LAYOUT_KEY = /TREE|LAYOUT|LEAF|FANOUT|PROLLY|CDC/i;

  test("3. parseMaintenanceEnv reads no layout key", () => {
    const read = new Set<string>();
    const valueProfiles: Array<(key: string) => string | undefined> = [
      () => undefined,
      () => "",
      () => "1",
      () => "true",
    ];
    for (const profile of valueProfiles) {
      try {
        parseMaintenanceEnv((key) => {
          read.add(key);
          return profile(key);
        });
      } catch {
        // A rejected value still read its key; only the keys matter here.
      }
    }
    // Harness check: the parser's known keys are observed.
    expect([...read]).toEqual(
      expect.arrayContaining(["BAERLY_MAINTENANCE_MAX_FOLD_BYTES", "BAERLY_MAINTENANCE_DISABLE"]),
    );
    expect([...read].filter((key) => LAYOUT_KEY.test(key))).toEqual([]);
  });

  test("3. no non-tree package source names a BAERLY_* layout env key", () => {
    const offenders: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules" && path !== TREE_DIR) {
            visit(path);
          }
        } else if (isSourceFile(path) && !/\.test(?:-d)?\.tsx?$/.test(path)) {
          for (const match of readFileSync(path, "utf8").matchAll(/BAERLY_[A-Z0-9_]*/g)) {
            if (LAYOUT_KEY.test(match[0])) {
              offenders.push(`${relative(REPO, path)}: ${match[0]}`);
            }
          }
        }
      }
    };
    for (const pkg of packages.filter((p) => p.dir !== REPO)) {
      visit(join(pkg.dir, "src"));
    }
    expect(offenders).toEqual([]);
  });

  // -------------------------------------------------------------------
  // 4. Public option types reject a `layout` field.
  // -------------------------------------------------------------------

  test("4. collection, Db and app option types reject `layout`", () => {
    const layout = TREE_LAYOUT;
    const accepts = <T>(_value: T): void => {};

    // Positive controls: the base literals are valid, so each expected
    // error below can only be about `layout`.
    const storage = new MemoryStorage();
    const dbBase = { storage, app: "a", tenant: "t" };
    const appBase = {
      app: "a",
      tenant: "t",
      target: "node",
      auth: "none",
      collections: {},
    } as const;
    const nodeBase: BaerlyNodeOptions = { config: appBase, storage };
    accepts<Parameters<typeof Db.create>[0]>(dbBase);
    accepts<CollectionDefinition>({});
    accepts<BaerlyConfig>({ collections: {} });
    accepts<BaerlyAppConfig>(appBase);
    accepts<BaerlyNodeOptions>(nodeBase);
    accepts<MaintenanceOptions>({});

    // @ts-expect-error `Db.create` takes no layout
    accepts<Parameters<typeof Db.create>[0]>({ ...dbBase, layout });
    // @ts-expect-error a collection definition takes no layout
    accepts<CollectionDefinition>({ layout });
    // @ts-expect-error the collections config takes no layout
    accepts<BaerlyConfig>({ collections: {}, layout });
    // @ts-expect-error the app config takes no layout
    accepts<BaerlyAppConfig>({ ...appBase, layout });
    // @ts-expect-error the node host options take no layout
    accepts<BaerlyNodeOptions>({ ...nodeBase, layout });
    // @ts-expect-error scheduled maintenance options take no layout
    accepts<MaintenanceOptions>({ layout });

    // A collection entry inside a config is a collection option too.
    // @ts-expect-error nested collection definitions take no layout
    accepts<BaerlyConfig>({ collections: { notes: { layout } } });

    // The same literal passes against a type that does declare it, so
    // each directive above is live.
    accepts<{ layout?: typeof layout }>({ layout });
    expect(layout.leafTargetBytes).toBe(16 * 1024);
  });
});
