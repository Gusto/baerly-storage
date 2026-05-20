# Followups: CLI cleanup

**Source: 2026-05-19 analyst triage (G-series).**

**Status (2026-05-20):** 16 of 17 items shipped on
`worktree-cli-cleanup`. One item deferred — see "Deferred" below.

The CLI is the first thing a user types after `npm install`.
DX is the top priority for this surface — per the pre-launch
brief, "an obvious API that's adequate beats a clever API
that's fast." Same applies to subcommand shape.

---

## Deferred

### G11. Wizard never shows the `helpdesk` template

**Severity: MEDIUM. Hidden feature.**

The wizard at `packages/create-baerly/src/prompts.ts:runWizard`
returns `{ projectName, target, withAddons, install }` only.
The `helpdesk-cloudflare` template is reachable only via
`--starter=helpdesk` on the flag-driven path. A wizard user
has no way to discover it.

**Why deferred:** coupled to a separate followup
(`examples-helpdesk-dedup.md`). If the helpdesk example
collapses into a ~60-line getting-started snippet, the wizard's
"starter" prompt may not be needed at all. Hold this until
that decision resolves.

---

## Shipped (this branch)

All 16 commits in the `worktree-cli-cleanup` branch (ff-merge
into local main):

| Item | Commit | Summary |
|---|---|---|
| G14 | `refactor(cli): hoist defaultRunner to runner.ts` | Single `ProcessRunner` factory with optional `{ tee }`. Drops dup between `doctor.ts` and `deploy/cloudflare.ts`. |
| G18 | `refactor(cli): hoist loadCollectionIndexes to config.ts` | Shared `loadCollectionIndexes(configPath, table, cmd)`. Drops the 30-line `.js/.mjs/.json` loader from `inspect` + `admin/rebuild-index`. |
| G17 | `refactor(cli): replace BAERLY_REBUILD_INDEX_VERBOSE env-var with --verbose flag` | Standard flag; matches the rest of the admin surface. |
| G19 | `refactor(cli): extract parseBucketUri + parseCursor to bucket-uri.ts` | 9 importers re-pointed; copy.ts loses module-name coupling. |
| G20 | `refactor(cli): standardize on BAERLY_S3_ENDPOINT (drop bare S3_ENDPOINT + R2_ENDPOINT)` | One env-var name across CLI. No collisions with system tooling. |
| G1 | `refactor!: delete dead @baerly/cli library exports` | Pure dead code. Bin is the only public artifact. |
| G21 | `refactor(create-baerly): move scaffold ignores to per-example manifests` | New manifest fields: `excludeNames`. Code-vs-config split dies. |
| G22 | `refactor(create-baerly): manifest-driven AGENTS.md → CLAUDE.md copies` | New manifest field: `copies: [{ from, to }]`. Adding a third coding-tool variant is a manifest edit. |
| G6 | `feat(cli): add defineBaerlySubcommand helper` + `refactor(cli): migrate inspect + export onto defineBaerlySubcommand` + `refactor(cli): migrate admin/* onto defineBaerlySubcommand` + `refactor(cli): migrate doctor onto defineBaerlySubcommand` | New helper centralizes `KNOWN_KEYS`, `errorToExitCode`, `resolveAppTenant`. 14 `errorToExitCode` impls + 14 `KNOWN_KEYS` declarations + 8 `resolveAppTenant` impls → one shared helper. -324 LoC across 10 migrated commands. |
| G8 | (in the migration commits) | `resolveAppTenant` throws `InvalidConfig` instead of falling back silently to `app=app, tenant=tenant`. The hint points at `--app` / `--tenant`. |
| G9 | (in the admin/* migration commit) | `admin rebuild-index` drops citty `default: "app"` / `default: "tenant"`; uses the shared resolver. |
| G16 | `refactor(cli)!: replace BAERLY_DUMP/RESTORE env-var test hooks with streams parameter` | `runDump` / `runRestore` accept `{ streams?: { stdin?, stdout? } }`. Tests pass file handles directly. |
| G3 | `feat(cli): add baerly cost verb for trajectory projection` + `refactor(cli)!: remove cost-trajectory footer from inspect (moved to baerly cost)` + `docs(cli): point cost-projection references at baerly cost` | Cost projection lives behind its own opt-in verb. `inspect` is glance-only (no GET-storm). |
| G4 | `refactor(cli)!: move copy verb under baerly admin` | `baerly copy` → `baerly admin copy`. Top-level surface is day-1 verbs only. |
| G2 | `refactor(cli)!: split baerly doctor --usage / --check / --rebuild-drift into admin verbs` | `baerly doctor` is now read-only target invariants. `--usage` → `baerly admin usage`. `--check=index-filter-drift` + `--rebuild-drift` → `baerly admin fsck --indexes [--fix]`. |
| G5 | `refactor(cli): re-order top-level help; trim baerly description` | Order: `dev, init, deploy, doctor, inspect, export, cost, admin`. Top-level description trimmed to one line. |
| (stage-2) | `docs(cli): update stale "baerly copy" references after admin move` | Cosmetic JSDoc + describe-label cleanups missed by the G4 commit. |

**Top-level help today:** `baerly --help` shows the 8 day-1
verbs in the order above. **Admin help today:** `baerly admin
--help` shows `rebuild-index, dump, restore, compact, gc, fsck,
migrate, copy, usage` (alphabetical inside `admin`).

---

## Dropped (already shipped, invalid, or pre-empted)

- **G12** — already shipped: `defineConfig` moved to
  `baerly-storage/config` (commit `0003740`).
- **G13** — already shipped: `admin compact` + `admin gc`
  split landed at commit `cb03690`.
- **G15** — already shipped: `freeTierBudgetHint` removed at
  commit `8758f95`.
- **G10** — invalid: wizard's `install` value IS threaded through
  (`prompts.ts:118-120` → `WizardOutput` → scaffold).
