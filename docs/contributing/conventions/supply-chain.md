---
title: Supply-chain conventions
audience: coder
summary: What review applies to every dependency, install-policy and CI change, and how the exception register keeps loosenings visible and expiring.
last-reviewed: 2026-11-17
tags: [conventions, security, supply-chain]
related: [change-discipline.md, "../publishing.md", "../exception-register.json"]
---

# Supply-chain conventions

Applies to every change that touches `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, an `examples/*/pnpm-workspace.yaml`, or `.github/**`. The stance is **strict by default**: prefer the setting that fails closed, and loosen one only deliberately, with a comment and a register entry.

## A new or bumped dependency states

- **Provenance.** Does the version carry npm provenance or a trusted publisher (`pnpm view <pkg>@<version> dist.attestations`)? `trustPolicy: no-downgrade` rejects a version whose trust is lower than an earlier one's; don't route around it.
- **Install scripts.** Does it have a `preinstall`, `install` or `postinstall` script (`pnpm view <pkg>@<version> scripts`)? An unlisted package that gains one fails the install (`strictDepBuilds`). Add it to `allowBuilds: true` only when the script does something we need, and register that.
- **Whether it ships to users.** A runtime dependency of anything published stays at the bar in `CLAUDE.md` (anti-patterns: every addition widens the kernel bundle and the audit surface; justify it). A build-time or dev-only dependency is fine, and the PR says it is dev-only.

## A loosened setting carries a comment and a register entry

A loosening is anything that makes install, audit or update accept what the defaults would refuse:

- an `audit.ignore` id, an `overrides` or `packageExtensions` key, `ignoreWorkspaceCycles`, `trustPolicyExclude`, `minimumReleaseAgeExclude`;
- an `allowBuilds: true` entry, in the root or in any `examples/*` template;
- a strict setting that drifts from its required value (`trustPolicy: no-downgrade`, `minimumReleaseAge >= 1440`, `blockExoticSubdeps`, `strictPeerDependencies`, `engineStrict`, `strictDepBuilds`, `dangerouslyAllowAllBuilds`), registered as subject `weakened:<setting>`;
- an `ignore` entry in `.github/dependabot.yml`;
- a zizmor ignore comment or config file under `.github/`;
- an exact version pin held back for policy reasons, a dashboard acceptance (a Socket license accept) and a known tool bug we are waiting out (kind `external`).

The checker discovers the first five kinds. It does not discover the last: most exact pins in a manifest are plain reproducibility choices, and the dashboard and tool bugs are invisible to the repo. A pin held back for policy reasons is found through the Dependabot `ignore` entry that protects it (the lefthook pin), and otherwise relies on review applying this page. CodeQL has no in-repo suppression file, so a suppression made in the GitHub UI is not detected either; record it as an `external` entry.

Put a comment beside the setting that says why, then add an entry to [`docs/contributing/exception-register.json`](../exception-register.json): `kind`, `files`, `subject`, `reason`, `revisit` (the condition that removes it) and `expires` (`YYYY-MM-DD`). Pick an expiry you would be willing to re-justify: 30 days for an advisory with no fix, 90 to 180 days for a structural exception. `scripts/check-exceptions.ts` runs in `pnpm verify` on every PR and in the nightly `audit` job. It fails when an entry has expired, when a detectable loosening has no entry, and when an entry names a loosening that no longer exists (a `pin` whose text is gone, or any other kind whose loosening is gone), so delete the entry in the same change that removes the loosening. To renew, edit `expires` and say why in the commit message.

`allowBuilds: false` is not a loosening, but a dead `false` entry (a package that has no script) is wrong too: it would hide a script the package gains later. List only entries that decide something.

## Standing signals

- **Dependabot** covers github-actions, npm, docker-compose and the Dockerfile template, with a 7-day cooldown above pnpm's own `minimumReleaseAge`.
- **No PR-time advisory gate.** The dependency-review action's GitHub API call is blocked by the org IP allow list on GitHub-hosted runners, so no check on a PR flags a newly introduced advisory. The nightly audit and the release audit below cover advisories (a register entry tracks the gap). A PR gate can return once a runner on the org allow list exists.
- **Nightly.** The `audit` job in `test-infra.yml` runs a full-tree `pnpm audit` (dev dependencies included), `pnpm audit signatures`, and the register check. Each step runs even if an earlier one failed, and the job fails if any does. A failing run notifies the workflow owner through GitHub's scheduled-failure notification. `pnpm audit` 12.21.0 silently drops advisories whose id is a string, so until the pnpm 12.22.0 bump lands a clean audit is provisional (a register entry tracks it).
- **Release.** The release workflow runs `pnpm audit --prod --audit-level=high` and `pnpm audit signatures` before publishing.
- **CodeQL** default setup for the `actions` language is a repo setting (owner). zizmor in CI and a scheduled OpenSSF Scorecard run need an org allow-list request; until they exist, zizmor runs ad hoc in the per-release review.
