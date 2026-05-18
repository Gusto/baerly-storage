# Build rsvp

You are an autonomous coding agent. Your task is to scaffold a
working rsvp app inside this baerly-storage workspace
without asking the user any questions. The workspace was
created by `pnpm create baerly -- rsvp --target=cloudflare`
(or `--target=node`, optionally with `--with=docker` — agent's
choice, but pick one and stick with it) and contains the standard
layout described in `AGENTS.md` in the repo root.

## What this app is

> A single event page (think "Alice and Bob's housewarming, June
> 14"). Logged-in users can RSVP yes / no / maybe and leave a name.
> The page shows the current count and the list of RSVPs. Built
> as a Cloudflare Worker behind Cloudflare Access **or** a Node
> deploy behind a JWKS endpoint — agent picks the target.
>
> Golden-path interaction: visit the URL, click "Yes", type "Eric",
> submit; the count goes from 4 to 5 and your name appears in the
> list.

## Data model

You will use `db.table(...)` from `@baerly/server`. The required
tables and their columns are:

- `rsvps`
    - `_id: string`
    - `event_id: string`     (single hardcoded value, e.g. "housewarming-2026")
    - `name: string`         (the verified user's display name)
    - `created_by: string`   (the verifier's `sub` claim)
    - `status: "yes" | "no" | "maybe"`
    - `created_at: number`

Define the document types as TypeScript interfaces in
`apps/server/src/types.ts`. The interfaces are the contract;
follow them literally.

## Queries the app must support

- List for the event:
  `db.table<Rsvp>("rsvps").where({ event_id }).all()`
- Count:
  `db.table<Rsvp>("rsvps").where({ event_id }).count()`
- Insert (server-side; the verifier's `sub` populates `created_by`):
  `db.table<Rsvp>("rsvps").insert({ event_id, name, created_by: sub, status, created_at: Date.now() })`

## Acceptance criteria

The eval will run these checks against your final state. **Do
not modify the checker script.** Each is binary pass/fail.

- [ ] `pnpm verify` exits 0.
- [ ] `pnpm test` exits 0.
- [ ] A real verifier is wired in `apps/server/src/worker.ts`:
      `cloudflareAccess` (CF target) OR `bearerJwt` (Node target).
      `sharedSecret` alone is NOT acceptable.
- [ ] Anonymous (no auth header) GET on the RSVP route is rejected
      with 401 or 403.
- [ ] RSVP docs carry a `created_by` audit field derived from the
      verifier's `sub` claim.
- [ ] No `db._raw` usage.
- [ ] All reads go through `db.table(...)`.

## Ground rules

- Do not ask the user questions. If something is ambiguous,
  pick the simpler option and proceed.
- Do not use web search. Everything you need is in this repo and
  in the `@baerly/server` and `@baerly/client` JSDoc.
- Do not skip tests or widen branded types from `@baerly/protocol`
  (`Ref`, `ManifestKey`, `UUID`, `VersionId`). Read
  `AGENTS.md` for the anti-pattern list.
- Use pnpm. Do not introduce npm or yarn lockfiles.
- Use vitest. Do not introduce jest, mocha, or `bun:test`.
- Keep changes scoped to `apps/server/`, `apps/web/`, and the
  workspace root files. Do not edit the existing scaffold's
  `package.json` `devDependencies` block.

When you believe the app meets every acceptance bullet, stop.
