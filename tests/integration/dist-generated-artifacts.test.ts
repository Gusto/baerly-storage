import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = resolve(__dirname, "../..");
const read = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), "utf8"));

describe("dist generated artifacts are fresh vs the package version", () => {
  const pkgVersion = read("package.json").version as string;

  // `check-spec-drift` (in `verify`, not `test`) enforces that the
  // checked-in spec's `serverVersion` equals `package.json`'s version — it
  // reads the live `package.json` and byte-compares. But `check-spec-drift`
  // never inspects `dist/`. This test is the test-suite tripwire for the
  // rolldown `closeBundle` copy step (validating dist is byte-identical to
  // the checked-in source).
  test("dist/baerly.spec.json serverVersion matches package version", () => {
    const distSpec = resolve(ROOT, "dist/baerly.spec.json");
    if (!existsSync(distSpec)) {
      throw new Error("dist/baerly.spec.json missing — run `pnpm build` before `pnpm test`");
    }
    expect(read("dist/baerly.spec.json").serverVersion).toBe(pkgVersion);
  });

  test("checked-in spec is byte-identical to the shipped dist copy", () => {
    expect(readFileSync(resolve(ROOT, "dist/baerly.spec.json"), "utf8")).toBe(
      readFileSync(resolve(ROOT, "packages/server/spec/baerly.spec.json"), "utf8"),
    );
  });
});

// `version-matrix.json`'s `packageSemver` freshness is not duplicated here —
// it's owned by `scripts/check-version-matrix.ts`, which is wired into
// `verify:rest` (so `pnpm verify` / CI / `verify:agent`), the lefthook
// pre-commit hook, and the release gate. Adding a second hard-coded
// assertion of the same fact here would just be two places that can drift
// from each other.
