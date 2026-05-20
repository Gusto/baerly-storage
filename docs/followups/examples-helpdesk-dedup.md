# Followups: helpdesk example duplication

**Source: 2026-05-19 analyst triage (H7).** Strategic-leaning —
pick a direction before reshaping either tree.

---

## H7. `examples/helpdesk/` largely duplicates `examples/helpdesk-cloudflare/`

**Severity: MEDIUM. Two trees, one app.**

`App.tsx`, `main.tsx`, `TicketList.tsx`, `TicketDetail.tsx`,
`TicketForm.tsx`, `types.ts`, `client.ts` are essentially
identical between:

- `examples/helpdesk/` — dev-only teaching fixture; single Vite
  process; Baerly HTTP listener mounted as middleware via
  `baerlyDev()` from `@baerly/dev/vite`; `LocalFsStorage`.
- `examples/helpdesk-cloudflare/src/web/` — Cloudflare-target
  scaffold; runs under wrangler.

The duplication is a maintenance trap: a UI tweak has to land
twice or it drifts.

## The question

### Option (a) — Delete `examples/helpdesk/`, replace with docs

Drop the dev-only tree. Document `baerlyDev()` + `useLiveQuery`
+ `LocalFsStorage` in `docs/guide/` with the seed/CRUD snippets
inlined. The Cloudflare variant becomes the canonical
"helpdesk" reference.

- Pros: kills the duplication. Less template surface to keep
  in sync.
- Cons: loses the "single Vite process, no wrangler, no
  cloudflare-account-required" first-touch path. That zero-
  account dev story is a real DX win.

### Option (b) — Reframe `examples/helpdesk/` as a 60-line getting-started

Strip the CRUD UI; keep just the seeded list view. The whole
point becomes demonstrating `baerlyDev()` + `useLiveQuery`
without ceremony. ~60 LOC, ~3 files. The Cloudflare tree
keeps the full UI.

- Pros: preserves the no-account first-touch story. Forces a
  cleaner teaching example.
- Cons: still a separate tree to maintain; the seed/types
  duplication doesn't fully go away.

## Recommendation

Option (b). The zero-cloudflare-account dev story is too
valuable to lose, and the brief's own framing — "today it's
neither" — points at "make it deliberately small" rather than
"make it deliberately gone."

But don't act until you've decided: today it's serving as both
"first-touch dev demo" *and* "full helpdesk reference," and
that overlap is exactly the maintenance trap.

## When acting

Verify before reshape:
- Which Vite plugin / scaffold variant the docs reference.
- Whether `examples/helpdesk/smoke.test.ts` is gating the
  default `pnpm test` (per I17 in the parked infra-cuts doc,
  the smoke-glob picks up only this one file).
- Whether `eval/` corpus apps import the helpdesk shape.
