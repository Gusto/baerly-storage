# Followups: CLI cleanup

**Source: 2026-05-19 analyst triage (G-series).** Verified
against current state. Items already shipped (G12, G13, G15)
are dropped. G6, G10, G11 are rescoped to match what's
actually there.

The CLI is the first thing a user types after `npm install`.
DX is the top priority for this surface — per the pre-launch
brief, "an obvious API that's adequate beats a clever API
that's fast." Same applies to subcommand shape.

---

## Strategic — needs a call

### G3. `cost/` subtree — scope creep vs. investment?

**Severity: needs decision. Conflicts with active development.**

The brief calls `packages/cli/src/cost/` "scope creep" (466 LOC,
hard-coded price tables, requires "writes/min GET-storm" on
every `inspect`) and recommends deletion.

But the git log shows 9+ commits to `cost/` between
`360d8d0` (cost-projection module) and `268ea57` (polish: tests
+ drop unused exports) — active investment in cost projection
as a feature.

**The brief's tradeoff is real:**
- `inspect` is supposed to be a glance command.
- Cost footer requires a `writes/min` estimator that issues
  extra storage ops (GETs + LISTs).
- Price tables drift when Cloudflare changes rate sheets.

**Three viable paths:**
1. **Keep + isolate.** Move cost projection behind `baerly cost`
   as its own verb. `inspect` becomes glance-only. Solves both
   the GET-storm concern AND keeps the investment.
2. **Keep as-is.** Cost-trajectory footer on `inspect` was
   shipped deliberately. Reject the deletion recommendation;
   delete this followup.
3. **Delete.** Per the brief. Move pricing-log surfacing to
   `doctor --usage` only.

Recommendation: option (1). Discuss before action — this is
the only item in the cluster that conflicts with shipped work.

---

## Top-level shape

### G2. `baerly doctor` is a four-headed beast

**Severity: HIGH. Verb hiding in flag namespace.**

`packages/cli/src/doctor.ts:37–68` defines flags including
`--usage` (writes/min estimator), `--check=index-filter-drift`
(read-only invariant check), and `--rebuild-drift` (a write
operation hiding inside a "doctor" promised read-only).

Three of these are independent verbs masquerading as flags.

**Fix:**
- `baerly doctor` reduces to read-only invariant checks (target
  + fix-known-issues only).
- `--usage` → `baerly admin usage` (or fold into the
  `baerly cost` verb proposed in G3).
- `--check=index-filter-drift` → `baerly admin fsck --indexes`
  (or fold into a single `admin fsck`).
- `--rebuild-drift` → `baerly admin rebuild-index --all` (or
  `admin fsck --fix`).

### G4. `baerly copy` is kernel-class operator infra at top level

**Severity: HIGH. Bad first-impression of the CLI surface.**

`packages/cli/src/copy.ts` is 499 LOC of bucket-to-bucket
replicator (cursor grammar, endpoint-pattern dispatch, snapshot
encoding, write-path bypass). Wired at top level in
`packages/cli/src/baerly.ts:67`.

That's a peer of `admin migrate` / `admin restore`, not of
`dev` / `init`. Top-level `baerly --help` should show day-1
verbs, not operator forensics.

**Fix:** Move to `baerly admin copy`. Update CLI dispatcher.
Verify no docs/scripts reference `baerly copy` (rename map).

### G5. Top-level help: 15 reachable verbs, no ordering

**Severity: MEDIUM.**

`packages/cli/src/baerly.ts:59–76` shows 8 top-level
subcommands (`copy`, `deploy`, `dev`, `doctor`, `init`,
`inspect`, `export`, `admin`) plus 7 under `admin`
(`rebuild-index`, `dump`, `restore`, `compact`, `gc`, `fsck`,
`migrate`). Ordering is lexicographic by citty rendering,
not frequency-ranked.

Top-level description also includes a forward reference to
`docs/about/pricing-log.md` — a docs URL no user can reach
from their terminal.

**Fix:** Re-order top-level by frequency of use:
`dev`, `deploy`, `doctor`, `init`, `inspect`, `export`,
`admin`. Drop `copy` (per G4). Trim the top-level description
to one line; move pricing-log breadcrumb to README/website.

---

## App/tenant resolution

### G8. `inspect` silently falls back to `app=app, tenant=tenant`

**Severity: MEDIUM. Confidently-wrong output is worse than a hint.**

