/**
 * Anti-leak gate for the `Internal*Options` widenings.
 *
 * Each of `compact()` / `runGc()` / `runScheduledMaintenance()` takes a
 * narrow public options type, with an `Internal*Options` widening that
 * carries budget caps, clock seams, and the GC grace override. Those
 * widenings are meant to reach test fixtures and the CLI through the
 * `@baerly/server/_internal/testing` subpath, which is deliberately
 * absent from `publishConfig.exports`.
 *
 * The failure this catches is subtle: a widening only has to be
 * `export`ed from a module that HAPPENS to be a published entry point
 * for it to land in that entry's `.d.ts`. It then pulls its transitive
 * internal field types along structurally, even when those are not
 * themselves name-exported — so an external caller reaches every knob
 * with no cast and no `any`:
 *
 * ```ts
 * const o: InternalMaintenanceOptions = { gc: { graceMillis: 0 } };
 * await runScheduledMaintenance(args, o);
 * ```
 *
 * `graceMillis: 0` is the sharp edge. `GC_GRACE_PERIOD_MILLIS` states
 * that production MUST NOT go below the default outside a maintenance
 * window, because that risks deleting an anchor a writer is about to
 * find on retry. It is also a perfectly ordinary integer, so no input
 * validation in `runGc()` can distinguish it from a legitimate call —
 * keeping the type off the published surface is the only control.
 *
 * The gate has two layers, because each covers the other's blind spot:
 *
 *   1. A compile-time pin on the knob that actually risks data loss.
 *      `@ts-expect-error` fails `tsgo --noEmit` if the call ever STOPS
 *      being an error, so it pins the invariant itself rather than a
 *      naming convention. Narrow but exact.
 *   2. A name scan over every published entry `.d.ts`. Broad — it covers
 *      entries nobody thought to pin — but its predicate is the
 *      `Internal` prefix, which is a convention, not a contract. A
 *      widening named otherwise would pass.
 *
 * Layer 2 reads the built `dist/`, so it depends on the `pretest` build
 * the way `bundle-size.test.ts` does. Layer 1 resolves through the dev
 * `exports` map and needs no build.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { type MaintenanceArgs, runScheduledMaintenance } from "@baerly/server/maintenance";

const pkgRoot = resolve(__dirname, "../..");
const pkg = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf8")) as {
  publishConfig: { exports: Record<string, { types?: string }> };
};

/**
 * Collect the names an entry `.d.ts` exports. Handles `export {...}` and
 * `export type {...}`, the inline `type ` modifier, and `X as Y` (the
 * exported name is `Y`).
 *
 * Deliberately understands ONLY the trailing-brace form, which is what
 * rolldown-dts emits today: a source-level `export interface Foo` arrives
 * here as `declare interface Foo` plus a `Foo` entry in the trailing
 * block. Rather than grow a parser for declaration forms that never
 * appear, the caller asserts that precondition — see
 * {@link assertBraceExportShape}.
 */
const exportedNames = (source: string): string[] =>
  [...source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)]
    .flatMap((m) => m[1]!.split(","))
    .map((spec) => spec.trim().replace(/^type\s+/, ""))
    .map((spec) => (spec.includes(" as ") ? spec.slice(spec.lastIndexOf(" as ") + 4) : spec))
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

/**
 * Assert the emitter shape {@link exportedNames} depends on.
 *
 * Without this, the scan is unsound rather than merely incomplete: an
 * inline `export interface InternalFoo` or an `export * from ...`
 * produces no match, so the name silently vanishes and the entry passes
 * — and the `names.length > 0` non-vacuity check does NOT save us,
 * because unrelated brace exports on the same entry satisfy it.
 *
 * Asserting the precondition converts that silent degradation into a red
 * test: if rolldown-dts ever changes shape, a human looks.
 *
 * Stated as a closed allow list — every top-level `export` line must be
 * a brace re-export — rather than a deny list of declaration forms. A
 * deny list has to enumerate `interface | type | class | const |
 * function | enum | namespace | let | var | abstract class | default`
 * and stays wrong the moment TypeScript grows another one; each miss is
 * a silent pass, which is the exact failure this guard exists to
 * prevent. The allow list is closed in both directions and shorter.
 *
 * Line-anchored on purpose: entry `.d.ts` files are not all thin shims
 * (`./http` inlines ~1600 lines of `declare` + JSDoc), and a fenced
 * `@example` can contain `export default {...}` — always indented under
 * ` * `, so a true column-0 anchor skips it.
 */
const assertBraceExportShape = (source: string): void => {
  const exportLines = source.split("\n").filter((line) => line.startsWith("export"));
  expect(exportLines.length).toBeGreaterThan(0);
  expect(exportLines.filter((line) => !/^export\s+(?:type\s+)?\{/.test(line))).toEqual([]);
};

const publishedEntries = Object.entries(pkg.publishConfig.exports)
  .map(([subpath, cond]) => ({ subpath, types: cond.types }))
  .filter((e): e is { subpath: string; types: string } => e.types !== undefined);

describe("internal option widenings stay off the published type surface", () => {
  test("publishConfig declares at least one typed entry (guards a vacuous pass)", () => {
    expect(publishedEntries.length).toBeGreaterThan(0);
  });

  test.each(publishedEntries)("$subpath exports no Internal* name", ({ types }) => {
    const source = readFileSync(resolve(pkgRoot, types), "utf8");
    assertBraceExportShape(source);

    const names = exportedNames(source);
    // Non-vacuous: every published entry exports *something*.
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => n.startsWith("Internal"))).toEqual([]);
  });

  test("no `_internal/*` subpath is published", () => {
    // Scoped to the ROOT package's map (`@gusto/baerly-storage`), the only
    // one that ships: `@baerly/server` is `private: true`, so its own
    // `publishConfig` never executes and its `./_internal/*` subpaths are
    // in-repo-only by construction. What this guards is someone adding an
    // `_internal` subpath HERE to let bench/e2e reach internals through
    // the published package — which would ship the widenings wholesale.
    const internal = Object.keys(pkg.publishConfig.exports).filter((s) =>
      s.startsWith("./_internal"),
    );
    expect(internal).toEqual([]);
  });

  test("the published maintenance surface rejects the internal GC grace override", () => {
    // The exact invariant, pinned at compile time rather than by name.
    // `@baerly/server/maintenance` and the published `./maintenance`
    // subpath resolve to the same module (`packages/server/src/
    // maintenance.ts`), so this covers the shipped entry.
    //
    // Never invoked — the assertion IS the `@ts-expect-error`. It fails
    // `tsgo --noEmit` if this stops being a type error, i.e. if
    // `graceMillis` becomes reachable from the published options type
    // again. The runtime `expect` below only keeps the binding used.
    const reopenedLeak = (args: MaintenanceArgs) =>
      runScheduledMaintenance(
        args,
        // @ts-expect-error — `graceMillis` is an `InternalRunGcOptions`
        // knob; the published `RunGcOptions` is `{ signal? }` only.
        // GC_GRACE_PERIOD_MILLIS: production MUST NOT go below the default.
        { gc: { graceMillis: 0 } },
      );

    expect(reopenedLeak).toBeTypeOf("function");
  });
});
