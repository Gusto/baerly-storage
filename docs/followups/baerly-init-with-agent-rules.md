# Extend `baerly init` with opt-in `--with=agent-rules`

**Severity: MEDIUM. Closes the agent-onboarding gap for the "dropped
into an existing repo" path. Strictly opt-in — must not run by
default and must not run at `pnpm install` time.**

`baerly init` today drops a `baerly.config.ts` into the current
directory and exits (`packages/cli/src/init.ts`). That's correct for
"I'm wiring baerly into an existing project," but it leaves the
agent-onboarding story to the user. There's no pointer telling Claude
/ Cursor / Copilot that the code under
`node_modules/baerly-storage/dist/` is the source of truth, and no
warning that the patterns those agents' training data is densest with
(Postgres/Prisma/Drizzle, Mongo, Firebase) don't apply.

Scaffolded apps already get this via the per-scaffold `AGENTS.md`
shipped by `create-baerly`. `baerly init` users are on their own.

This ticket adds an explicit, reversible way to drop a small pointer
block into the user's agent rules — behind a flag they have to ask
for.

## Non-goals (the etiquette guardrails)

- **No postinstall mutation.** Nothing changes in the user's repo at
  `pnpm install` / `npm install` time. Ever.
- **No default-on.** A user who runs `baerly init` without the flag
  must see the same single-file write they see today.
- **No inlining `API.md`.** The block is ~15 lines, not 367. The
  point of bundling `dist/API.md` is that it's the canonical agent
  doc; the block just tells the agent it's there.
- **No editing files we didn't create without a delimited block.** If
  the user already has an `AGENTS.md` with their house style, we
  append a `<!-- baerly:start --> … <!-- baerly:end -->` block; we
  don't restructure their file.
- **No legacy `.cursorrules`.** Cursor recommends `.cursor/rules/*.md`
  now. Skip the deprecated single-file format.

## UX

```sh
baerly init --app=tickets --with=agent-rules
```

`--with=<addon>` matches the existing `create-baerly --with=docker`
precedent and leaves room for future add-ons (`--with=mcp` etc.).
Prefer this over a bespoke `--with-agent-rules` boolean.

Behavior:

1. **Target detection**, in this order:
   - `.claude/rules/` exists → write `.claude/rules/baerly.md` (new
     file, no merge).
   - Else `AGENTS.md` exists at repo root → append a delimited block.
   - Else `.cursor/rules/` exists → write `.cursor/rules/baerly.md`.
   - Else → create `AGENTS.md` at repo root containing just the
     block.
2. **Idempotent.** Inserted content is wrapped with
   `<!-- baerly:start --> … <!-- baerly:end -->` so a second run
   replaces in place rather than duplicating.
3. **Non-interactive.** In TTY mode without `--with=agent-rules`, do
   NOT prompt — the gating is the flag, not a wizard. If interactive
   selection ever lands, it belongs in `create-baerly`, not here.
4. **Existing `--force`** is for the config file. The block is
   always self-identifying, so we can always replace our own block
   without `--force`; only the `baerly.config.ts` overwrite remains
   gated.
5. **JSON envelope** (`--json`) grows
   `agentRules?: { path, action: "created" | "appended" | "replaced" | "noop" }`.

## What the block contains

Match the wording planned for the scaffold-AGENTS.md preamble (see
`docs/followups/create-baerly-agents-md-retrieval-framing.md`) so
there is one source of truth.

