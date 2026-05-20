# Build notes

You are an autonomous coding agent. Your task is to scaffold a
working notes app inside this baerly-storage workspace
without asking the user any questions. The workspace was
created by `pnpm create baerly -- notes --target=cloudflare`
and contains the standard layout described in `AGENTS.md`
in the repo root.

## What this app is

> A personal Markdown notes app. Each note has a title, a body, and
> one tag. The home page shows the most-recently-edited 20 notes.
> A sidebar of tags lets the user click a tag to filter the list to
> notes carrying that tag.
>
> Golden-path interaction: create a note tagged "work"; create
> another tagged "home"; click "work" in the sidebar — only the
> work note shows.

## Data model

You will use `db.table(...)` from `@baerly/server`. The required
tables and their columns are:

- `notes`
    - `_id: string`
    - `title: string`
    - `body: string`          (Markdown source)
    - `tag: string`           (one tag per note; multi-tag is out of scope)
    - `created_at: number`    (epoch millis)
    - `updated_at: number`    (epoch millis; bumped on every update)

Define the document types as TypeScript interfaces in
`apps/server/src/types.ts`. The interfaces are the contract;
follow them literally.

## Queries the app must support

- Home page (20 most recently edited):
  `db.table<Note>("notes").order({ updated_at: "desc" }).limit(20).all()`
- Filtered by tag (auto-routes through the secondary index declared
  on the collection config):
  `db.table<Note>("notes").where({ tag: "work" }).all()`
- Insert:
  `db.table<Note>("notes").insert({ title, body, tag, created_at: now, updated_at: now })`
- Update (bump `updated_at`):
  `db.table<Note>("notes").where({ _id }).update({ title, body, tag, updated_at: Date.now() })`

## Acceptance criteria

The eval will run these checks against your final state. **Do
not modify the checker script.** Each is binary pass/fail.

- [ ] `pnpm verify` exits 0.
- [ ] `pnpm test` exits 0.
- [ ] `baerly.config.ts` declares an index named `by_tag` on the
      `notes` collection's `tag` field.
- [ ] The `notes` collection's `baerly.config.ts` entry declares
      the `by_tag` index in `indexes`; the read path uses the
      plain `.where({ tag })` chain (the planner picks the index
      off the config).
- [ ] `updated_at` is bumped on every update.
- [ ] The home read orders by `updated_at desc` and limits 20.
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
