# Extend `pnpm create baerly .` (bolt-on path) with `--with=agent-rules`

**Severity: MEDIUM. Closes the agent-onboarding gap for the
"dropped into an existing repo" path. Strictly opt-in.**

`pnpm create baerly .` in an existing wrangler project (bolt-on mode)
patches `wrangler.jsonc`, seeds `.dev.vars`/`.gitignore`, appends
`baerly-storage` to `package.json`, writes `baerly.config.ts`, and
prints the worker-entry snippet. What it does NOT do is tell the
user's AI agents (Claude / Cursor / Copilot) that the code under
`node_modules/baerly-storage/dist/` is the source of truth and that
the patterns those agents' training data is densest with
(Postgres/Prisma/Drizzle, Mongo, Firebase) don't apply.

Scaffolded apps already get this via the per-template `AGENTS.md`
shipped by `create-baerly`'s scaffold path. Bolt-on users — i.e.,
people adopting baerly into an existing repo — are on their own.

This ticket adds an opt-in `--with=agent-rules` add-on to the bolt-on
flow (matching the existing `--with=docker` precedent in the scaffold
path).

## Non-goals (the etiquette guardrails)

- **No postinstall mutation.** Nothing changes in the user's repo at
  `pnpm install` / `npm install` time. Ever.
- **No default-on.** A user who runs `pnpm create baerly .` without
  the flag must see only the changes documented in
  `docs/guide/add-to-existing-cf-worker.md`.
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
pnpm create baerly . --with=agent-rules
```

`--with=<addon>` already exists in `create-baerly` (`--with=docker`
for the scaffold-mode Dockerfile add-on). Bolt-on mode currently
ignores `--with` flags; this ticket adds `agent-rules` as the first
bolt-on-mode-aware add-on. Leaves room for future add-ons
(`--with=mcp` etc.).

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
3. **Non-interactive in flag mode.** Without `--with=agent-rules`, no
   prompt — the gating is the flag, not a wizard. The wizard COULD
   add a "drop agent rules?" confirm in bolt-on mode (today the
   wizard only asks `install`); pick whichever shape ships first.
4. **JSON envelope** (`--json`) grows
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

Extract the literal as a module-level constant; if the scaffold
`AGENTS.md` templates eventually consume it too, move both call sites
to a shared `agent-rules-block.ts` (in `packages/create-baerly/src/`
or a shared `@baerly/cli` subpath).

## Implementation sketch

- `packages/create-baerly/src/bolt-on.ts`:
  - Add an `agentRules?: boolean` option to `BoltOnOptions`.
  - After the existing side-effects, branch on `opts.agentRules ===
    true` and call a new `writeAgentRulesBlock(outDir)` helper.
- `packages/create-baerly/src/runner.ts`:
  - Detect `args.with` containing `agent-rules` and thread it into
    `dispatchBoltOn`.
- `packages/create-baerly/src/agent-rules.ts` (new, ~60 LoC):
  - `detectAgentRulesTarget(outDir): Promise<{ path: string; mode: "create" | "append" }>`
  - `writeAgentRulesBlock(outDir): Promise<{ path: string; action: "created" | "appended" | "replaced" }>`
  - Block-replace logic anchored on
    `<!-- baerly:start -->`/`<!-- baerly:end -->`. Treat absence as
    append/create; presence as in-place replace.
- `BoltOnResult` grows the `agentRules` field; the JSON envelope
  exposes it.

## Tests

Add to `packages/create-baerly/src/bolt-on.test.ts`:

- Without `--with=agent-rules`, no agent file is created or modified
  (regression-pin the opt-in contract — this is the most important
  test).
- `--with=agent-rules` in an empty dir (no AGENTS.md / no
  .claude/rules) → creates `AGENTS.md` with the block.
- `--with=agent-rules` with pre-existing root `AGENTS.md` containing
  user content → block is appended after the existing content; user
  content is byte-identical before the block.
- `--with=agent-rules` with pre-existing `.claude/rules/` directory
  → writes `.claude/rules/baerly.md`, leaves `AGENTS.md` alone.
- Second run of `--with=agent-rules` → idempotent (block replaced in
  place, file not doubled, surrounding user content untouched).
- Unknown `--with=foo` value → already rejected by existing
  `KNOWN_ADDONS` check in `runner.ts`; add `agent-rules` to that set.

## Out of scope

- An MCP server (`baerly-mcp`). Future work, tracked separately if
  and when `docs.baerly.dev` exists.
- `llms.txt` at a docs site. Different surface (web-fetch by AI
  clients, not file-system retrieval); different ticket.
- Detecting and rewriting legacy `.cursorrules` (single-file).
  Cursor moved to `.cursor/rules/*.md`; the legacy path isn't worth
  the special case.

## Verification

- `pnpm test:agent` — the new bolt-on.test.ts cases.
- Manual: in a freshly-scaffolded `pnpm create cloudflare` project,
  `pnpm create baerly . --with=agent-rules` → confirm both
  `baerly.config.ts` and `AGENTS.md` land.
- Manual: re-run the same command → confirm `AGENTS.md` block is
  byte-identical (idempotent).
- Manual: in a repo with a pre-existing `AGENTS.md`, run with the
  flag → confirm only the delimited block is appended; the user's
  existing content above is untouched.
