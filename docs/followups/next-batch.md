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
| [adapter-collections-wiring.md](./adapter-collections-wiring.md) | A9 (corrected framing — adapters drop `baerly.config.ts` collections, schema/index features unreachable) | **Pre-launch gap** — verify + fix before publish |
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

