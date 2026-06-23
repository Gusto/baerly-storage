---
title: Workload fit
audience: product
summary: A qualitative shape test for deciding whether an app fits baerly-storage before sizing the workload.
last-reviewed: 2026-06-23
tags: [positioning, product, workload]
related: [thesis.md, cost-model.md, graduation.md]
---

# Workload fit

Before you count rows, price reads, or choose a deployment tier, ask one
question:

> Can the app's most important screen be answered from one collection?

Here, a collection means the row set baerly-storage reads, writes,
snapshots, and conflicts over as one independent unit.

If yes, baerly-storage may fit. If no, baerly-storage should not be the
only query engine for that screen. Reshape the screen around one
collection, make the cross-collection view a rebuildable projection, or
start with a database that owns that boundary.

More precisely, a collection is the independence boundary. Each
collection has its own ordered log, its own `current.json`, its own
snapshot, and its own commit race. A write commits when one writer
creates the next `log/<seq>` object for that collection; a read rebuilds
that collection by loading the snapshot and folding the log tail. There
is no join engine on the other side of that boundary, no cross-collection
query planner, and no cross-collection atomic commit. See the
[thesis](thesis.md#what-this-deliberately-is-not) for the positioning
and the [sync protocol](../spec/sync-protocol.md) for the mechanism.

So the fit test is not "is this app small?" It is "does each important
screen have a natural collection it belongs to?"

## Two different axes

Keep shape fit and size fit separate.

**Shape fit** is qualitative. You decide it while designing the product.
Can the workload decompose into independent collections, or is the
product itself a global view, meaning a screen assembled across many
collections, tenants, users, or organizations?

**Size fit** is quantitative. You hit it after the product is working:
one collection gets too hot, a tenant stores too much, or the cost line
crosses the published envelope. That is the success path covered by
[cost-model.md](cost-model.md) and
[graduation.md](graduation.md).

A thriving prototype that outgrows its tier has graduated. A product
whose core screen is cross-partition did not graduate; it started on the
wrong side of the collection boundary.

## What fits

You can use more than one collection in an app. The test applies to the
screen or mutation the user cares about, not to the number of collection
names in the codebase. Within a tenant, a collection can be scoped by
product area, event, board, or channel; the question is whether the
important operation stays inside that chosen row set.

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

The first warning sign is a screen whose natural answer is "look across
all of them."

A GitHub-style code hosting app is over the line. A repository's issues
and a pull request's comments may each fit inside one collection. But the
product's most important screens are "my pull requests," "my
notifications," "all code search," "review queue," and "activity across
repositories." Those are views across repositories, users, teams, and
organizations. baerly-storage does not provide cross-collection querying
or transaction boundaries there, so the shape fails before size matters.

## The escape hatch

It is fine to copy baerly-storage data into another system for search or
analytics when baerly-storage remains the place you would rebuild from.
The polyglot split is real, but the ownership boundary has to be
explicit. baerly-storage can be the source of truth for the leaf records
while another system holds a derived global view: a search index, an
analytics projection, or a rebuildable notification fan-out. This works
when the global side is rebuildable from baerly-storage or owns a
separate concern. If both stores are canonical for the same thing, you
now have two databases holding one product truth, with no shared
transaction boundary.

## If shape fits

Once the one-collection test passes, use
[cost-model.md](cost-model.md) for the dollar and operation envelope, and
[graduation.md](graduation.md) for the compute and maintenance envelope.
The system is built around many small collections; fan-out and size
limits are covered in those pages. This page decides whether to start
here; those pages decide when a working app should graduate.