```markdown
<!-- baerly:start -->
## baerly-storage

This repo uses baerly-storage. Before writing or modifying storage code:

- Read **`node_modules/baerly-storage/dist/API.md`** — 367-line
  public-API quickref. Every method, every error code, every example.
  If a pattern you want to use is not here, it does not exist in
  baerly.
- Type contracts live in `node_modules/baerly-storage/dist/*.d.ts`.
  The whole API is `Db`, `Table<T>`, `Query<T>`, and `Predicate<T>`.

Anti-patterns that compile but are wrong:

- `db.collection(...).insertOne(...)` — no such method. Use
  `db.table(...).insert(...)`.
- `.useIndex("name")` — does not exist. The query planner picks
  indexes automatically from registered `IndexDefinition`s.
- `z.string().nullable()` — `DocumentValue` excludes `null`. Use
  `.optional()`; `null` in update patches is the RFC 7396 deletion
  sentinel.
- SQL strings, raw `WHERE` clauses — the API is the Drizzle-shaped
  chain: `.where({ field: ['=', value] }).all()`.
- `.all()` on a hot path — page or cursor-iterate. `.all()` is for
  bounded result sets only.
<!-- baerly:end -->
```

Extract the literal as a module-level constant; if `create-baerly`
ends up reusing it, move both call sites to a shared
`packages/cli/src/agent-rules-block.ts` (or `@baerly/cli`'s internal
surface).

## Implementation sketch

- `packages/cli/src/init.ts`:
  - Add `with: { type: "string", description: "Add-on to layer on top of init (e.g. agent-rules)." }`
    to `INIT_ARGS`. Validate the value is `"agent-rules"` (mirror the
    enum-style check used for `--target`).
  - Add `"with"` to `KNOWN_KEYS`.
  - After the existing `writeFile(outPath, ...)`, branch on
    `args.with === "agent-rules"` and call a new
    `writeAgentRulesBlock(cwd)` helper.
- `packages/cli/src/agent-rules.ts` (new, ~60 LoC):
  - `detectTarget(cwd): Promise<{ path: string; mode: "create" | "append" }>`
  - `writeAgentRulesBlock(cwd): Promise<{ path: string; action: "created" | "appended" | "replaced" }>`
  - Block-replace logic anchored on
    `<!-- baerly:start -->`/`<!-- baerly:end -->`. Treat absence as
    append/create; presence as in-place replace.
- `emitSuccess` envelope grows the `agentRules` field; JSON consumers
  can opt into reading it.

## Tests

`packages/cli/src/init.test.ts` already has the harness. Add cases:

- Without `--with=agent-rules`, no agent file is created or modified
  (regression-pin the opt-in contract — this is the most important
  test).
- `--with=agent-rules` in an empty dir → creates `AGENTS.md` with the
  block.
- `--with=agent-rules` with pre-existing root `AGENTS.md` containing
  user content → block is appended after the existing content; user
  content is byte-identical before the block.
- `--with=agent-rules` with pre-existing `.claude/rules/` directory
  → writes `.claude/rules/baerly.md`, leaves `AGENTS.md` alone.
- Second run of `--with=agent-rules` → idempotent (block replaced in
  place, file not doubled, surrounding user content untouched).
- Unknown `--with=foo` value → `InvalidConfig` exit code 1 with a
  helpful message listing valid add-ons.

## Out of scope

- Folding this into `create-baerly`. Different entry points: a
  scaffolded app gets its `AGENTS.md` at scaffold time and ships it
  in the user's repo; `baerly init` is the path for an
  already-existing repo that does NOT come from `create-baerly`.
  Share the block text via the shared template module, not the call
  sites.
- An MCP server (`baerly-mcp`). Future work, tracked separately if
  and when `docs.baerly.dev` exists.
- `llms.txt` at a docs site. Different surface (web-fetch by AI
  clients, not file-system retrieval); different ticket.
- Detecting and rewriting legacy `.cursorrules` (single-file).
  Cursor moved to `.cursor/rules/*.md`; the legacy path isn't worth
  the special case.

## Verification

- `pnpm test:agent` — the new `init.test.ts` cases.
- Manual: `cd $(mktemp -d) && node …/baerly init --app=foo --with=agent-rules`
  → confirm both `baerly.config.ts` and `AGENTS.md` land.
- Manual: re-run the same command → confirm `AGENTS.md` is
  byte-identical (idempotent).
- Manual: in a repo with a pre-existing `AGENTS.md`, run with the
  flag → confirm only the delimited block is appended; the user's
  existing content above is untouched.
