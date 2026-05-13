# Build bookmarks

You are an autonomous coding agent. Your task is to scaffold a
working bookmarks app inside this baerly-storage workspace
without asking the user any questions. The workspace was
created by `pnpm create baerly -- bookmarks --target=cloudflare`
and contains the standard layout described in `AGENTS.md`
in the repo root.

## What this app is

> A personal bookmark manager. Save a URL with a title and a list
> of tags. The home page is the bookmark list; it auto-refreshes
> every 5 seconds with **eventual consistency** to avoid hammering
> the bucket on every focus.
>
> Golden-path interaction: add a bookmark; reload the page; it's
> there; wait 5 seconds; the auto-refresh fires without forcing a
> strong-consistency round trip.

## Data model

You will use `db.table(...)` from `@baerly/server`. The required
tables and their columns are:

- `bookmarks`
    - `_id: string`
    - `url: string`
    - `title: string`
    - `tags: string[]`            (arrays in user docs are fine)
    - `domain: string`            (extracted from `url` at insert time)
    - `created_at: number`

Define the document types as TypeScript interfaces in
`apps/server/src/types.ts`. The interfaces are the contract;
follow them literally.

## Queries the app must support

- Home page (auto-refresh, eventual consistency):
  `db.table<Bookmark>("bookmarks").consistency("eventual").order({ created_at: "desc" }).all()`
- Post-insert refresh (default strong consistency):
  `db.table<Bookmark>("bookmarks").order({ created_at: "desc" }).all()`
- Insert (extract `domain` from `url` server-side):
  `db.table<Bookmark>("bookmarks").insert({ url, title, tags, domain: new URL(url).hostname, created_at: Date.now() })`
- Filter by domain (uses the secondary index):
  `db.table<Bookmark>("bookmarks").where({ domain: "twitter.com" }).useIndex("by_domain").all()`

## Acceptance criteria

The eval will run these checks against your final state. **Do
not modify the checker script.** Each is binary pass/fail.

- [ ] `pnpm verify` exits 0.
- [ ] `pnpm test` exits 0.
- [ ] The auto-refresh loop on the home page calls
      `.consistency("eventual")` explicitly.
- [ ] The post-insert refresh uses default (strong) consistency —
      does NOT carry `.consistency("eventual")` on the path that
      immediately follows an insert.
- [ ] The `domain` field is extracted at insert time, not at read
      time.
- [ ] `baerly.config.ts` declares an index named `by_domain` on
      the `bookmarks` collection's `domain` field.
- [ ] The domain-filter read path calls `.useIndex("by_domain")`.
- [ ] Tags are stored as `string[]` on the bookmark doc.
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
