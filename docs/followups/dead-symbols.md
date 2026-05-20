# Followups: dead / speculative public symbols

**Source: 2026-05-19 analyst triage (A7, D8, D9).** All items
verified to still exist as of triage; "no callers" claims spot-
checked against `packages/`, `tests/`, `examples/`, `manual-e2e/`,
`bench/`, `eval/`.

The shared pattern: functions or brand types exported on the
public surface that either (a) carry "Do NOT call" warnings yet
ship anyway, or (b) have no consumers outside their own file.
Pre-launch is the right time to delete; afterwards each one
becomes a compat-tax forever.

---

## 1. Auth-helper accretion: `awsIamSigV4`, `allowlistIp`, `andAll`

**Severity: MEDIUM. Speculative surface; verified zero callers.**

Three auth helpers ship publicly via `baerly-storage/auth` (or
its workspace equivalent) and have no consumers across the repo:

- `awsIamSigV4` — 356 LoC SigV4 verifier. Zero callers.
- `allowlistIp` — 248 LoC including an IPv6 CIDR parser. Zero
  callers.
- `andAll` — combinator over `Verifier`. Zero callers.

The brief frames these as "speculative SigV4 + IPv6 CIDR parser
pre-launch is exactly the kind of accretion to cut." Agreed.

**Fix:** Delete all three. Drop the re-exports from
`packages/server/src/auth/index.ts` (or wherever the auth barrel
lives). Verify no docs / examples reference them before deleting
— grep for each symbol across the tree first.

---

## 2. `claimWriter` — admin-only verb on the kernel barrel

**Severity: MEDIUM.**

`claimWriter` ships through `packages/server/src/index.ts:120`
as documented public API ("Reserved for admin rotation workflows
and initial provisioning"). Callers: only `packages/cli/`
(admin commands) and `tests/setup`. No app-code callers.

The brief itself flags this is partly defer-eligible — see
D6 in §"deferred" below. But the *kernel-barrel export* of an
admin verb is the part to cut now.

**Fix:** Move `claimWriter` behind a `baerly-storage/admin`
subpath (mirrors the bundle-trim pattern that moved maintenance
+ observability off the main barrel). Update CLI imports.

---

## 3. `singleTenantDevVerifier`

**Severity: MEDIUM.**

Lives in `packages/adapter-cloudflare/` per the analyst (verify
file:line before action). Exported with a "dev-only / not for
production" JSDoc. A function exported like that on a public
package WILL get pasted into production.

**Fix:** Pick one:
- Move to a dev-only subpath: `baerly-storage/cloudflare/dev`
  or fold into `@baerly/server/auth` as `staticTenantVerifier`
  (renamed to drop "single-tenant" since multi-tenant prefix
  selection is the engine job).
- Or: delete + replace every example with `sharedSecret` over
  a hard-coded dev secret. (Examples already do this in some
  places.)

Verify scaffolded `examples/*-cloudflare/` and
`manual-e2e/cloudflare/` aren't depending on the public export
before action.

---

## 4. D8. Brand types `ManifestKey`, `S3VersionId`, `ContentVersionId`, `VersionId` leak with no enforcement

**Severity: MEDIUM.**

`Storage.put`/`get` use plain `string` for `versionId`.
`ManifestKey` is unused anywhere. `versionFromUuid` exists only
to produce a `ContentVersionId` brand nothing enforces — every
caller drops the brand at the next boundary.

**Fix:** Delete all four brand types and `versionFromUuid`.
Type `versionFromContent` as `Promise<string>`.

The brand-type philosophy in the project ("`Ref`, `ManifestKey`,
`UUID`, `VersionId` exist to prevent confusion bugs" per
CLAUDE.md) is real but these four are noise — no enforcement
means no protection.

---

## 5. D9. `Ref` / `ResolvedRef` / `eq` / `url` / `resolveContentRef` / `resolveManifestRef` / `DeleteValue` are dead

**Severity: MEDIUM.**

Pre-collections-era addressing model. Per the brief, these live
only in `packages/protocol/src/types.ts` with no callers.

**Fix:** Delete the seven symbols. Then:
- `countKey` has one caller — inline at the call site.
- `uint2strDesc` / `str2uintDesc` — inline at their 2–3 call
  sites.

**Verify before deletion:** grep each name across the tree
including JSDoc `@example` blocks. The analyst brief has a
70% accuracy track record on file:line claims; verify counts
yourself before acting.

---

## 6. D6 (deferred by analyst). `claimWriter` + `WriterFence.lease_until`

**Severity: defer until A1/publish direction lands.**

`packages/protocol/src/coordination/current-json.ts` implements
`claimWriter` (~95 LoC two-CAS-round-trip).
`WriterFence.lease_until` is documented "Reserved for future
manual rotation workflows; current code only writes the field
through if a caller supplies it and does not read it."

The brief recommends deferring — deletion is a public-API
surface change, couple with the package-publish decision
(see `publish-direction.md`).

Listed here for visibility; not actionable until that lands.
