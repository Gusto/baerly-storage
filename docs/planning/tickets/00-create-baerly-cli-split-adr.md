# 00 — ADR 0020: `create-baerly` and `@baerly/cli` split rationale

**One-liner.** Write a one-page ADR documenting why baerly-storage
ships two CLIs (`create-baerly` scaffolder, `@baerly/cli` runtime)
and cross-link it from the ADR index and `docs/README.md`.

**Estimated effort.** 0.5 day. **Risk.** Low (docs only).

---

> **Self-contained.** You don't need to consult any planning notes
> or chat logs. Everything you need is in this file, the repo
> (`docs/adr/README.md`, the two package directories), and the
> conventions referenced below.

## Why we're doing this

The `create-baerly` / `@baerly/cli` split has been re-litigated at
least once. The architectural reason — that `npm create <name>`
desugars to `npx create-<name>@latest` and **requires** a separate
package whose `bin` is named `create-<name>` — is not obvious from
reading the code, and the dep-footprint argument
(`create-baerly` ships zero workspace deps, `@baerly/cli` pulls
`@baerly/server`, `@baerly/protocol`, `@baerly/adapter-node`,
`aws4fetch`, `@xmldom/xmldom`) only becomes visible after reading
both `package.json` files side by side.

An ADR locks the rationale where future contributors (and agents)
will look first: `docs/adr/`. Without it, the question keeps
re-surfacing and someone eventually merges the two packages
"because they're both CLIs," which breaks the canonical
`npm create baerly@latest` on-ramp.

## Current state

- `docs/adr/README.md` is the index. Frontmatter shape (title,
  audience: `meta`, summary, last-reviewed, tags, related) is at
  the top of that file; the inline ADR body template is in its
  "Template" section near the bottom.
- Two existing ADRs to pattern-match shape:
  - `docs/adr/0018-tenant-cas-isolation.md`
  - `docs/adr/0019-api-surface-lock.md`
  Both use frontmatter `audience: adr`, plus `## Status` /
  `## Context` / `## Decision` / `## Consequences` sections.
- Numbering has gaps. 0020 is the next available number per the
  README's "Numbering has gaps from earlier ADRs that were merged
  into their natural homes" note.
- `docs/README.md` links to the ADR directory but does not list
  individual ADRs; the index in `docs/adr/README.md` is where the
  ADR-by-ADR list lives. Linking the new ADR from the index there
  is sufficient.

Relevant code anchors the ADR should cite (verify each before
writing the citation):

- `packages/create-baerly/package.json` — `bin: create-baerly`,
  `dependencies` are only `citty` + `picocolors`, no workspace deps.
- `packages/cli/package.json` — `bin: baerly`, depends on
  `@baerly/dev`, `@baerly/export`, `@baerly/protocol`,
  `@baerly/server` (workspace), plus `aws4fetch`, `@xmldom/xmldom`,
  `citty`, `jsonc-parser`, `picocolors`.
- `packages/cli/src/init.ts` — imports `defineConfig` from
  `create-baerly/config`. This is the typed boundary between the
  two packages: the scaffolder owns the config schema; the runtime
  CLI consumes it. Verify the import line and cite it.

## Implementation steps

