---
title: feature/agent-friendliness — stale docs follow-ups
audience: coder
status: open
summary: Backlog of stale docs / drifted agent instructions surfaced while improving zero-shot friendliness.
last-reviewed: 2026-05-13
tags: [followups, agent-friendliness]
related: ["README.md", "../conventions/docs.md"]
---

# feature/agent-friendliness — stale docs follow-up backlog

Seeded by `feature/agent-friendliness` (worked 2026-05-13). That
branch filled concrete onboarding gaps in scaffolded templates,
JSDoc, and CLI ergonomics; the items below are stale-doc /
drifted-instruction findings that were not on its critical path.
Triage in a follow-on branch.

See [`README.md`](README.md) for the entry format and the
status-lifecycle convention.

---

## Pre-seeded entries (from plan-mode exploration, 2026-05-13)

1. **`schema.lock.json` "future feature" wording in `AGENTS.md`** —
   The scaffolded `AGENTS.md` (CF + Node templates) likely contains a
   line near :50 calling collection schemas a "future feature."
   The companion `schema.lock.json` `comment` field already
   describes schemas as live ("Consumed by `Db.create({ schemas })`
   and validated on insert/update/replace via `validateOrThrow`").
   Schema validation is wired at
   `packages/server/src/query.ts:374-379` / `:483-487` / `:545-550`
   and `packages/server/src/schema.ts:78-100`. T01 of the seeding
   branch fixes the AGENTS.md wording on the templates it touches.
   Found in
   `packages/create-baerly/templates/{cloudflare,node}/AGENTS.md`
   during plan-mode exploration. **Suggested cleanup:** grep the
   rest of `docs/` and `packages/create-baerly/` for any remaining
   "reserved for future feature" / "future feature" language about
   collection schemas and align it with the live behaviour.
   **Status:** partially-fixed-by-feature/agent-friendliness-T01

2. **Modifier count discrepancy in upstream brief** — The analyst
   brief that started `feature/agent-friendliness` counted 4
   modifiers on the locked `Table<T>` / `Query<T>` surface. The
   actual count is 5 (`where`, `order`, `limit`, `consistency`,
   `useIndex`). If a similar undercount exists anywhere in `docs/`,
   the scaffolded `README.md`, or a JSDoc summary, it's worth
   fixing. **Suggested cleanup:** grep `docs/` +
   `packages/*/src/**/*.ts` for `"4 modifiers"`, `"three
   modifiers"`, `"the modifiers"` and verify each hit names all 5.
   Found during plan-mode exploration on 2026-05-13. **Status:** open

3. **`RunGcOptions.deleteBeforeSeq` ghost reference** — An external
   brief named `deleteBeforeSeq` as an existing GC tuning knob. It
   does not exist in `packages/server/src/gc.ts:71-111`. Real knobs
   are `graceMillis`, `maxMarksPerRun` (default 200),
   `maxSweepsPerRun` (default 40), `now`, `signal`, `metrics`.
   **Suggested cleanup:** grep `docs/`, `packages/server/`, and
   `docs/adr/` for `deleteBeforeSeq` to confirm no in-repo doc
   claims this knob exists; remove or fix any hit. Found during
   plan-mode exploration on 2026-05-13. **Status:** open

4. **Analyst-brief verification gap** — The analyst brief that
   seeded `feature/agent-friendliness` had three discoverable
   errors (item 2 + 3 above, plus claiming
   `baerly doctor --target=node` lacks a JWKS reachability check
   when it already has one at 3s timeout in
   `packages/cli/src/doctor/node.ts`). The takeaway for future
   inbound briefs: verify each "missing" claim against the current
   tree before treating it as a real gap. **Suggested cleanup:** if
   `docs/conventions/` or the contribution guide doesn't already
   say "validate analyst-style gap reports with grep before scoping
   work," add a one-liner. **Status:** process-note (no fix needed
   unless the cycle repeats)

5. **`docs/conventions/` cross-references after T01** — T01 of the
   seeding branch adds new sections to the scaffolded `AGENTS.md`.
   If any `docs/conventions/*.md` file refers to scaffolded
   `AGENTS.md` by section heading or by line number, those
   references may need to be updated. **Suggested cleanup:** grep
   `docs/conventions/` and `docs/` for `AGENTS.md#` anchor
   references; verify each one still resolves after the T01
   overhaul. Found while drafting the T01 ticket. **Status:** open

---

## Entries appended by ticket execution

<!-- Subagents working tickets T01–T05 append entries below.
     One numbered item per finding. Keep the running counter
     monotonic — peek at the highest number in this file before
     appending and continue from there. -->

