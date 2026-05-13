# Build chat

You are an autonomous coding agent. Your task is to scaffold a
working chat app inside this baerly-storage workspace
without asking the user any questions. The workspace was
created by `pnpm create baerly -- chat --target=cloudflare`
and contains the standard layout described in `AGENTS.md`
in the repo root.

## What this app is

> A Slack-style single-channel chat room. Anyone in the room sees
> messages from everyone else within roughly 2 seconds. Open the
> page in two browser windows; type in one; the message appears in
> the other within a couple of polls.
>
> Golden-path interaction: window A types "hello"; within 2 seconds
> window B sees "hello" appear at the bottom of its list without a
> reload.

## Data model

You will use `db.table(...)` from `@baerly/server`. The required
tables and their columns are:

- `messages`
    - `_id: string`
    - `body: string`
    - `sent_at: number`        (epoch millis; used for ordering)
    - `sender_sub: string`     (verifier's `sub`; trust source for display name)

Define the document types as TypeScript interfaces in
`apps/server/src/types.ts`. The interfaces are the contract;
follow them literally.

## Queries the app must support

- Initial backlog (last 50, oldest first):
  `db.table<Message>("messages").order({ sent_at: "asc" }).limit(50).all()`
- Long-poll for new messages (React hook):
  `useChanges(client, "messages")` from `@baerly/client/react`
  — OR direct: `client.since({ table: "messages", cursor })`
- Insert (server-side; sender_sub comes from the verifier, NOT
  the request body):
  `db.table<Message>("messages").insert({ body, sent_at: Date.now(), sender_sub: sub })`

## Acceptance criteria

The eval will run these checks against your final state. **Do
not modify the checker script.** Each is binary pass/fail.

- [ ] `pnpm verify` exits 0.
- [ ] `pnpm test` exits 0.
- [ ] A real verifier is wired (cloudflareAccess or bearerJwt).
- [ ] Long-poll is wired via `useChanges(client, "messages")` OR
      `client.since(...)` — NOT a `setInterval(... client.table().all())`
      busy poll.
- [ ] The sender's identifier on each message comes from the
      verifier (server-side), not from a client-controlled field.
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
