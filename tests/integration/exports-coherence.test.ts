/**
 * Packaging-contract coherence gate. The public entrypoint list is
 * hand-maintained in two package.json maps that must stay in lockstep:
 *   1. `exports`               (dev tree → packages/src)
 *   2. `publishConfig.exports` (shipped → dist)
 * A subpath added to one and forgotten in the other drifts silently: the
 * dev map is what source-mode consumers resolve against, and attw only
 * validates the PUBLISHED map — so a dev-only drift is invisible to the
 * publish gate. This test makes that drift a red default-project run.
 *
 * Scope: this only asserts the two maps declare the SAME subpaths. The
 * published-entry ↔ rolldown-input correspondence is covered elsewhere
 * (attw via verify:package + the repaired bundle-no-live-import walk that
 * reads every published dist), so we deliberately do NOT import
 * rolldown.config.ts here — that would pull the native bundler + dts/license
 * plugins into the test worker for a check two other gates already make.
 * No dist/ needed.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const pkgRoot = resolve(__dirname, "../..");
const pkg = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf8")) as {
  exports: Record<string, unknown>;
  publishConfig: { exports: Record<string, unknown> };
};

describe("exports map coherence", () => {
  test("dev exports and publishConfig.exports declare identical subpaths", () => {
    const dev = Object.keys(pkg.exports).toSorted();
    const published = Object.keys(pkg.publishConfig.exports).toSorted();
    expect(published).toEqual(dev);
  });
});
