# Scaffolding eval prompts

One Markdown file per corpus app. The eval runner
(`pnpm eval:run` — see ticket 84) loads these verbatim and feeds
them to Claude Code (`claude --print`) and Codex CLI
(`codex exec`).

**Do not edit a prompt to make a failing run pass.** The prompt
is the experimental variable; mutating it post-hoc invalidates
the comparison. If a prompt is buggy, fix it, and re-run all the
trials that used the old version.

| File | App | What it stresses |
|---|---|---|
| `todo.md` | todo | CRUD baseline + sharedSecret |
| `notes.md` | notes | Secondary index (`by_tag`) |
| `rsvp.md` | rsvp | Real verifier (cloudflareAccess / bearerJwt) |
| `chat.md` | chat | Long-poll subscription |
| `shortlink.md` | shortlink | Two-table denormalization |
| `kanban.md` | kanban | Transactions + Conflict + eventual consistency |
| `bookmarks.md` | bookmarks | Eventual consistency on hot path + derived-field index |