`packages/cli/src/inspect.ts:168–189` `resolveAppTenant` falls
through to literals `"app"` / `"tenant"` (lines 182, 185) when
both flags are absent and `baerly.config.ts` can't load.

A user running outside the app directory gets confident-
looking "current.json not found" output pointing at
`app/app/tenant/tenant/...`. Same anti-pattern likely in every
`admin *` command that uses `resolveAppTenant`.

**Fix:** Fail with `InvalidConfig` (exit 1) + a hint pointing
at `--app` / `--tenant`. Centralise in the shared helper
proposed in G6.

### G9. `admin rebuild-index` uses citty defaults, not the shared resolver

**Severity: MEDIUM. Two policies for `--app`/`--tenant` inside
one `admin` subtree.**

`packages/cli/src/admin/rebuild-index.ts:55–67` uses citty's
`default: "app"` / `default: "tenant"` directly in the arg def
rather than the `resolveAppTenant` pattern used elsewhere.

**Fix:** Standardise on the shared `resolveAppTenant` helper
(see G6). Apply the same fix to any other admin command that
diverges.

---

## DRY / refactors

### G6. Sub-command boilerplate duplication

**Severity: MEDIUM. Smaller than analyst claimed but real.**

Brief claimed "13 copies of `errorToExitCode`, 13 `KNOWN_KEYS`
sets, 7 of `resolveAppTenant`." Actual counts (grep-verified):
- `errorToExitCode`: 2 implementations (`doctor.ts:80`,
  `inspect.ts:107`) + a divergent one in `export.ts:154`.
- `KNOWN_KEYS`: ~14 declarations across subcommands + tests.
- `resolveAppTenant`: 2 implementations (`inspect.ts:168`,
  `export.ts:154`), never shared.

The exact ceremony tax is smaller than claimed but the pattern
is still copy-paste-prone.

**Fix:** Extract
`defineBaerlySubcommand({ name, args, handler })` that wraps:
- `KNOWN_KEYS` whitelist for argv arg sanity-checking
- `errorToExitCode` standard mapping
- `emitError` integration (JSON-mode aware)
- `resolveAppTenant` with the fail-loudly behavior from G8

Refactor `inspect` + `export` + `doctor` + the `admin/*`
commands onto it.

### G18. `loadConfigIndexes` re-implemented in 2 files

**Severity: LOW. Two near-identical 30-line parsers.**

`inspect.ts:114–149` and `admin/rebuild-index.ts:120–180`
parse `baerly.config.ts` and pluck
`cfg.collections?.[table]?.indexes ?? []` near-verbatim.
(Brief claimed 3 files; only 2 verified.)

**Fix:** Hoist to `packages/cli/src/config.ts` as
`loadCollectionIndexes(configPath, table)`. Both consumers
become 1-liners.

### G14. `defaultRunner` duplicated

**Severity: LOW. ~20 LOC each.**

