# Build kanban

You are an autonomous coding agent. Your task is to scaffold a
working kanban app inside this baerly-storage workspace
without asking the user any questions. The workspace was
created by `pnpm create baerly -- kanban --target=cloudflare`
and contains the standard layout described in `AGENTS.md`
in the repo root.

## What this app is

> A single-board Kanban with three columns (Todo, Doing, Done) and
> drag-and-drop. Each card has a title and a column. The board is
> shared among signed-in users. When two users move the same card
> simultaneously, the move that lost the race must be detectable
> — it should not silently overwrite.
>
> Golden-path interaction: open two windows authed as two different
> users; both drag the same card; one wins, the other gets a
> visible "this card was moved" indicator and the board re-renders
> to the winning state.

## Data model

You will use `db.table(...)` from `@baerly/server`. The required
tables and their columns are:

- `cards`
    - `_id: string`
    - `title: string`
    - `column: "todo" | "doing" | "done"`
    - `created_by: string`        (verifier's `sub`)
    - `created_at: number`
    - `updated_at: number`        (bumped on every move)

Define the document types as TypeScript interfaces in
`apps/server/src/types.ts`. The interfaces are the contract;
follow them literally.

## Queries the app must support

- Initial board fetch (eventual consistency, the first paint can
  be one pointer stale):
  `db.table<Card>("cards").consistency("eventual").all()`
- Move a card (must be inside a transaction; reads current column
  before writing the new one so a conflict surfaces):
  `db.transaction("cards", async (tx) => {
    const card = await tx.where({ _id }).first();
    if (!card) throw new Error("missing");
    await tx.where({ _id }).update({ column: newColumn, updated_at: Date.now() });
  })`
- Long-poll re-render (so the OTHER window sees the move):
  `useLiveQuery({ table: "cards" })` from `baerly-storage/client/react`
  (or `useInvalidationTick({ table: "cards" })` if you want to
  invalidate a custom store). Wrap your app once in
  `<BaerlyProvider client={client}>` near the root.
- The move handler catches `BaerlyError` with `code === "Conflict"`
  and surfaces it to the client.

## Acceptance criteria

The eval will run these checks against your final state. **Do
not modify the checker script.** Each is binary pass/fail.

- [ ] `pnpm verify` exits 0.
- [ ] `pnpm test` exits 0.
- [ ] A real verifier is wired.
- [ ] The move handler is wrapped in `db.transaction("cards", ...)`
      AND reads the card's current column before writing.
- [ ] The handler catches `BaerlyError` with `code === "Conflict"`
      and returns a 409 (or equivalent) to the client.
- [ ] The initial board fetch uses `.consistency("eventual")`.
- [ ] Long-poll re-render is wired via `useLiveQuery`,
      `useInvalidationTick`, or `client.since(...)`.
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
