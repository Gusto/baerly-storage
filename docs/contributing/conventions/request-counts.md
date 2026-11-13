---
title: Conventions for request counts
audience: coder
summary: The exact per-route storage-call snapshot, what its grid covers, and what to do when the gate goes red.
last-reviewed: 2026-11-12
tags: [conventions, request-counts, performance]
related: [bundle-budgets.md, tests.md]
---

# Request-count conventions

`request-counts.json` records the exact number of storage calls each route
and maintenance tick issues on a fixed grid of collection states.
`tests/unit/request-counts.test.ts` re-measures the grid in `pnpm test` and
fails on any difference. `pnpm request-counts` runs the same comparison on
its own.

Hosts cap storage calls per request (Workers Free allows 50 external
subrequests), so a route that quietly gains a call can shrink what fits
under a host's budget. This gate makes every such change visible in review.

## What is measured

Each cell is `<op> tail=<n> idx=<n> snap=<n>`: the operation, the number of
unfolded log entries past the snapshot (0 / 50 / 200), the number of
declared single-field indexes the write touches (0 / 1 / 3), and the number
of documents folded into the snapshot (0 / 100). The value counts calls by
kind: `get`, `put`, `delete`, and `listPage`. `listPage` counts one LIST
request per 1,000 keys pulled, the page size S3 and R2 use. The `Storage`
interface has no HEAD.

| op | what runs |
| --- | --- |
| `insert`, `insert-with-id` | `insert`, with an SDK-minted or a caller `_id` |
| `update`, `delete` | by id on a snapshot doc, else the oldest tail doc, else a missing id; the pre-image is outside the post-commit walk, so no stale marker is deleted |
| `update-latest`, `delete-latest` | by id on the newest tail doc; the stale index markers are DELETEd |
| `get` | `get(id)` |
| `indexed-query`, `scan` | `where` on an indexed field, and on an unindexed one |
| `in-query[k]` | `where(q => q.in(field, k values))` on an indexed field |
| `tick:fold` | the forced write-tick fold (one pass of at most `WRITE_TICK_FOLD_ENTRIES_PER_PASS`) |
| `tick:gc`, `tick:gc-mark`, `tick:gc-sweep` | the hard-GC write tick (GC slice plus log retirement) on the seeded state, after a fold, and after a fold with the grace period elapsed |

Routes run with the write tick dropped, so a route cell is the route alone.
On a host where the tick shares the request's budget (a Workers
`ctx.waitUntil` tick does), a write costs its route cell plus whichever tick
it dispatches.

Every state publishes `tail_hint` at the true tail, so a read replays exactly
`tail` entries and pays no forward probe over a stale hint.

The counts are happy-path: `MemoryStorage` never fails, so each call is one
attempt. Retries (up to `STORAGE_RETRY_MAX_ATTEMPTS` per call) and fault paths
are covered by the adapters' request-accounting tests, not here.

The grid lives in `tests/fixtures/request-count-grid.ts`. Calls are counted
through `requestCountingStorage` in `tests/fixtures/request-counting-storage.ts`,
which reports each call to a one-method `RequestCounter`. A request ledger's
charge counter can stand in for that counter without changing the grid.

## The gate

Exact equality. The grid is deterministic, so any change, fewer calls as
well as more, means a route's behavior changed. There is no tolerance band to
tune.

## When the gate goes red

The failure lists each changed cell with the kinds that moved:

    CHANGED get tail=50 idx=0 snap=0: get 52 -> 53 (+1), total 52 -> 53 (+1)

Ask whether the change is intended. If it is:

    pnpm request-counts --write

and say why in the commit message. Do not add a changelog entry to any file.
If the change is not intended, you have found a regression: the cell names
the route and the state that exposes it.

`pnpm request-counts --report` prints every cell as a grep-friendly
`REQUEST_COUNT <cell> <counts>` line without comparing.

## Changing the grid

Adding, renaming or removing a cell shows up as `ADDED` / `REMOVED` and is
cleared the same way, with `--write`. Keep the grid small enough that the test
stays well under a second.
