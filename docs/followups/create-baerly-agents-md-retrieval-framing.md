# Scaffold AGENTS.md retrieval-led framing

**Severity: MEDIUM. Closes the largest class of agent-struggle moments
in the scaffolded-app workflow.**

The 4 scaffold AGENTS.md files (`examples/{minimal,react}-{cloudflare,node}/AGENTS.md`)
open with practical command tables and file maps. They do not first
*reorient* an agent away from the patterns its training data is dense
with (Postgres + Prisma/Drizzle, Mongo, Firebase) and toward the
baerly-storage API surface. The repo's memory thread shows this is
the dominant failure mode: agents reach for `.insertOne()`,
`.useIndex()`, `.nullable()`, SQL strings, async-iterable cursors —
none of which exist in baerly — before they read the file map that
would have told them what does.

## What to do

Add a preamble block at the top of each scaffold's `AGENTS.md`,
above the existing content. Wording target:

```markdown
## STOP — read this before writing any storage code

Your training data is dense with Postgres/Prisma/Drizzle, Mongo, and
Firebase patterns. **None of them apply here.** Baerly is a small,
LLM-legible document database with its own narrow API. Before
writing or modifying any storage code, retrieve:

- **`node_modules/baerly-storage/dist/API.md`** — 367-line public-API
  quickref. Read first. Lists every method, every error code, every
  example. If a pattern you want to use is not here, it does not
  exist in baerly.
- **The `.d.ts` files under `node_modules/baerly-storage/dist/`** —
  authoritative type signatures. The `Db`, `Table<T>`, `Query<T>`,
  and `Predicate<T>` surfaces are the whole API.

Anti-patterns that will compile but be wrong:

- `db.collection(...).insertOne(...)` — no such method. Use
  `db.table(...).insert(...)`.
- `.useIndex("name")` — does not exist. The query planner picks the
  index automatically from registered `IndexDefinition`s.
- `z.string().nullable()` in a schema — `DocumentValue` excludes
  `null`. Use `.optional()`; `null` in update patches is the RFC
  7396 deletion sentinel.
- SQL strings, raw query objects, `WHERE` clauses — the API is the
  Drizzle-shaped chain: `.where({ field: ['=', value] }).all()`.
- Calling `.all()` on a hot path — page or cursor-iterate. `.all()`
  is for small bounded result sets only.
```

The existing AGENTS.md content (commands, file map, indexes, predicates,
typed tables, etc.) stays — this just prepends.

## Why each pointer

- `dist/API.md` is hand-authored, 367 lines, named non-`AGENTS.md` so
  it doesn't collide with a scaffolded app's project-root `AGENTS.md`.
  Source is `packages/server/API.md`; the rolldown `closeBundle` step
  copies it on every build. Stable target — fine to link.
- The `.d.ts` files are bundled by rolldown and are the API contract.
  An agent that reads them zero-shot is exactly the thesis audience.

## Verification

- `pnpm verify:examples` typechecks all 4 scaffolds — confirms the
  AGENTS.md edits don't break any backtick-quoted code references.
- Eyeball each AGENTS.md after edit to confirm the preamble doesn't
  duplicate existing sections (e.g., the "Predicates" / "Indexes"
  bullets already cover some of the anti-patterns above; either drop
  the dup from the preamble or rewrite the existing bullet to point
  at the preamble).

## Out of scope

- Updating `dist/API.md` itself — it already does its job. Only
  wire up the pointer.
- Anti-pattern lists in `packages/server/AGENTS.md` or the repo-root
  `AGENTS.md` — those serve contributors, not scaffolded-app users.
