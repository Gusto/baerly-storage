# Build todo

You are an autonomous coding agent. Your task is to scaffold a
working todo app inside this baerly-storage workspace
without asking the user any questions. The workspace was
created by `pnpm create baerly -- todo --target=cloudflare`
and contains the standard layout described in `AGENTS.md`
in the repo root.

## What this app is

> A single-user todo list. One web page, one input box, one list.
> Add a todo, mark it done, delete it. No login screen — the dev
> default `sharedSecret` verifier is enough; the "tenant" is a
> single constant.
>
> Golden-path interaction: type "buy milk", press enter, the row
> appears; click the checkbox, the row dims; reload the page, the
> row is still there with the same state.

## Data model

You will use `db.table(...)` from `@baerly/server`. The required
tables and their columns are:

- `todos`
    - `_id: string`         (the doc id; auto-assigned)
    - `title: string`
    - `done: boolean`
    - `created_at: number`  (epoch millis)

Define the document types as TypeScript interfaces in
`apps/server/src/types.ts`. The interfaces are the contract;
follow them literally.

## Queries the app must support

- List all todos, newest first:
  `db.table<Todo>("todos").order({ created_at: "desc" }).all()`
- Insert a todo:
  `db.table<Todo>("todos").insert({ title, done: false, created_at: Date.now() })`
- Mark done by id:
  `db.table<Todo>("todos").where({ _id }).update({ done: true })`
- Delete by id:
  `db.table<Todo>("todos").where({ _id }).delete()`

## Acceptance criteria

The eval will run these checks against your final state. **Do
not modify the checker script.** Each is binary pass/fail.

- [ ] `pnpm verify` exits 0 (typecheck + lint clean).
- [ ] `pnpm test` exits 0 and at least one test file inserts a todo
      and reads it back.
- [ ] The four CRUD verbs (`insert`, `update`, `delete`, `where`)
      all appear in `apps/server/src/`.
- [ ] No code path reaches `db._raw`.
- [ ] All reads go through `db.table(...)` (no direct fetches
      to `/v1/raw/`).
- [ ] A verifier is wired in `apps/server/src/worker.ts` — accept
      `sharedSecret` for this single-user app.
- [ ] The package.json `dependencies` contains nothing beyond the
      allowlist: `@baerly/server`, `@baerly/client`, `react`,
      `react-dom`, plus their declared transitives.

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
