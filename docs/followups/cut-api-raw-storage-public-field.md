# Move `Db._raw` from public field to friend export

**Severity: MEDIUM. Pre-launch cut. Public escape hatch for a
single in-repo consumer (`baerly export`) — should be a friend
export, not a public surface.**

`Db._raw: RawStorageApi` is a tenant-prefixed `Storage`-shaped
surface that bypasses log-emit, CAS, and schema. Documented
`@internal` but exported as a public field on `Db`.

- `/Users/eric.baer/workspace/baerly-storage/packages/server/src/db.ts:100-108,144`

## The case for cutting

This is exactly the "public type as escape hatch for sophisticated
callers" pattern the deferred changes-iterator memo argues against
(§4 "The remaining justification was an escape-hatch for a niche
we can't price"). The principle there: "escape hatches for power
users via lower-level primitives" — they should reach into
internals, not get a polished surface.

`_raw` is justified in ADR-002 by the `baerly export` graduation
path. But `baerly export` is in *this repo* and could call into
`Db.#storage` directly via a friend export, not via a public
field with `@internal` JSDoc that no agent will respect.

The risk: an LLM reading `Db`'s shape sees `db._raw.list(...)`
as a type-valid escape hatch and will reach for it the first
time the documented surface doesn't fit. That's exactly the
"redundant ceremony" pattern thesis §4 warns about, with the
twist that one of the paths is structurally unsafe (no CAS, no
log emit).

## What to do

1. Convert `_raw` from a public field on `Db` to a friend export
   under `packages/server/src/_internal/` (or wherever the
   internal seam lives).
2. Update `baerly export` to import via the friend path.
3. Audit for any other in-repo consumer; route them through the
   friend export too.
4. Update ADR-002 to reflect that the graduation-path escape
   hatch lives behind an internal import, not on the public
   `Db` shape.
5. Update `packages/server/API.md` — remove `_raw` from the
   public-API quickref entirely (it shouldn't be there).

## What gets harder after

- A user writing a one-off backfill script that wanted to bypass
  log emit can't. **Acceptable** — they should be writing via
  `Db`'s mutation surface; bypass-log scripts at prototype tier
  invariably break causal consistency.
- An LLM-authored app that reached for `db._raw` because the
  agent saw it in the type definition gets a TS error.
  **Net win** — that error is the correct signal.

## Notes

This cut is the smaller, safer end of the "public surface
discipline" theme. It costs almost nothing to land and removes
a footgun.
