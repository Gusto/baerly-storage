---
title: Workload fit
audience: product
summary: A qualitative shape test for deciding whether an app fits baerly-storage before sizing the workload.
last-reviewed: 2026-06-26
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

The numbers a builder needs before writing the first line of code. For
derivations, see [cost-model.md](cost-model.md) and
[graduation.md](graduation.md).

| Dimension | Number | Notes |
| --- | --- | --- |
| Shape | 1 important screen = 1 collection | The fit test above; fails before size matters |
| Throughput | ~30 writes/min/collection sustained | M-size operating point — model/estimate, pending real-infra measurement on Cloudflare R2 |
| Per-collection size | ~100–500 docs (~512 KB snapshot) before compaction defers on CF free | A fold fits the free-tier CPU budget at ~512 KB; erosion, not a cliff — model/estimate, pending real CF-isolate measurement |
| Fan-out | ~100 collections/tenant (soft guideline) | Bench-grounded linear cost (`pnpm bench:collection-fanout`); nothing in the protocol enforces a cap — cost grows linearly with N |
| Storage | >10 GB/tenant stored = R2 free-tier boundary | A cost line, not a protocol ceiling; billing begins above 10 GB-mo on R2 |
| Cost | ~$18/mo all-in on R2 (~$13 object-storage ops + $5 Workers Paid floor), ~$26/mo on S3 at M-size | At ~30 writes/min account-wide aggregate; `baerly cost` projects the object-storage-ops portion only (no platform floor); see [cost-model.md](cost-model.md) for the curve |

**CPU and throughput walls are surfaced above as model/estimate** — the
~11 ms/MB fold-cost model (used to derive the ~512 KB CF-free ceiling)
and the ~30 writes/min contention ceiling both need validation against a
real CF isolate and real R2. Real-infra measurement is the known
follow-up. The numbers are the best current estimates; use them to
decide whether to start here, and revisit if you observe persistent fold
deferrals (`db.compaction.deferred_total`) or CAS-retry storms.