`packages/cli/src/doctor.ts:140` and
`packages/cli/src/deploy/cloudflare.ts:62` both wrap
`node:child_process.spawn` for stdout/stderr piping. Diverge
slightly (doctor doesn't tee).

**Fix:** Hoist to `packages/cli/src/runner.ts`. Single
implementation with optional `tee: boolean`.

### G19. `parseBucketUri` lives inside `copy.ts`

**Severity: LOW. Wrong-named module for a shared helper.**

7 CLI modules `import { parseBucketUri } from "./copy.ts"`
(inspect, export, and 5 of the admin commands). Couples
unrelated commands to a verb-named module.

**Fix:** Move `parseBucketUri` (and `parseCursor`, if shared)
to `packages/cli/src/bucket-uri.ts`. Update all 7 imports.

If G4 lands first and `copy` moves to `admin/`, this becomes
even more important — the import path becomes circular-feeling
(`admin/foo.ts` importing from `admin/copy.ts` for a non-copy
helper).

---

## Wizard / scaffold

### G11. Wizard never shows the `helpdesk` template

**Severity: MEDIUM. Hidden feature.**

`packages/create-baerly/src/prompts.ts` `runWizard` returns
`{ projectName, target, withAddons, install }` only.
The `helpdesk-cloudflare` template is reachable only via
`--starter=helpdesk` on the flag-driven path. A wizard user
has no way to discover it.

**Fix:** Add a select prompt for `starter`: `minimal` /
`helpdesk`. Or — coordinate with
[`examples-helpdesk-dedup.md`](./examples-helpdesk-dedup.md):
if the helpdesk example gets reshaped to a 60-line getting-
started, the wizard's "starter" prompt may collapse.

### G21. Scaffold ignore-list split between hardcode and manifest

**Severity: LOW.**

`packages/create-baerly/src/scaffold.ts:215–224` unconditionally
skips `node_modules`, `dist`, `.wrangler`, `.dev.vars`,
`.DS_Store`, `*.tsbuildinfo` *in addition to* each example
manifest's `excludePaths`.

**Fix:** Drop the hardcoded list; require each manifest to
declare its own. The manifest exists for exactly this — a
config-vs-code split for the same concept is the smell.

### G22. AGENTS.md → CLAUDE.md copy hardcoded in scaffold walker

**Severity: LOW.**

`packages/create-baerly/src/scaffold.ts:245–250` hard-codes
`if (ent === "AGENTS.md")` → also writes to `CLAUDE.md`.
Adding a third coding-tool variant (`.cursorrules`,
`.aider.conf`) requires a code edit.

**Fix:** Add `manifest.copies: [{ from: "AGENTS.md", to:
"CLAUDE.md" }]` to the manifest schema. Drop the hardcoded
branch.

---

## Env-var grooming

### G16. Env-var test hooks live in production code

**Severity: LOW.**

`packages/cli/src/admin/dump.ts:229` and
`packages/cli/src/admin/restore.ts:218` branch on
`BAERLY_DUMP_STDOUT_PATH` / `BAERLY_RESTORE_STDIN_PATH` solely
so vitest can divert stdin/stdout to files.

**Fix:** Make `runDump` / `runRestore` accept `{ streams?:
{ stdin?: Readable, stdout?: Writable } }`; tests pass file
handles directly. Delete the env-var branches.

### G17. `BAERLY_REBUILD_INDEX_VERBOSE` is undocumented env-only verbosity

**Severity: LOW.**

`packages/cli/src/admin/rebuild-index.ts:211` gates verbose
output on `BAERLY_REBUILD_INDEX_VERBOSE`. Not in any docs.

**Fix:** Replace with `--verbose`. Standardise the flag across
admin commands.

### G20. `S3_ENDPOINT` vs `BAERLY_S3_ENDPOINT` vs `R2_ENDPOINT`

**Severity: MEDIUM. Three names for one concept; collision
risk with system env.**

- `BAERLY_S3_ENDPOINT` — `copy.ts:108`, `inspect.ts:85`
- `S3_ENDPOINT` — `doctor/index-filter-drift.ts:94`
  (collision risk with system tooling that already uses this
  name)
- `R2_ENDPOINT` — `doctor/cloudflare.ts:416`

**Fix:** Standardise on `BAERLY_S3_ENDPOINT` everywhere.
`R2_ENDPOINT` can alias for backward-compat if any docs
shipped — verify first. Drop bare `S3_ENDPOINT` entirely.

---

## Drop

### G1. `@baerly/cli` exports a public library API nobody imports

**Severity: HIGH. Pure dead code.**

`packages/cli/src/index.ts` exports 15+ public library
functions (`runCopy`, `doCopy`, `parseBucketUri`, `runDev`,
`runInit`, every `admin/runXxx`, etc.). Zero external callers
across `packages/`, `tests/`, `examples/`, `manual-e2e/`,
`bench/`, `eval/`.

Exists only so vitest can call `runFoo(argv)` without
`process.exit`.

**Fix:** Delete `packages/cli/src/index.ts`. Drop the
`exports` block from `packages/cli/package.json`. Keep
`bin: "./dist/baerly.js"` as the only public artifact. Tests
can co-locate with their subcommand modules or use a test-only
`index-internal.ts`.

Verify before deletion: re-run `pnpm test` to confirm tests
that imported from `@baerly/cli` either use the bin or import
from the subcommand module directly.

---

## Dropped (already shipped or invalid)

- **G12** — already shipped (`defineConfig` moved to
  `baerly-storage/config`, per memory + commit `0003740`).
- **G13** — already shipped: `admin compact` + `admin gc`
  split landed at commit `cb03690`. No `--skip-gc` / `--skip-compact`
  flags remain.
- **G15** — already shipped: `freeTierBudgetHint` removed
  at commit `8758f95`.
- **G10** — invalid: the wizard's `install` value IS threaded
  through (`prompts.ts:118–120` captures, returned in
  `WizardOutput`, consumed in scaffold).
