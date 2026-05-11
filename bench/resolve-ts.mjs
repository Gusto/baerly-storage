// Node ESM resolver hook for the bench harness. The protocol package
// (`packages/protocol`) is authored against a bundler workflow and its
// internal relative imports omit file extensions (e.g.
// `export * from "./constants"`). Node 24's stable type-stripping
// loads `.ts` files but the resolver does not auto-append the `.ts`
// extension, so loading `@baerly/protocol` via plain `node` fails
// with ERR_MODULE_NOT_FOUND on every transitive import.
//
// This hook only fires for relative or absolute file specifiers that
// lack a known extension; for everything else (`node:fs`, `aws4fetch`,
// `@baerly/protocol`) it delegates to the default resolver. Wired in
// via `node --import bench/register-hooks.mjs bench/r2-contention.ts`.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KNOWN_EXTS = [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs"];

function hasKnownExt(spec) {
  return KNOWN_EXTS.some((e) => spec.endsWith(e));
}

export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) &&
    !hasKnownExt(specifier)
  ) {
    try {
      const parent = context.parentURL ?? `file://${process.cwd()}/`;
      const tsUrl = new URL(specifier + ".ts", parent);
      if (existsSync(fileURLToPath(tsUrl))) {
        return nextResolve(specifier + ".ts", context);
      }
      // Also try `<spec>/index.ts` for bare directory imports.
      const indexUrl = new URL(specifier + "/index.ts", parent);
      if (existsSync(fileURLToPath(indexUrl))) {
        return nextResolve(specifier + "/index.ts", context);
      }
    } catch {
      // Fall through to default resolver.
    }
  }
  return nextResolve(specifier, context);
}
