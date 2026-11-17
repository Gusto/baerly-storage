/**
 * Every module the published `dist/` names must resolve in a consumer's
 * install. A bare specifier that is neither a Node builtin, the package
 * itself, nor a declared `dependencies` / `peerDependencies` entry is a
 * dev-only package leaking into the artifact: a `.js` import fails at
 * runtime, and a `.d.ts` import — even a side-effect `import "x";` — fails
 * a consumer's typecheck with `skipLibCheck: false` (TS2882 on
 * TypeScript 7, which checks side-effect imports by default).
 *
 * Specifiers come from a real parse (`rolldown/utils` `parseSync`, oxc),
 * so comments and string literals never produce false matches: static
 * `import` / `export … from`, side-effect imports, literal `import()`,
 * `import("x").T` type queries, `import x = require("x")`, `require("x")`,
 * `declare module "x"` augmentations, and `/// <reference types="x" />`.
 *
 * A second check covers the zero-shot reader: a JSDoc example in a
 * published `.d.ts` that imports from a package name the reader cannot
 * install gets copied verbatim. Examples must name this package's own
 * published subpaths, a declared dependency/peer, a builtin, or one of
 * the user-side libraries in {@link EXAMPLE_THIRD_PARTY}.
 *
 * Reads the built `dist/`, so it depends on the `pretest` build.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, relative, resolve } from "node:path";
import { parseSync, Visitor } from "rolldown/utils";
import { describe, expect, test } from "vitest";

const ROOT = resolve(__dirname, "../..");
const DIST = resolve(ROOT, "dist");

const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
  name: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  publishConfig: { exports: Record<string, unknown> };
};

const DECLARED = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
]);

/** `@gusto/baerly-storage`, `@gusto/baerly-storage/http`, … — one per published subpath. */
const SELF_SPECIFIERS = new Set(
  Object.keys(pkg.publishConfig.exports).map((subpath) =>
    subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`,
  ),
);

/**
 * Libraries a JSDoc example shows on the USER's side of an integration —
 * the app brings them; the package never imports them. `hono` /
 * `itty-router` appear in hono's own JSDoc, which the `./http` types
 * inline; `zod` is the bring-your-own-validator example on `./config`.
 */
const EXAMPLE_THIRD_PARTY = new Set(["hono", "itty-router", "zod"]);

const BUILTINS = new Set(builtinModules);

const packageNameOf = (specifier: string): string => {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
};

const isRelative = (specifier: string): boolean =>
  specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/");

const isBuiltin = (specifier: string): boolean =>
  specifier.startsWith("node:") ||
  BUILTINS.has(specifier) ||
  BUILTINS.has(packageNameOf(specifier));

const isAllowedImport = (specifier: string): boolean =>
  isRelative(specifier) ||
  isBuiltin(specifier) ||
  SELF_SPECIFIERS.has(specifier) ||
  DECLARED.has(packageNameOf(specifier));

const isAllowedExample = (specifier: string): boolean =>
  isAllowedImport(specifier) || EXAMPLE_THIRD_PARTY.has(packageNameOf(specifier));

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return walk(path);
    }
    return /\.(?:js|mjs|d\.ts|d\.mts)$/.test(entry.name) ? [path] : [];
  });

interface ParsedFile {
  readonly file: string;
  /** Module specifiers the file's code (or triple-slash directives) names. */
  readonly imports: readonly string[];
  /** Specifiers named by `from "x"` / `import("x")` / `require("x")` inside comments. */
  readonly commentSpecifiers: readonly string[];
}

type Node = { readonly type: string; readonly [key: string]: unknown };

/** The string value of a literal specifier node, or `undefined` for a computed one. */
const literalValue = (node: unknown): string | undefined => {
  const n = node as Node | null | undefined;
  if (n?.type === "Literal" && typeof n["value"] === "string") {
    return n["value"];
  }
  if (n?.type === "TemplateLiteral" && (n["expressions"] as unknown[]).length === 0) {
    return (n["quasis"] as { value: { cooked: string } }[])[0]!.value.cooked;
  }
  return undefined;
};

const COMMENT_IMPORT = /\b(?:from|import|require)\s*\(?\s*["']([^"'\s]+)["']/g;
const TRIPLE_SLASH_TYPES = /^\/\s*<reference\s+types\s*=\s*["']([^"']+)["']/;

const parseFile = (path: string): ParsedFile => {
  const file = relative(ROOT, path);
  const source = readFileSync(path, "utf8");
  const lang = /\.d\.m?ts$/.test(path) ? "dts" : "js";
  const result = parseSync(path, source, { lang });
  expect(result.errors, `${file} must parse`).toEqual([]);

  const imports: string[] = [];
  const add = (node: unknown) => {
    const value = literalValue(node);
    if (value !== undefined) {
      imports.push(value);
    }
  };
  new Visitor({
    ImportDeclaration: (n) => add(n.source),
    ExportAllDeclaration: (n) => add(n.source),
    ExportNamedDeclaration: (n) => add(n.source),
    ImportExpression: (n) => add(n.source),
    TSImportType: (n) => add((n as unknown as Node)["source"]),
    TSExternalModuleReference: (n) => add(n.expression),
    TSModuleDeclaration: (n) => add(n.id),
    CallExpression: (n) => {
      if (n.callee.type === "Identifier" && n.callee.name === "require") {
        add(n.arguments[0]);
      }
    },
  }).visit(result.program);

  const commentSpecifiers: string[] = [];
  for (const comment of result.comments) {
    const reference = TRIPLE_SLASH_TYPES.exec(comment.value);
    if (comment.type === "Line" && reference) {
      imports.push(reference[1]!);
    }
    for (const match of comment.value.matchAll(COMMENT_IMPORT)) {
      commentSpecifiers.push(match[1]!);
    }
  }
  return { file, imports, commentSpecifiers };
};

describe("published dist names only installable modules", () => {
  if (!existsSync(DIST)) {
    throw new Error("dist/ missing — run `pnpm build` before `pnpm test`");
  }
  const parsed = walk(DIST).map(parseFile);

  test("dist/ holds both .js and .d.ts files (guards a vacuous pass)", () => {
    expect(parsed.some((p) => p.file.endsWith(".js"))).toBe(true);
    expect(parsed.some((p) => p.file.endsWith(".d.ts"))).toBe(true);
    // The scan must see real imports, or the assertions below prove nothing.
    expect(parsed.flatMap((p) => p.imports).some((s) => s.startsWith("node:"))).toBe(true);
  });

  test("every import is a builtin, the package itself, or a declared dependency/peer", () => {
    const violations = parsed.flatMap(({ file, imports }) =>
      imports.filter((s) => !isAllowedImport(s)).map((s) => `${file}: ${s}`),
    );
    expect(violations).toEqual([]);
  });

  test("JSDoc examples in published .d.ts import only installable packages", () => {
    const violations = parsed
      .filter(({ file }) => /\.d\.m?ts$/.test(file))
      .flatMap(({ file, commentSpecifiers }) =>
        commentSpecifiers.filter((s) => !isAllowedExample(s)).map((s) => `${file}: ${s}`),
      );
    expect(violations).toEqual([]);
  });
});
