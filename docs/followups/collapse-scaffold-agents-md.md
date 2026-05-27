# Collapse per-scaffold `AGENTS.md` duplication

**Severity: MEDIUM. Pre-launch trim. 2,363 LoC across 4 files,
mostly identical, with subtle drift. Most content is kernel
surface that belongs in `dist/API.md`.**

Four near-identical 500–700-line agent guides, each shipped per
scaffold and copied again as `CLAUDE.md`:

- `/Users/eric.baer/workspace/baerly-storage/examples/minimal-cloudflare/AGENTS.md`
  (~565 LoC)
- `/Users/eric.baer/workspace/baerly-storage/examples/minimal-node/AGENTS.md`
  (~483 LoC)
- `/Users/eric.baer/workspace/baerly-storage/examples/react-cloudflare/AGENTS.md`
  (~691 LoC)
- `/Users/eric.baer/workspace/baerly-storage/examples/react-node/AGENTS.md`
  (~624 LoC)

Plus the manifest's `copies` entry that mirrors each file to
`CLAUDE.md` at scaffold time.

## The case for cutting

Thesis #4: "small enough that an LLM can hold the whole `.d.ts`
in context." `dist/API.md` is the canonical 367-line quickref
the AGENTS.md files already point to for kernel surface (per
memory entry `Agent-struggle moments #4/#5/#6/#7 triage`).

The bulk of each AGENTS.md is *kernel surface* (predicates,
indexes, consistency, errors, HTTP wire format) duplicated four
ways with subtle drift. The "Worked extensions" block is
identical between `react-cloudflare` and `react-node` and is the
only genuinely scaffold-specific content.

Subtle drift is the real cost: when the kernel changes (e.g.
the get-by-id split, the `$in` operator, the `consistency`
modifier if we keep it), four AGENTS.md files have to update in
lockstep. They invariably don't.

## What to do

1. Collapse each scaffold's `AGENTS.md` to ~80 LoC of
   target-specific content only:
   - Deploy recipe (`pnpm baerly deploy` for CF, the PaaS
     options + `node server.js` for Node).
   - Auth wiring (CF Access vs JWKS vs shared-secret).
   - Vite/wrangler config gotchas specific to the target.
2. Point at `node_modules/baerly-storage/dist/API.md` as the
   canonical kernel surface reference.
3. Drop the kernel-surface sections (predicates, indexes,
   consistency, HTTP wire format) from each AGENTS.md — the
   audience reads them via `dist/API.md`.
4. If the "Worked extensions" block is genuinely valuable, lift
   it to `dist/API.md` once (so all scaffolded apps see it via
   the same path).
5. Update the manifest's `copies` entry — same path, slimmer
   file.

## What gets harder after

- An LLM working inside a scaffolded app has to read
  `node_modules/baerly-storage/dist/API.md` for kernel surface.
  **Net win** — they should be reading it anyway; AGENTS.md was
  duplicating it.
- Adding a new scaffold-specific recipe lives in one place per
  scaffold rather than buried in 600 lines. **Net win.**

## Notes

If `cut-scaffold-minimal-variants.md` lands, this cut shrinks
proportionally — 2 AGENTS.md files instead of 4, with all the
kernel-surface duplication gone.

## Related cuts

- Part of the **scaffold weight** theme.
- Pairs especially well with `cut-scaffold-minimal-variants.md`.
