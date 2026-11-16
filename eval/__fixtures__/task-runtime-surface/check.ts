import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Verdict } from "../../types.ts";

export async function check(): Promise<Verdict> {
  const root = new URL("../../../", import.meta.url);
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  for (const [subpath, target] of Object.entries(pkg.publishConfig.exports)) {
    const specifier = subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`;
    const expected = new URL((target as { import: string }).import, root).href;
    const actual = import.meta.resolve(specifier);
    if (actual !== expected) {
      return {
        pass: false,
        reason: `${specifier} resolved to ${fileURLToPath(actual)}, expected ${fileURLToPath(expected)}`,
      };
    }
  }
  return { pass: true, reason: "every published subpath resolves to its built runtime" };
}