6. **`SchemaError` JSDoc in `packages/protocol/src/errors.ts` claims a
   real validator is "future"** — Lines 19–25 of `errors.ts`
   describe `SchemaError` as "emitted by `Db._raw.put` and the
   table-API write verbs when the body isn't valid JSON or contains
   an array where `JSONArrayless` is required. A future change
   wires this to a real validator without changing the wire shape."
   Schema validation IS already wired via
   `packages/server/src/schema.ts:78` (`validateOrThrow`), invoked
   from `packages/server/src/query.ts:375` (insert), `:484` (update),
   `:546` (replace). T03 fixed the parallel claim on
   `Table.insert`'s `@throws` in `db.ts:51`; the matching update on
   `errors.ts:19-25` is out of T03's scope (modify-`errors.ts`-not-
   `db.ts`) but should land in the same follow-up sweep.
   **Suggested cleanup:** rewrite the second sentence of the
   `SchemaError` JSDoc to describe the live behaviour ("emitted by
   `Db._raw.put` on malformed JSON / array-in-`JSONArrayless`-slot,
   and by the table-API write verbs when the bound schema rejects
   the doc"). Found while executing T03 on 2026-05-13.
   **Status:** open

7. **AGENTS.md operator-visibility section should name the
   maintenance canonical-line fields** — T04 (this branch) added
   explicit operator-facing fields to the
   `runScheduledMaintenance` canonical line:
   `compact_written` (count of log entries folded into the new
   snapshot — `0` when compact was skipped or below
   `minEntriesToCompact`), `gc_swept` (count of keys deleted —
   `0` when GC was skipped or no candidates aged out),
   `compact_skipped` / `gc_skipped` (`true` when the caller
   alternated this phase away; CF free-tier even/odd cron pattern).
   The kernel still emits the recorder-bag fields alongside
   (`db.compact.entries_folded_p50` / `_count` / `_sum`,
   `db.manifest.lag_window_depth`, `db.orphan.candidate_count`,
   `db.gc.entries_swept_per_second`, `db.gc.swept_total_total`) —
   useful for dashboards, but the four explicit fields are the
   at-a-glance summary. If T01's "Operator visibility" /
   "Maintenance loop" section in the scaffolded `AGENTS.md` has
   already landed without referencing these four fields by name,
   edit the template to add them (CF + Node templates both, since
   they ship a byte-identical `AGENTS.md` + `CLAUDE.md`).
   `docs/observability.md` should likely pick this up too — add it
   to the same follow-on sweep. Found while executing T04 on
   2026-05-13. **Status:** open (T01 coordination)

8. **Scaffolded `worker.ts` / `server.ts` reference monorepo-only
   `docs/observability.md`** — both template entry points contain
   inline comments pointing at `docs/observability.md` for sink
   wiring guidance (`packages/create-baerly/templates/cloudflare/
   apps/server/src/worker.ts:71` and `.../node/apps/server/src/
   server.ts:61`). The `docs/` directory does not exist inside the
   scaffolded app, so the link is dead from the user's perspective.
   Found while executing T01 (no fix landed — T01 only edits the
   scaffolded `AGENTS.md`). **Suggested cleanup:** either inline a
   one-paragraph summary, point at the published doc URL, or move
   the observability sink-wiring recipe into the scaffolded
   `AGENTS.md` / `README.md`. **Status:** open

9. **Stale `tini + tsx` Dockerfile comment in Node scaffolded README
   (fixed in T02)** — The Node scaffolded README's `What you got`
   tree captioned `apps/server/Dockerfile` as "multi-stage; tini +
   tsx entrypoint". The actual
   `packages/create-baerly/templates/node/apps/server/Dockerfile`
   uses the distroless `nodejs24-debian12` base, runs as the
   `nonroot` user (UID 65532), and invokes `node
   apps/server/dist/server.js` directly — no `tini`, no `tsx`.
   T02 replaced the comment with "multi-stage; distroless runtime"
   while overhauling the README. **Suggested cleanup:** grep
   `docs/` and `packages/` for any remaining `tini`/`tsx`
   references that still imply the old container layout; align or
   remove. Found during T02 execution on 2026-05-13.
   **Status:** fixed-by-feature/agent-friendliness-T02

10. **`baerly doctor --usage` not yet wired for the Cloudflare
    target** — T05 (this branch) shipped the Node-target writes/min
    estimator. The Cloudflare backend currently emits a single
    info-severity finding (`usage-cf-unimplemented`) pointing
    operators at `baerly inspect` because the CLI runs in Node and
    can't reach a Workerd-side `R2BindingStorage`. The pure-storage
    estimator in `packages/cli/src/doctor/usage.ts` is backend-
    agnostic — it only needs a `Storage` handle; the gap is
    construction. Three implementation paths to evaluate in the
    follow-up:
    1. **R2 over S3-compat HTTP from the CLI** (simplest) — wire
       `S3HttpStorage` against the bucket's R2 S3 endpoint
       (`https://<accountId>.r2.cloudflarestorage.com`) using an
       account-scoped R2 API token. Requires the operator to mint
       and provide `CF_ACCOUNT_ID` + `R2_ACCESS_KEY_ID` +
       `R2_SECRET_ACCESS_KEY`; no different in shape from the Node
       target's `AWS_*` env vars. Smallest code delta.
    2. **`wrangler r2 object list/get` shell-out** — drive
       `wrangler` via the `ProcessRunner` seam already used in
       `doctor/cloudflare.ts`. Reuses operator's `wrangler login`
       creds; no new env vars needed. Slow (one process per object)
       and limited by `wrangler`'s output formats; useful as a
       fallback when path 1 isn't acceptable.
    3. **CF API token + workers-script remote eval** — invoke a
       short-lived ephemeral Worker via the CF API that returns
       per-collection sample stats. Most complex; deferred.
    The estimator itself is unchanged regardless of construction
    path; only the `Storage` factory changes. Found during T05
    execution on 2026-05-13. **Status:** open
