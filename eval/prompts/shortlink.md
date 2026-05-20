# Build shortlink

You are an autonomous coding agent. Your task is to scaffold a
working shortlink app inside this baerly-storage workspace
without asking the user any questions. The workspace was
created by `pnpm create baerly -- shortlink --target=cloudflare`
and contains the standard layout described in `AGENTS.md`
in the repo root.

## What this app is

> A bit.ly clone. POST a long URL, get back a short code (6
> characters, base-32). GET the short URL and you 302 to the long
> URL. A stats page at `/admin/stats/:code` shows the click count
> and the last 100 click timestamps with referrer.
>
> Golden-path interaction: shorten `https://example.com/long/path`,
> get back `https://app.example.com/aB3cD9`; click that, you land
> on example.com; reload the stats page, the click count went from
> N to N+1.

## Data model

You will use `db.table(...)` from `@baerly/server`. The required
tables and their columns are:

- `links`
    - `_id: string`           (the 6-char short code — caller-supplied)
    - `target_url: string`
    - `owner: string`         (verifier's `sub`)
    - `created_at: number`
- `clicks`
    - `_id: string`           (auto-assigned per click)
    - `link_id: string`       (the link's short code)
    - `ts: number`            (epoch millis)
    - `referrer: string`

Define the document types as TypeScript interfaces in
`apps/server/src/types.ts`. The interfaces are the contract;
follow them literally.

## Queries the app must support

- Insert a link (caller-supplied `_id`):
  `db.table<Link>("links").insert({ _id: code, target_url, owner, created_at: Date.now() })`
- Resolve a link on redirect:
  `db.table<Link>("links").where({ _id: code }).first()`
- Record a click:
  `db.table<Click>("clicks").insert({ link_id: code, ts: Date.now(), referrer })`
- Stats page (latest 100 clicks for a link):
  `db.table<Click>("clicks").where({ link_id }).order({ ts: "desc" }).limit(100).all()`

## Acceptance criteria

The eval will run these checks against your final state. **Do
not modify the checker script.** Each is binary pass/fail.

- [ ] `pnpm verify` exits 0.
- [ ] `pnpm test` exits 0.
- [ ] Two collections exist: `links` and `clicks`.
- [ ] Link insert uses caller-supplied `_id` (the short code) —
      not a random `_id` with `short_code` as a sibling field.
- [ ] The stats page issues a server-side `.where({ link_id })` on
      `clicks` — it does NOT fetch all clicks and filter client-side.
- [ ] The link doc does NOT embed clicks as a growing array.
- [ ] No `db._raw` usage.
- [ ] All reads go through `db.table(...)`.

## Ground rules

- Do not ask the user questions. If something is ambiguous,
  pick the simpler option and proceed.
- Do not use web search. Everything you need is in this repo and
  in the `@baerly/server` and `@baerly/client` JSDoc.
- Do not skip tests or widen branded types from `@baerly/protocol`
  (`UUID`, `ContentVersionId`). Read
  `AGENTS.md` for the anti-pattern list.
- Use pnpm. Do not introduce npm or yarn lockfiles.
- Use vitest. Do not introduce jest, mocha, or `bun:test`.
- Keep changes scoped to `apps/server/`, `apps/web/`, and the
  workspace root files. Do not edit the existing scaffold's
  `package.json` `devDependencies` block.

When you believe the app meets every acceptance bullet, stop.
