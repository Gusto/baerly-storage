---
title: Workload fit
audience: product
summary: A qualitative shape test for deciding whether an app fits baerly-storage before sizing the workload.
last-reviewed: 2026-08-07
tags: [positioning, product, workload]
related: [thesis.md, cost-model.md, graduation.md]
---

# Workload fit

Before you count rows, price reads, or choose a deployment tier, test the
shape of the product:

> Can the app's most important screen be answered from one collection?

A collection is the row set baerly-storage reads, writes, snapshots, and
handles concurrent writes for as one independent unit.

The collection boundary is the decision point. Inside that boundary,
reads, writes, and snapshots stay in one row set, and concurrent writers
race for that row set's next log slot. Across it, there is no join
engine, no cross-collection query planner, and no cross-collection
atomic commit.

If yes, baerly-storage may fit. If no, baerly-storage should not be the
only query engine for that screen. Reshape the screen around one
collection, make the cross-collection view a rebuildable projection, or
start with a database that owns that boundary.

Each collection has its own ordered log, `current.json`, and snapshot.
Writers for that collection race to create the next `log/<seq>` object;
the one that creates it commits. A read rebuilds that collection by
loading the snapshot and folding the log tail. See the
[thesis](thesis.md#what-this-deliberately-is-not) for the positioning and
the [sync protocol](../spec/sync-protocol.md) for the mechanism.

So the fit test is not "is this app small?" It is "does each important
screen have a natural collection it belongs to?"

## Two axes

| Axis | When to decide it | Question |
| --- | --- | --- |
| Shape fit | While designing the product | Can the workload decompose into independent collections, or is the core screen assembled across many collections, tenants, users, or organizations? |
| Size fit | After the product is working | Did one collection get too hot, did a tenant store too much, or did the cost line cross the published envelope? See [cost-model.md](cost-model.md) and [graduation.md](graduation.md). |

A thriving prototype that outgrows its tier has graduated. A product
whose core screen spans collections, tenants, users, or organizations
did not graduate; it started on the wrong side of the collection
boundary.

## What fits

An app can use many collections. The test applies to the screen or
mutation the user cares about, not to the number of collection names in
the codebase. Within a tenant, a collection can be scoped by product
area, event, board, or channel; the question is whether the important
operation stays inside that chosen row set.

- **Todo list:** the whole app is the `todos` collection. Add, list,
  update, and delete all live inside one row set.
- **Notes with one tag:** the home screen and the scalar tag filter are
  reads from the `notes` collection. A `by_tag` index changes how the
  read is found; it does not change the boundary.
- **RSVP page:** the event page reads the `rsvps` collection filtered by
  `event_id`, then counts that same set. If the product becomes a global
  event dashboard, that is a different shape question.
- **Short links:** redirects read `links` by code. The stats page reads
  `clicks` filtered by `link_id`. Clicks are rows in their own
  collection, not a growing array embedded in the link document.
- **Bookmarks:** the domain filter works because `domain` is a stored
  derived field with an index. The user-facing read still comes from the
  `bookmarks` collection.
- **Single-channel chat:** the channel is the collection. Long-poll
  change reads watch that collection's log.
- **Single-board kanban:** the board is the collection. A card move and
  its conflict handling fit when the move is one card-row update. If a
  move must atomically update multiple cards, columns, or counters, that
  invariant is outside the model.

In each case, the core view maps to one collection.

## The bridge case

Full-text search over a large notes corpus is not the same failure as a
GitHub-style code-hosting app. The notes themselves still fit: each note
belongs to the `notes` collection, and the ordinary note screens can read
that collection directly.

Search is the bridge case where the source-of-truth shape fits, but the
query engine does not. Text search wants tokenization, ranking, cursor
pagination, and an index built for text, not a per-request scan of the
notes collection. Application code can keep baerly-storage as the source
of truth and maintain an external search index incrementally from the
collection's change feed. Do that instead of scanning every note on every
query or using a collection as a search index.

## Where shape breaks

A GitHub-style code hosting app is over the line. A repository's issues
and a pull request's comments may each fit inside one collection, but the
product's most important screens are "my pull requests," "my
notifications," "all code search," "review queue," and "activity across
repositories." Those views span repositories, users, teams, and
organizations. baerly-storage does not provide cross-collection querying
or cross-collection transaction boundaries there, so the shape fails
before size matters.

## The escape hatch

It is fine to copy baerly-storage data into another system for search or
analytics when baerly-storage remains the place you would rebuild from.
baerly-storage can own the leaf records while another system holds a
derived global view: a search index, an analytics projection, or a
rebuildable notification fan-out. This works when the global side is
rebuildable from baerly-storage or owns a separate concern. If both
stores are canonical for the same thing, you now have two databases
holding one product truth, with no shared transaction boundary.

## If shape fits

Once the one-collection test passes, use
[cost-model.md](cost-model.md) for the dollar and operation envelope, and
[graduation.md](graduation.md) for the compute and maintenance envelope.
The system is built around many small collections; fan-out and size
limits are covered in those pages. This page decides whether to start
here; those pages decide when a working app should graduate.

## Scale at a glance

baerly-storage is built for production apps that live within a defined
workload envelope: internal tools, admin panels, dashboards, and
low-to-moderate-traffic line-of-business apps, up to roughly
~30 writes/min/collection, ~10 GB/tenant stored, and ~100
collections/tenant. Crossing one of those lines is a scale event, not a
maturity one; [graduation.md](graduation.md) is what you do about it.

Below are the numbers a builder needs before writing the first line of
code. Shape comes first — if the fit test above failed, no host on this
table fixes it. Only one dimension moves with the host.

| Dimension | Cloudflare free | Cloudflare paid¹ | Serverful Node | Why |
| --- | --- | --- | --- | --- |
| Documents in one collection² | ~100–500 | ~1,600–8,200 | ~6,500–32,800 | A fold rebuilds the whole snapshot in one pass; the ceiling is where that stops fitting the host |
| Writes to one collection³ | ~30/min sustained | Same | Same | Writers race to create the same next log entry; losers retry. Contention, not capacity |
| Collections per tenant⁴ | ~100 (soft) | Same | Same | Nothing enforces a cap; the cost is operator tooling, and that cost is bucket round-trips rather than host CPU |

¹ A paid Worker keeps the **free-tier** budgets until you set
`BAERLY_MAINTENANCE_PROFILE=cf-paid`; billing alone changes nothing. The
Node adapter selects its profile automatically.

² At 1–5 KB per document. Each host caps how large a snapshot one fold
may rebuild — in bytes, and in rows as a backstop for snapshots of many
tiny documents. Bytes bind at documents this size. On Node the cap
scales with available heap, and the column gives the measured floor on a
512 MB container. Per-host caps and their derivation:
[scale-ceilings.md § The auto-maintained snapshot ceiling](../spec/scale-ceilings.md#the-auto-maintained-snapshot-ceiling).

³ Per collection, not account-wide. It is a contention ceiling from the
CAS-livelock regime, hard-coded as
`M_SIZE_WRITES_PER_MIN_PER_COLLECTION = 30` in
`packages/cli/src/admin/usage.ts`, which is what `baerly admin usage`
grades each collection against.

⁴ Derivation:
[scale-ceilings.md § Collection fan-out](../spec/scale-ceilings.md#collection-fan-out).

**Cloudflare free is the floor, and on Workers it is the default whether
or not you are paying.** Every host runs the same protocol; a bigger host
buys a bigger snapshot per fold, nothing else.

Past the ceiling the log stops collapsing into the snapshot: reads keep
working and get slower — erosion, not a cliff.

**Stored bytes are not on this table because they are not a fit limit.**
Nothing in baerly-storage measures or enforces per-tenant storage; a
tenant is only a key prefix. Above ~10 GB/tenant it becomes a cost line —
the R2 free-tier storage boundary, where billing starts — and
[cost-model.md](cost-model.md) owns that figure.

Cost is not a shape question either. For the dollar envelope and the
per-operation crossover against D1, Supabase, Neon, and Firestore, see
[cost-model.md](cost-model.md);
[scale-ceilings.md § Per-tier bounds](../spec/scale-ceilings.md#per-tier-bounds)
owns the per-host derivations.

**How solid these are.** The document ceilings are measured
(`pnpm bench:fold-ceiling`). The ~30 writes/min contention ceiling is
still a model pending real-infra measurement against R2, and ~100
collections is bench-grounded but unenforced. Revisit either if you
observe persistent fold deferrals (`db.compaction.deferred_total`) or
CAS-retry storms.
