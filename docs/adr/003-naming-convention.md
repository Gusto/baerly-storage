---
title: Brand-prefix naming convention
audience: adr
summary: ADR 003 — when public symbols carry the `Baerly` brand prefix.
last-reviewed: 2026-05-21
tags: [decision, adr, naming]
related: [README.md, 002-api-surface-lock.md, "../about/thesis.md"]
---

# 003 — Brand-prefix naming convention

## Status

Accepted (2026-05-21).

## Context

The brand is "Baerly" (`docs/about/thesis.md`). The published npm
package is `baerly-storage` — a description ("storage by Baerly"),
not a shortening. The API surface uses the **brand**, not the
package name. Most public symbols already follow a consistent rule;
this ADR writes it down so future additions don't drift.

Audit performed 2026-05-21 found one wart (`Env` exported from
`baerly-storage/cloudflare` was being universally re-aliased on
import; renamed to `BaerlyEnv` in the same change). Symbol-by-symbol,
the rest of the surface already followed the rule below, cross-checked
against Prisma, Supabase, Drizzle, Hono, tRPC, Tanstack Query, Astro,
and Next.js conventions.

## Decision

**The `Baerly` brand prefix carries a symbol when:**

1. It is a boundary type the user constructs or catches —
   `BaerlyError`, `BaerlyClient`, `BaerlyConfig`, `BaerlyAppConfig`.
   The prefix disambiguates from globals (`Error`) or common user
   identifiers (`Client`, `Config`).
2. It is a platform-integration entry function the user puts behind
   `export default` — `baerlyWorker`, `baerlyNode`, `baerlyDev`.
   Generic names (`worker()`, `node()`) would be unreadable at the
   call site.
3. It mirrors a platform-defined type the user would otherwise
   re-alias — `BaerlyEnv` extending Cloudflare's `Env`.

**The `Baerly` brand prefix is dropped when:**

1. The symbol is generic to the import context — `Db`, `Table`,
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

Prefixing every symbol — `BaerlyDb`, `BaerlyTable`, `BaerlyStorage`
— would collide with the package name itself and break the
zero-shot-legibility criterion in
[the product thesis](../about/thesis.md) §"What prototype-tier
storage needs" #4.

## Consequences

- **For contributors adding a public symbol:** apply the rule above
  before adding the export. If the symbol falls cleanly into "drops"
  but the rule feels wrong, that is a signal the boundary is off —
  surface to a maintainer rather than papering with a brand prefix.
- **For API stability:** [ADR-002](002-api-surface-lock.md) locks
  the public surface additive-only post-launch. Brand-prefix changes
  are pre-launch hygiene; once shipped, a rename is a breaking
  change and held to the ADR-002 bar.
- **For documentation:** `docs/contributing/extending.md`
  cross-links here so contributors adding a new `Db.foo()` /
  `Table.bar()` method don't have to relitigate the convention.

Future drift checks live in this ADR's "Decision" section, not in a
test — a lint rule for branding is over-engineered for a one-page
convention.
