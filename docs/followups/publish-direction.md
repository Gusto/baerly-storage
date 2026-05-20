# Followups: publish direction (strategic, deferred)

**Status: open strategic question. Blocks A1/A3/A6 from the
2026-05-19 analyst triage.**

A 2026-05-19 Verdaccio publish landed (`3e67ff6`), making all
workspace packages `public`. The bundled `baerly-storage` npm
package is fed from `@baerly/server`, but every README, JSDoc
`@example`, template, and scaffolded app imports from
`@baerly/server`, `@baerly/adapter-node`, `@baerly/adapter-cloudflare`,
`@baerly/client`, `@baerly/dev`, `@baerly/protocol`, and
`@baerly/cli` — names that aren't published to public npm.

Until this is resolved, `npm install baerly-storage` followed by
the docs' code snippets produces apps that don't compile.

## The question

Pick a side.

### Option (a) — Publish `@baerly/*` to npm

- Publish each workspace package under the `@baerly` scope on
  the public registry.
- Either retire the root `baerly-storage` bundle, or make it a
  thin meta-package that just re-exports from `@baerly/server`.
- Pros: zero churn in docs / examples / templates / scaffolds.
- Cons: more packages to version + release. Sets up the
  `@baerly/*` namespace forever.
- Brief's recommended path.

### Option (b) — Rename `@baerly/*` → `baerly-storage[-*]`

- `@baerly/server` → fold into `baerly-storage`
- `@baerly/adapter-node` → `baerly-storage-adapter-node`
- `@baerly/adapter-cloudflare` → `baerly-storage-adapter-cloudflare`
- `@baerly/client` → `baerly-storage-client`
- `@baerly/dev` → `baerly-storage-dev`
- `@baerly/protocol` → fold inside `baerly-storage` (it's not
  meant to be a public API anyway — see A6)
- `@baerly/cli` → `baerly-storage-cli` (or fold into
  `baerly-storage/cli` subpath bin)
- Pros: flatter public surface. One project, one prefix.
- Cons: big mechanical rewrite of every README + `@example` +
  scaffolded import + manual-e2e + bench.

## Downstream tickets blocked by this decision

### A3. README "Quick start" can't be followed — HIGH

`README.md:14-23` admits `pnpm dlx create-baerly@latest`
"doesn't resolve end-to-end" and tells users to clone the repo
and scaffold from `examples/`. The "Or wire it by hand" snippet
imports `createListener` from `@baerly/adapter-node`,
`sharedSecret` from `@baerly/server/auth`, `LocalFsStorage` +
`ensureTable` from `@baerly/dev` — three workspace packages a
user can't install from public npm.

**Fix after direction lands:** rewrite Quick start to use
whichever name set ships publicly. Drop the "doesn't resolve"
admission once `create-baerly` actually resolves.

### A6. `@baerly/protocol` description says "Not a public API" but every example imports from it — HIGH

`packages/protocol/package.json:4` description:
`"Internal protocol kernel — implementation detail of
@baerly/server. Not a public API: import from @baerly/server
instead."` Yet 167 grep hits across `packages/`, `tests/`,
`examples/`, `eval/` import from `@baerly/protocol` —
`Verifier`, `Storage`, `DocumentData` directly.

**Fix after direction lands:**
- If (a): rewrite description to acknowledge it IS public,
  or re-export `Verifier`/`Storage`/`DocumentData` from
  `baerly-storage` and rewrite every example import.
- If (b): fold protocol into `baerly-storage` core; problem
  dissolves.
