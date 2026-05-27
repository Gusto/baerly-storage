# Cut `MockFetch` testing helper

**Severity: LOW. Pre-launch cut. Sophisticated-consumer territory
that the audience won't use.**

`MockFetch` is an in-memory request matcher for unit-testing
client code, shipped under the `baerly-storage/client/testing`
subpath.

- `/Users/eric.baer/workspace/baerly-storage/packages/client/src/testing/index.ts:29`

## The case for cutting

The audience doesn't write unit tests against a `BaerlyClient` —
they verify by clicking the deployed app or (rarely) by a top-level
integration test. The thesis §"Audience in practice" — internal
trackers, side projects, dashboards — doesn't include a "and they
write 200 unit tests against their data layer" persona.

For the sophisticated case, `vi.fn()` + raw `fetch` substitution
does the same job in three lines without baerly shipping a
dedicated testing surface. The principle from the deferred
changes-iterator memo §4: sophisticated escape hatches reach into
internals; baerly doesn't ship a polished surface for them.

This is the smallest of the cut candidates — it's a separate
subpath, so impact on the critical-path bundle is zero, and the
surface area to maintain is small. But it's still a public API
surface to maintain, document, and avoid breaking.

## What to do

1. Delete `packages/client/src/testing/` directory.
2. Remove the `baerly-storage/client/testing` subpath from
   `packages/client/package.json` (or wherever the subpath
   exports are declared).
3. Audit `packages/client/` tests for any consumer; rewrite to
   `vi.fn()` + raw fetch substitution.
4. Drop the subpath from any docs / READMEs.

## What gets harder after

- A user writing client-code unit tests has to wire `vi.fn()` for
  fetch. **Acceptable** — three lines, well-documented vitest
  pattern.

## Notes

This is a "small cut with low risk" candidate — good to land
alongside any of the higher-leverage cuts as filler.

## Related cuts

- Part of the **client public surface discipline** theme. Pairs
  with `cut-client-healthz.md` and
  `cut-client-options-redundant-paths.md`.
