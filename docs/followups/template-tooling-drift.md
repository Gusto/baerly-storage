# Tooling-version drift across examples + docs

**Severity: MEDIUM. Pick one version per tool before public
publish. Today scaffolded apps inherit whichever shape the user
copies from.**

A pre-publish sweep should unify the version pins across the
four scaffoldable templates, the dev fixture, and the docs.

## TypeScript / vite / @vitejs/plugin-react / @types/node

Current state across the example trees (verified at the worktree
base):

| Manifest | typescript | vite | @vitejs/plugin-react | @types/node |
|---|---|---|---|---|
| `examples/helpdesk/package.json` | `5.7.2` | `^8.0.11` | `^6.0.0` | — |
| `examples/minimal-cloudflare/package.json` | `^5.8.0` | `^6.0.0` | — | — |
| `examples/minimal-node/package.json` | `^5.8.0` | `^6.0.0` | — | `^25.0.0` |
| `examples/helpdesk-cloudflare/package.json` | `^5.8.0` | `^6.0.0` | `^5.0.0` | — |
| **root `package.json`** | — | `^8.0.11` | — | `^25.6.2` |

Three live splits:

- **vite**: root + helpdesk on `^8`, the three scaffoldable
  templates on `^6`. Pick one — likely `^8` to match root.
- **@vitejs/plugin-react**: helpdesk `^6.0.0`, helpdesk-cloudflare
  `^5.0.0`. Couple to the chosen vite major.
- **typescript**: helpdesk pinned `5.7.2` (exact, not a range),
  the three templates `^5.8.0`. Pick one; the exact pin in
  helpdesk has no obvious justification.

**`@types/node`**: only `minimal-node` declares it, at `^25.0.0`.
The Docker add-on runtime is `node:24-bookworm-slim`. Pin to
`^24.x` so the types match the runtime users will actually deploy
on. (Root pins `^25.6.2`, which is fine for tooling but wrong as
the template default.)

## pnpm version is a 3-way split

Verified locations and pins:

| Location | pnpm version |
|---|---|
| Root `package.json:packageManager` | `pnpm@11.1.2` |
| All four template `package.json:packageManager` | `pnpm@11.1.2` |
| `packages/create-baerly/templates/addons/docker/Dockerfile:14` | `pnpm@10.31.0` |
| `examples/{minimal-cloudflare,minimal-node,helpdesk-cloudflare}/AGENTS.md` | `pnpm@10.31.0` |
| Root `CLAUDE.md` | `pnpm@10.31.0` |

Per memory (`project_pnpm11_ignored_builds_broken_on_main`),
11.1.2 is intentional — pnpm 11 fixed the `onlyBuiltDependencies`
→ `allowBuilds` rename. Align everything **up**.

## Fix

1. Pick the canonical versions:
   - `typescript: ^5.8.0` (drop the helpdesk pin to 5.7.2)
   - `vite: ^8.0.11`
   - `@vitejs/plugin-react: ^6.0.0` (coupled to vite 8)
   - `@types/node: ^24.0.0` (matches Docker runtime)
   - `pnpm@11.1.2` (already in manifests; align docs)

2. Update the four `examples/*/package.json` files. Update the
   Dockerfile per `docker-template-cleanups.md`. Update each
   `examples/*/AGENTS.md` and root `CLAUDE.md` to drop the
   `pnpm@10.31.0` references.

3. Run `pnpm install` once at root to refresh the lockfile.
   Re-run `pnpm verify` and `pnpm test` (the gates that catch
   real breakage — vite 6 → 8 is the riskiest bump).

4. Consider a CI/check script that diffs all `packageManager`
   declarations against root. The Dockerfile drift is recurring
   because nothing enforces it.
