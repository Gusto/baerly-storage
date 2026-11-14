---
title: Conventions for request counts
audience: coder
summary: The exact per-route storage-call snapshot, what its grid covers, and what to do when the gate goes red.
last-reviewed: 2026-11-13
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
declared single-field indexes (always 0 in the route grid), and the number
of documents folded into the snapshot (0 / 100). A declared index changes
no storage call: `tests/unit/declared-indexes-inert.test.ts` asserts that a
collection declaring 3 indexes issues exactly an undeclared one's calls for
every write verb, the write tick and every read, so the grid measures the
undeclared collection only. The value counts calls by
kind: `get`, `put`, `delete`, and `listPage`. `listPage` counts one LIST
request per 1,000 keys pulled, the page size S3 and R2 use. The `Storage`
interface has no HEAD.

| op | what runs |
| --- | --- |
| `insert`, `insert-with-id` | `insert`, with an SDK-minted or a caller `_id` |
| `update`, `delete` | by id on a snapshot doc, else the oldest tail doc, else a missing id |
| `update-latest`, `delete-latest` | by id on the newest tail doc |
| `get` | `get(id)` |
| `indexed-query`, `indexed-miss`, `scan` | `where` equality matching 1 in 10 docs, matching none, and on a unique field |
| `in-query[k]` | `where(q => q.in(field, k values))` |
| `tick:fold` | the forced write-tick fold (one pass of at most `WRITE_TICK_FOLD_ENTRIES_PER_PASS`) |
| `tick:gc`, `tick:gc-mark`, `tick:gc-sweep` | the hard-GC write tick (GC slice plus log retirement) on the seeded state, after a fold, and after a fold with the grace period elapsed |

Routes run with the write tick dropped, so a route cell is the route alone.
On a host where the tick shares the request's budget (a Workers
`ctx.waitUntil` tick does), a write costs its route cell plus whichever tick
it dispatches.

The `free-fetch:*` cells are whole requests on Workers Free with storage
reached through `fetch`, where every call is one of the 50 external
subrequests. Each runs one write kind (`insert`, cold `update`s, a `mixed`
rotation) from a 100-doc snapshot, on a collection declaring 3 indexes,
through a full cycle of fold and GC phases, with the tick options the
Cloudflare adapter builds for that host. GC runs with the production grace
period over a seeded backlog of due snapshots, so every GC slice deletes its
full sweep cap, and log retirement is live. A `<kind>+tick` cell is the
most expensive write, route plus tick; a read cell is the most expensive
read at any state a `mixed` write left, before its tick ran. `tests/unit/request-counts.test.ts` also asserts that
every such cell, plus the Worker's Cache API calls, stays within 45 calls,
the budget `CF_FREE_FETCH_FOLD_AT_TAIL_ENTRIES` and
`CF_FREE_FETCH_GC_MAX_SWEEPS` are derived from. The Cache API counts are
measured under workerd by
`packages/adapter-cloudflare/src/worker-maintenance.test.ts`. The fixture is
`tests/fixtures/request-count-free-fetch.ts`.

The `free-fetch:since-*` and `free-r2:since-*` cells are `GET /v1/since`
long-polls under the ledger's Free limits, `external` (45) over `fetch` and
`internal` (900) on the R2 binding. `since-idle-no-timeout` is a poll that
finds nothing, run with no effective deadline and a zero poll interval, so
the ledger ends it: the most an idle poll can spend on that host, not its
cost at the route defaults. At the defaults (25 s at 1 s) an idle poll costs
44 calls over `fetch`, where the ledger still ends it, and 52 on the R2
binding, where the timeout does; `packages/server/src/http/since.test.ts`
pins both under fake timers. `since-busy` is the first request over a
200-entry unfolded tail. `tests/unit/request-counts.test.ts` asserts that
each stays within its host's limit. The fixture is
`tests/fixtures/request-count-since.ts`.

Every state publishes `tail_hint` at the true tail, so a read replays exactly
`tail` entries and pays no forward probe over a stale hint.

The counts are happy-path: `MemoryStorage` never fails, so each call is one
attempt. Retries (up to `STORAGE_RETRY_MAX_ATTEMPTS` per call) and fault paths
are covered by the adapters' request-accounting tests, not here.

The grid lives in `tests/fixtures/request-count-grid.ts`. Calls are counted
by the request ledger, the per-invocation budget the adapters enforce:
`chargedStorage` in `tests/fixtures/ledgered-storage.ts` routes every call,
and every LIST page, through `retryStorageCall` as an adapter does, so each
one is charged to the ledger before it is issued. It also tallies what
reaches `MemoryStorage` by kind and fails the cell unless the ledger's
charge equals that tally, so the gate proves the ledger charges exactly
what is issued. The `free-fetch:*` cells charge the `external` pool, the
one Workers Free caps at `CF_FREE_EXTERNAL_REQUEST_LIMIT`.

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
cleared the same way, with `--write`. The test takes about 3 s alone, most of it
the free-fetch runs, which must cover a whole fold/GC phase cycle to reach
the worst request; it carries a 30 s timeout so a loaded machine does not
flake it. Keep additions from growing either part.
