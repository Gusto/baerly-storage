# 0006 — Server component (`@baerly/server`)

## Status

Accepted. Supersedes an earlier client-only architecture (since
removed from the ADR set; the only artifact is this ADR).

## Context

The project originally committed to a client-only architecture:
clients connect directly to S3-compatible storage and the manifest
log is the protocol. No server. That constraint has become
load-bearing in ways the original framing didn't anticipate:

- An MCP server (so Claude can pair-program against the database)
  requires server code by definition.
- Mechanical export to Postgres/SQLite — the graduation story —
  requires a non-browser runtime to walk the log and emit DDL +
  DML.
- Auth defaults that don't require every user to roll their own JWT
  validation require a Worker (or equivalent) — there is no client-
  only answer that's safe for non-engineers.
- The `current.json` CAS pattern works in the browser but cohabits
  more cleanly with trusted multi-Worker isolates: the protocol's
  property test was always written against multi-writer scenarios,
  and that's a better fit for stateless server runtimes than for
  long-lived browser tabs.

The protocol kernel — descending base32-time keys, RFC 7386 merge
patch, fence tokens, randomized causal-consistency property test —
survives unchanged. Only the runtime above it shifts.

## Decision

The project ships a server component, `@baerly/server`, runnable as
a Cloudflare Worker, on Node, or on any fetch-capable runtime. The
browser becomes a typed HTTP client over `@baerly/client`. Browser-
direct multi-writer is dropped; trusted multi-Worker is the new
design center.

## Consequences

- The "vendorless" claim splits cleanly: **vendorless data** (your
  bucket, mechanical export) is unchanged; **vendorless runtime** is
  weaker — the day-1 path is Cloudflare Worker + R2, with Node + S3
  documented as a fallback.
- Auth, MCP, and export all become tractable. Each gets its own ADR
  when it lands.
- The browser side becomes simpler: a typed RPC client over fetch,
  no offline queue, no IndexedDB. Realtime change notifications
  are a future opt-in `NotificationBus`.
- The protocol kernel's location moves from `src/` to
  `packages/protocol/`. Already partially complete (commit
  `8efbe96`); the remaining moves land with the carve.
- The randomized causal-consistency property tests originally
  designed for peer-browser writers still run, just against the
  multi-Worker runtime.
