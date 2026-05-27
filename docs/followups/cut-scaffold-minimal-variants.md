# Cut `minimal-cloudflare` and `minimal-node` scaffolds

**Severity: HIGH. Pre-launch cut. 4 scaffolds → 2. The README
already routes new users to `react-node`; the minimal variants
teach `innerHTML` re-rendering as the canonical UI pattern.**

Two schema-less "hello-world" scaffolds whose only differentiator
from the React variants is "no React" — a ~17-LoC
`src/web/main.ts` rendering count + Add-button via `innerHTML`.

- `/Users/eric.baer/workspace/baerly-storage/examples/minimal-cloudflare/`
  (entire tree)
- `/Users/eric.baer/workspace/baerly-storage/examples/minimal-node/`
  (entire tree)

## The case for cutting

The README directs new users to `examples/react-node/` and the
quickstart shows `--target=cloudflare` only. The audience builds
dashboards, trackers, internal tools (thesis §"Audience in
practice") — every single one has a UI.

A vanilla-TS-DOM scaffold teaches `innerHTML` re-rendering as the
canonical UI pattern (look at
`minimal-cloudflare/src/web/main.ts:18-25`). The agent will
copy-paste this. That's the *wrong* mental model to plant in the
audience's first encounter with baerly.

The minimal scaffolds also force four-way duplication on:

- `wrangler.jsonc` (CF variants)
- `tsconfig.*`
- `AGENTS.md` (565 + 483 lines, mostly identical to react-*
  siblings)
- Drift sentinels in `scaffold.test.ts` (`escapeHtml`/`<form`
  negative assertions around lines 731/759)

Dropping the minimals collapses 4 scaffolds → 2 (`react-cloudflare`,
`react-node`), kills 2/4 of the AGENTS.md duplication, and frees
`scaffold.test.ts` from the drift-sentinel ceremony.

## What to do

1. Delete `examples/minimal-cloudflare/` and `examples/minimal-node/`.
2. Drop their entries from `examples/README.md`.
3. Drop them from `packages/create-baerly/src/scaffold.ts`'s
   `STARTER_TO_EXAMPLE` map.
4. Drop their dist-mirror entries from `rolldown.config.ts`.
5. Drop the corresponding `scaffold.test.ts` sub-tests and
   drift sentinels.
6. Drop `pnpm verify:examples` rows for them.
7. Update CLAUDE.md's example tree references.
8. The CLI default starter shifts: if the user runs
   `pnpm create baerly my-app --target=cloudflare`, default to
   `react-cloudflare`. If they need a no-UI server, they delete
   `src/web/` in 30 seconds.

## What gets harder after

- A user who genuinely wants a server with no frontend has to
  delete the `src/web/` dir from a react scaffold. **Acceptable**
  — 30 seconds.
- The `vanilla-TS-DOM` learning path goes away. **Net win** —
  that path was teaching the agent to ship `innerHTML`-blasting
  UI code.

## Notes

This is the largest scaffold-side cut by lines of code (a couple
thousand each, plus their AGENTS.md duplicates). It also makes
`cut-scaffold-types-ts.md` automatic (the schemaless `types.ts`
shim exists only because the minimal scaffolds have no
Zod-derived row type — react variants don't need it).

## Related cuts

- Part of the **scaffold weight** theme.
- Pairs with `collapse-scaffold-agents-md.md` — cutting the
  minimal scaffolds halves the AGENTS.md duplication that doc
  is also addressing.
