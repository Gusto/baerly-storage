# docs/ conventions

Conventions for content under `docs/`.

## Source of truth
- Everything in `docs/` is hand-written.
- The public-API reference lives as JSDoc on
  `packages/server/src/db.ts` and `packages/server/src/table.ts`.
  IDE hover and `tsgo` consume it directly — there is no rendered
  markdown ref.

## Style
- Markdown line wrap ~80 chars (matches existing `sync_protocol.md` and
  `causal_consistency_checking.md`).
- Mermaid blocks render on GitHub — use them for diagrams.
- Inline code paths are `packages/<pkg>/src/<file>.ts` (relative to
  repo root).

## When to update which doc

| Change | File to update |
|---|---|
| New module / refactor | `docs/ARCHITECTURE.md` (graph + lifecycle) |
| New developer setup step | `docs/DEVELOPMENT.md` |
| New extension pattern | `docs/EXTENDING.md` |
| Protocol change | `docs/sync_protocol.md` (and a coverage entry in `docs/causal_consistency_checking.md`) |
| New `Db.create` / `Table<T>` option | JSDoc on the param in `packages/server/src/db.ts` or `packages/server/src/table.ts` |

## Don't

- ❌ Duplicate content between `CLAUDE.md` and `docs/*.md`. CLAUDE.md
  links out; long-form lives in `docs/`.
- ❌ Add screenshots without compressing — keep `docs/diagrams/` lean.
