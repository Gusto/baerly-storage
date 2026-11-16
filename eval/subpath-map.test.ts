/**
 * Drift guard: every subpath in publishConfig.exports must appear as a literal
 * string in both eval/resolve-package.mjs (SUBPATH_TO_DIST) and eval/check.ts
 * (subpathToEntry). A newly-added subpath that isn't wired into those maps would
 * silently make the eval's typecheck / runtime disagree with the published package.
 *
 * No dist/ required; no key; runs in the default vitest project.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

const pkgJson = JSON.parse(readFileSync(`${repoRoot}/package.json`, "utf8")) as {
  publishConfig?: { exports?: Record<string, unknown> };
};
const exportKeys = Object.keys(pkgJson.publishConfig?.exports ?? {});

const resolveSrc = readFileSync(`${repoRoot}/eval/resolve-package.mjs`, "utf8");
const checkSrc = readFileSync(`${repoRoot}/eval/check.ts`, "utf8");

const PKG = "@gusto/baerly-storage";

describe("eval subpath-map drift guard", () => {
  test("publishConfig.exports has more than 5 non-root subpaths (parse sanity)", () => {
    const nonRoot = exportKeys.filter((k) => k !== ".");
    expect(nonRoot.length).toBeGreaterThan(5);
  });

  test('root "." subpath: bare package name mapped in resolve-package.mjs', () => {
    expect(resolveSrc).toContain(`"${PKG}"`);
  });

  test('root "." subpath: bare package name mapped in check.ts', () => {
    expect(checkSrc).toContain(`"${PKG}"`);
  });

  for (const subpath of exportKeys.filter((k) => k !== ".")) {
    test(`non-root subpath ${subpath} appears in resolve-package.mjs`, () => {
      expect(resolveSrc, `resolve-package.mjs missing subpath ${subpath}`).toContain(
        `"${subpath}"`,
      );
    });

    test(`non-root subpath ${subpath} appears in check.ts`, () => {
      expect(checkSrc, `check.ts missing subpath ${subpath}`).toContain(`"${subpath}"`);
    });
  }
});
