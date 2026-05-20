# Next-batch followups — burn-down index

This file used to hold a 40 KB analyst dump pending triage. As
of 2026-05-19, all items have been extracted into per-topic
docs, validated against current code (or dropped as
stale/invalid). This index points at where each topic now
lives.

If you're a worker picking up a ticket: each topic doc tags
items as **validated** (file:line confirmed) or
**[needs-verify]** (worker re-greps before editing). The
analyst brief had ~70% accuracy on file:line specifics; verify
before action.

---

## Per-topic docs (extracted 2026-05-19)

| Doc | Items covered | Status |
|---|---|---|
| [publish-direction.md](./publish-direction.md) | A1, A3, A6 (package-name schism) | **Open strategic question** — needs user call |
| [dead-symbols.md](./dead-symbols.md) | A7, D6 (deferred), D8, D9 | Validated; ready to ticket |
| [errors-and-types.md](./errors-and-types.md) | A9, A13, A14 | Validated; small, focused |
| [cli-cleanup.md](./cli-cleanup.md) | G1, G2, G3 (strategic), G4–G6, G8, G9, G11, G14, G16–G22 | Validated; G3 needs decision |
| [server-kernel-cleanup.md](./server-kernel-cleanup.md) | A4, B-series (sans B5/B14/B23 dropped/rescoped) | Mostly validated; some `[needs-verify]` |
| [protocol-package-cleanup.md](./protocol-package-cleanup.md) | D1, D10–D13, D15–D20 | Validated; D14 dropped |
| [examples-helpdesk-dedup.md](./examples-helpdesk-dedup.md) | H7 | **Open strategic question** — needs user call |
| [dev-command-spa.md](./dev-command-spa.md) | Items 1, 2 (baerly dev + helpdesk-cloudflare banner) | Deferred design questions |
| [infra-cuts-parked.md](./infra-cuts-parked.md) | I1–I20 (bench/eval cuts) | Parked — revisit post-launch preflight |

---

## Pre-existing followups (still live, not from this triage)

- [unify-baerly-storage.md](./unify-baerly-storage.md) — carried
  from the 2026-05-18 unify-baerly-storage merge.
- [dev-vite-plugin-extract.md](./dev-vite-plugin-extract.md) —
  resolves the `@baerly/dev` ↔ `@baerly/adapter-node` workspace
  cycle.
- [prelaunch-package-json-polish.md](./prelaunch-package-json-polish.md)
  — small package.json polish ahead of public-npm publish.

---

## Dropped in triage

Items the analyst raised that were verified shipped, invalid, or
the framing was wrong enough to start over:

- **G10** — wizard "Install dependencies?" prompt: the value IS
  threaded through; brief was wrong about it being dropped.
- **G12** — `defineConfig` move to `baerly-storage/config`:
  already shipped at commit `0003740`.
- **G13** — `admin compact` + `admin gc` split: already shipped
  at commit `cb03690`.
- **G15** — `freeTierBudgetHint` strip from dev banner: already
  shipped at commit `8758f95`.
- **B5** — defensive `undefined` spreads everywhere: grep finds
  zero hits in `packages/server/src/`; analyst was wrong about
  scale or saw a different package.
- **D14** — `Storage.put({ifNoneMatch: "*"})` + unused
  `versionId` on `get`: the `ifNoneMatch` half not found; the
  unused-`versionId` half is folded into D15 in
  `protocol-package-cleanup.md`.

## Rescoped

- **A4** — "top barrel ships ~50 internal symbols" — actual
  count is ~40 (per the 2026-05-18 bundle trim). Still real;
  see `server-kernel-cleanup.md`.
- **B14** — "SingleAttemptOutcome splits one logical operation
  across 350 lines" — actual is a 9-line discriminated union.
  Smaller fix; see `server-kernel-cleanup.md`.
- **B23** — `IN_FANOUT_THRESHOLD` vs `IN_FANOUT_PARALLELISM` —
  the partner constant doesn't exist. Reframed as "hard-code or
  keep configurable" question.
- **G5** — "13 verbs" — actual is 15 (8 top-level + 7 admin).
  Ordering critique still valid.
- **G6** — "13 copies of `errorToExitCode`" — actual is 2–3
  copies of each helper. Pattern is real, scale was overstated.
