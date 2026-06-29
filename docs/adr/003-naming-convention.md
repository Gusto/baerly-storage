---
title: Baerly-prefix naming convention
audience: adr
doc_type: adr
summary: ADR 003 — when public symbols carry the `Baerly` prefix.
last-reviewed: 2026-06-14
tags: [decision, adr, naming]
related: [README.md, 002-api-surface-lock.md, "../about/thesis.md"]
---

# 003 — `Baerly` prefix naming convention

## Status

Accepted (2026-05-21). Reframed (2026-05-28) — `Baerly` is a
shortening of the package name, not a brand; the decision rules
are unchanged.

## Context

The package is `baerly-storage`. The `Baerly` prefix that appears
on a few public symbols is a shortening of that package name —
used to disambiguate from globals (`Error`) or common user
identifiers (`Client`, `Config`) where a bare symbol would be
unreadable. It is not applied universally; doing so would just
re-state the package name on every export. Most public symbols
already follow a consistent rule; this ADR writes it down so
future additions don't drift.

Audit performed 2026-05-21 found one wart (`Env`, the type a Cloudflare
Worker's `env` is typed against, was being universally re-aliased on
import; renamed to `BaerlyEnv` in the same change). `BaerlyEnv` is
defined in the `@baerly/adapter-cloudflare` package
(`packages/adapter-cloudflare/src/worker.ts`) and reaches users through
the published `@gusto/baerly-storage/cloudflare` subpath. Symbol-by-
symbol, the rest of the surface already followed the rule below,
cross-checked against Prisma, Supabase, Drizzle, Hono, tRPC, Tanstack
Query, Astro, and Next.js conventions.

## Decision

**The `Baerly` prefix carries a symbol when:**

1. The bare name would **collide** with a global (`Error`) or a name
   users routinely declare (`Config`, `Client`, `Env`, `Storage`).
   Prefix to disambiguate — `BaerlyError`, `BaerlyClient`,
   `BaerlyConfig`, `BaerlyAppConfig`. (`BaerlyError` is *caught*; the
   `*Config` types are used as `Db<typeof config>` type args, not
   constructed by name — users call `defineConfig({...})` — so the
   operative test is collision, not "construct or catch".)
2. It is a platform-integration entry function the user puts behind
   `export default` — `baerlyWorker`, `baerlyNode`, `baerlyDev`.
   Generic names (`worker()`, `node()`) would be unreadable at the
   call site.
3. It mirrors a platform-defined type the user would otherwise
   re-alias — `BaerlyEnv` extending Cloudflare's `Env`.

**The `Baerly` prefix is dropped when:**

1. The symbol is generic to the import context — `Db`, `Collection`,
   `Query`, `Storage`, `Writer`. Adding the prefix duplicates
   `baerly-storage` from the import line.
2. The subpath already disambiguates — `/auth/sharedSecret`,
   `/maintenance/compact`, `/observability/withObservability`,
   `/client/react/useQuery`. The path supplies the namespace.
3. The symbol is a strategy or adapter that names its underlying
   technology — `S3HttpStorage`, `r2BindingStorage`, `MemoryStorage`,
   `bearerJwt`, `cloudflareAccess`. The technology name is what
   users look for.

## Counter-pattern

Prefixing every symbol — `BaerlyDb`, `BaerlyCollection`, `BaerlyStorage`
— literally re-states the package name (`baerly-storage` →
`Baerly` + `Storage`) inside its own export. Beyond the
redundancy, it breaks the zero-shot-legibility criterion in
[the product thesis](../about/thesis.md) §"What prototype-tier
storage needs" #4.

## Consequences

- **For contributors adding a public symbol:** apply the rule above
  before adding the export. If the symbol falls cleanly into "drops"
  but the rule feels wrong, that is a signal the boundary is off —
  surface to a maintainer rather than papering with the prefix.
- **For API stability:** [ADR-002](002-api-surface-lock.md) locks
  the public surface additive-only post-launch. `Baerly`-prefix
  changes are pre-launch hygiene; once shipped, a rename is a
  breaking change and held to the ADR-002 bar.
- **For documentation:** `docs/contributing/extending.md`
  cross-links here so contributors adding a new `Db.foo()` /
  `Collection.bar()` method don't have to relitigate the convention.

Future drift checks live in this ADR's "Decision" section, not in a
test — a lint rule for the prefix is over-engineered for a one-page
convention.