1. Create `docs/adr/0020-create-baerly-and-cli-split.md` with the
   following structure (filling in the prose; cite verified file
   paths and line numbers from `Current state` above):

   ```markdown
   ---
   title: create-baerly and @baerly/cli split
   audience: adr
   summary: ADR 0020 — why scaffolding and runtime ship as separate packages.
   last-reviewed: 2026-05-14
   tags: [decision, adr, cli, dx]
   related: [README.md]
   ---

   # 0020 — create-baerly and @baerly/cli split

   ## Status

   Accepted (2026-05-14).

   ## Context

   <Explain the two onboarding paths users have: `npm create
   baerly@latest <name>` for fresh repos, `baerly init` for existing
   ones. Explain the npm-create convention: `npm create <foo>`
   desugars to `npx create-<foo>@latest` (cite npm's docs only if
   strictly necessary), which downloads a single package whose bin
   is `create-<foo>`. This is not a convention we can opt out of
   without giving up the canonical on-ramp. Note the industry
   pattern: Next.js (`create-next-app` + `next`), Vite (`create-vite`
   + `vite`), Astro (`create-astro` + `astro`), Cloudflare
   (`create-cloudflare` C3 + `wrangler`), Convex (`create-convex`
   + `convex`) all do the same split.>

   ## Decision

   <One paragraph. We keep two packages. `create-baerly` is the
   scaffolder (bin `create-baerly`, zero workspace deps so
   `npx create-baerly` is fast). `@baerly/cli` is the long-lived
   runtime (bin `baerly`, pulls server + adapter deps). The typed
   boundary between them is `create-baerly/config:defineConfig`,
   which `@baerly/cli/src/init.ts` consumes so a fresh `baerly
   init` emits the same config shape `create-baerly` does.>

   ## Consequences

   <Enumerate the wins (fast on-ramp; small scaffold bundle;
   independent versioning if needed; both onboarding paths
   supported) and the costs (two `package.json` files to keep
   coherent; the deploy-target manifest at
   `examples/<name>/.baerly/scaffold.json` is shared, so renames in
   the manifest field names must update both packages; an ADR
   exists for a reason — anyone considering a merge should read
   this first).>
   ```

2. Update `docs/adr/README.md`'s `## Index` section to add a line
   `- [0020 — create-baerly and @baerly/cli split](./0020-create-baerly-and-cli-split.md)`
   after the existing `0019` entry.

3. Bump `last-reviewed:` in the frontmatter of
   `docs/adr/README.md` to today's date (2026-05-14 or later — use
   the actual date the ADR lands).

## Conventions to follow

- ADR shape: frontmatter (title, audience, summary, last-reviewed,
  tags, related) plus `## Status` / `## Context` / `## Decision` /
  `## Consequences` per the template at the bottom of
  `docs/adr/README.md`.
- Cite file paths with line numbers in the format `path/file.ts:LL`
  (matches the convention used throughout `CLAUDE.md` and the
  existing ADRs).
- No outbound links to external blogs unless strictly necessary.
  Npm's `npm create` documentation is fine to link once if you
  want to anchor the "this is npm's design, not a convention we
  invented" claim, but the ADR should stand without it.
- Keep prose tight. ADR 0019 is ~80 lines; aim for similar density.

## Verification

```sh
# Renders as Markdown; frontmatter parses
head -10 docs/adr/0020-create-baerly-and-cli-split.md

# Index updated
grep -n "0020" docs/adr/README.md

# Format clean
pnpm format:check docs/adr/0020-create-baerly-and-cli-split.md
```

The ADR is "done" when:
- A reader who has never seen this repo can explain, after reading
  the ADR alone, why the two-package split exists.
- The index in `docs/adr/README.md` lists 0020.
- `pnpm verify` is clean (no implication on type-check, but
  oxfmt should pass on the new file).

## Out of scope

- Linking the ADR from any package-level `README.md`. The ADR is
  meta; consumers don't need to read it. Internal links from
  `docs/adr/README.md` are enough.
- Adding marketing copy about "first-touch DX." This ADR
  documents the architectural choice, not the product narrative.
- Mentioning publishing strategy (`pnpm pack` vs npm). Out of
  scope; that decision is captured in ticket 04 and is orthogonal
  to the split itself.

## Pointers

- `docs/adr/README.md` — index + template
- `docs/adr/0018-tenant-cas-isolation.md` — shape exemplar
- `docs/adr/0019-api-surface-lock.md` — shape exemplar
- `packages/create-baerly/package.json` — scaffolder manifest
- `packages/cli/package.json` — runtime CLI manifest
- `packages/cli/src/init.ts` — `defineConfig` import (the typed
  boundary)
