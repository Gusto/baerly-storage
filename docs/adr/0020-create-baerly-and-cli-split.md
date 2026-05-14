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

Baerly exposes two onboarding paths. A fresh repo runs
`npm create baerly@latest <name> -- --target=<cloudflare|node>` and
gets a scaffolded app. An existing repo runs `baerly init --app=<name>
--target=<cloudflare|node>` and gets a `baerly.config.ts` dropped next
to its existing source. Both paths must agree on the same config
shape, since the long-lived runtime CLI (`baerly deploy`, `baerly
doctor`, `baerly admin …`) reads that file on every invocation.

The `npm create <foo>` invocation is not a baerly convention — it is
npm's. `npm create <foo>` desugars to `npx create-<foo>@latest`, so
the canonical on-ramp **requires** a separately published package
whose `bin` is `create-<foo>`. Folding the scaffolder into the
runtime CLI would force users onto a non-canonical entry point
(`npx @baerly/cli create …` or similar), which loses the discovery
property that "every modern framework's getting-started page starts
with `npm create <thing>`."

The split is also the industry pattern. Next.js ships
`create-next-app` separately from `next`; Vite ships `create-vite`
separately from `vite`; Astro ships `create-astro` alongside
`astro`; Cloudflare's C3 (`create-cloudflare`) sits alongside
`wrangler`; Convex ships `create-convex` alongside `convex`. The
dep-footprint argument explains why a scaffolder runs once and
exits, so it pays to keep its install set tiny; a long-lived
runtime CLI pulls server, adapter, and protocol dependencies on
every invocation. Mixing the two means the one-shot scaffold pays
the runtime CLI's dep cost on every `npx create-baerly` run.

The split has been re-litigated at least once in this repo because
the rationale is not obvious from reading either package in
isolation — both directories look like "a CLI." This ADR pins the
rationale where future contributors will look first.

## Decision

Ship two packages:

- **`create-baerly`** is the scaffolder
  ([`packages/create-baerly/package.json:7-12`](../../packages/create-baerly/package.json)).
  `bin: create-baerly`; runtime dependencies are exactly `citty`
  and `picocolors`; zero workspace deps. The thin install set keeps
  `npx create-baerly@latest` fast on a fresh machine.
- **`@baerly/cli`** is the long-lived runtime CLI
  ([`packages/cli/package.json:7-30`](../../packages/cli/package.json)).
  `bin: baerly`; depends on `@baerly/server`, `@baerly/protocol`,
  `@baerly/dev`, `@baerly/export` (workspace), plus `aws4fetch`,
  `@xmldom/xmldom`, `citty`, `jsonc-parser`, and `picocolors`. This
  is the CLI that ships `init`, `deploy`, `doctor`, `export`, and
  the `admin` subcommands; it pays the protocol-kernel dep cost
  because it actually runs against live storage.

The typed boundary between the two packages is the
`create-baerly/config` subpath export
([`packages/create-baerly/package.json:19-22`](../../packages/create-baerly/package.json)),
which exposes `defineConfig` and the `BaerlyAppConfig` interface
([`packages/create-baerly/src/config.ts:11-50`](../../packages/create-baerly/src/config.ts)).
Both onboarding paths emit a `baerly.config.ts` that imports from
this entry point: the scaffolder writes it directly, and `baerly
init`'s emitted template
([`packages/cli/src/init.ts:59-66`](../../packages/cli/src/init.ts))
hard-codes the same `import { defineConfig } from
"create-baerly/config"` line. The runtime CLI parses the resulting
config back via its own validator
([`packages/cli/src/config.ts:1-9`](../../packages/cli/src/config.ts))
without taking a runtime dep on `create-baerly` — the two sides agree
on the wire shape informally, with the scaffolder owning the source
of truth for the field set.

## Consequences

- `npx create-baerly@latest …` stays on a thin install set: two
  transitive deps, no workspace pulls. Reverting this would re-couple
  scaffold-time install cost to the runtime CLI's dep graph.
- Both onboarding paths emit the same `baerly.config.ts` shape, so a
  user who runs `npm create baerly` and a user who runs `baerly init`
  end up at the same `baerly deploy` / `baerly doctor` surface.
- Two `package.json` files to keep coherent. Adding a new
  `BaerlyAppConfig` field means editing
  [`packages/create-baerly/src/config.ts`](../../packages/create-baerly/src/config.ts)
  (the schema), the scaffolder's emitter, the `baerly init` template
  in
  [`packages/cli/src/init.ts`](../../packages/cli/src/init.ts), and
  the validator in
  [`packages/cli/src/config.ts`](../../packages/cli/src/config.ts).
  The intentional duplication of the runtime validator keeps the CLI
  free of a `create-baerly` runtime dep
  ([`packages/cli/src/deploy/node.ts:56-75`](../../packages/cli/src/deploy/node.ts)).
- The per-target scaffold manifest lives at
  `examples/<example>/.baerly/scaffold.json` and is read by the
  scaffolder. Renames in the manifest's field names — sentinels,
  copy exclusions, devDep drops — must update both packages: the
  scaffolder reads them, and any CLI surface that consults the
  manifest at deploy time (today: none; tomorrow: possibly
  `baerly doctor`) reads them too. The shared file is the contract.
- Independent versioning is possible if it becomes useful. Today
  both packages live at `0.0.0` and ship together; nothing in the
  split forces lockstep releases.
- An ADR exists for a reason. Anyone considering merging the two
  packages "because they're both CLIs" should read this first, then
  consult the industry-pattern citations above before opening a
  supersession ADR.
