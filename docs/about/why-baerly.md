---
title: Why baerly-storage
audience: product
summary: >
  The six things baerly-storage is built to be — LLM-legible, no-ceremony,
  safe to hand off, data in your bucket, no new vendor, no resident service,
  idle-to-zero cost, and a mechanical exit.
last-reviewed: 2026-07-01
tags: [positioning, product]
related: [thesis.md, alternatives.md, workload-fit.md, cost-model.md]
---

# Why baerly-storage

baerly-storage is the database built for the software LLMs write — and the
builders they hand it to. These are the six things it is built to be.

## Built for the software LLMs write — and the people they hand it to

The whole public surface is a small, typed, closed-vocabulary document API:
eight verbs, a handful of modifiers, one error type discriminated by
`.code`. An agent can reach the correct call zero-shot from the `.d.ts`
files and `dist/API.md` without inventing ceremony. A human can hold it all
in working context at the same time.

There are no DDL migrations to author. Schema shape changes are TypeScript or
config edits — no `CREATE TABLE`, no `ALTER TABLE`, no generated migration
ceremony. A naming change four turns into a conversation does not cascade
into a migration conflict.

Tenant isolation is prefix-scoped at the `Db` layer in application code —
not delegated to a row-level-security policy DSL. That matters because a
wrong RLS policy returns empty arrays that look like "no data," not "broken
authorization." baerly-storage removes that class of silent failure by
keeping security-sensitive decisions where the LLM and the human can both
read them.

The result is a surface small and safe enough to hand to a non-engineer
building an internal tool and let them go.

## Your data, in a bucket you already own

baerly-storage stores its durable state in an S3-compatible bucket — your
AWS S3, your Cloudflare R2, your bucket. The bytes are not rented from a
third party; they live where you already put your exports, backups, and
documents. If the library stopped being maintained today, your data is in
standard object storage. Nothing is held hostage.

## No new vendor to clear

Almost every team already has a bucket approved by IT. The security review
for "give me an S3 bucket" happened years ago. Adding a managed database
service triggers a fresh vendor procurement review, a secrets-manager
integration, and an IT ticket to add a new managed-DB SKU to the catalog —
and that barrier only grows past roughly 100 people, where the approval
chain lengthens. The bucket is already cleared; baerly-storage plugs into
what your security review closed years ago. See
[thesis.md](thesis.md#no-new-vendor) for the full argument.

## Servers that don't exist can't go down

There is no resident database service in your critical path — no daemon to
page about, no connection pool to exhaust, no additional uptime SLA to
monitor. Your bucket and your handler's host keep their own SLAs.
baerly-storage just does not add a third service to depend on, page on,
or include in your supply chain.

One fewer failure domain. One fewer entry in your dependency tree.

Honest hedge: your bucket and handler still have their own failure modes;
baerly-storage removes the database service failure mode, not all failure
modes.

## Idle rounds to zero

A managed database floor multiplied across a fleet of mostly-idle internal
tools accumulates fast. baerly-storage charges no floor of its own: at
idle, storage-op cost is effectively zero (`< 1 Class A op / writer / hour`,
CI-gated). On Cloudflare Workers, one $5/mo Workers Paid platform floor
covers the entire fleet — amortized across all apps, not multiplied by N.
On self-hosted Node, the idle cost is $0. See the N=30 portfolio comparison
in
[cost-model.md](cost-model.md#at-the-audience-operating-point-idle--n-portfolio).

## The exit is mechanical

`baerly export --target=postgres` produces a per-collection SQL snapshot.
Crossing the workload envelope is the graduation signal — graduation is the
success path, not a failure mode. The log shape is designed so that future
incremental CDC exit stays straightforward rather than aspirational.

When an app grows into Cloudflare D1 or Postgres, that is a
baerly-storage win. The data exit requires no cooperation from a vendor.

---

Where this is the wrong tool →
[workload-fit.md](workload-fit.md) (shape) and
[graduation.md](graduation.md) (scale).
