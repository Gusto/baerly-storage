# Orphan fixtures and an unwired verify script

**Severity: LOW. Two small repo-hygiene fixes, similar shape. Both
"this exists but nothing references it" — pick a side per item.**

## 1. `manual-e2e/fixtures/s3-key-escaping/` — five zero-byte files

`manual-e2e/fixtures/s3-key-escaping/` contains five zero-byte
files with hostile-key names (`&$@=;  :+,?`, `<![CDATA[...]]>`,
`&lt`, `foo<Contents>`, `\{^}%\]">[~#|`) plus a `README.md`. No
test or script in `tests/` or `manual-e2e/` references the
directory by path or by glob.

The randomized cascade (`tests/integration/randomized.test.ts` +
`tests/fixtures/randomized-cascade.ts`) already arbitraries-covers
hostile keys via `fast-check`. The fixture dir is leftover from an
earlier exploratory phase.

**Fix — pick one:**

- **Delete `manual-e2e/fixtures/s3-key-escaping/` entirely.** The
  randomized cascade is the live signal. The fixture README points
  at a future use case that hasn't materialised.
- **Move to `docs/spec/fixtures/`** if the README has any spec
  value worth preserving (read it first; if it documents *why*
  these key shapes are interesting, the doc stays; if it just
  catalogues the files, the dir goes).

Recommended: delete. Pre-launch, fixtures with no tests pointing at
them are accretion.

## 2. `scripts/add-ts-extensions.mjs` audits an invariant but isn't wired into `verify`

`scripts/add-ts-extensions.mjs --check` audits the
no-extensionless-relative-imports invariant
(CLAUDE.md anti-pattern). Oxlint's `import/extensions` rule covers
most call sites, but the script audits paths oxlint doesn't see —
root configs, scripts, `bench/`, `manual-e2e/`, `examples/`,
`*.config.ts`.

Root `package.json:verify` runs:

```
"verify": "pnpm run typecheck && pnpm run lint"
```

No call to `add-ts-extensions.mjs --check`. So the script's safety
net only fires when a contributor runs it by hand — i.e. never.

**Fix — pick one:**

- **Wire it in.** Append `node scripts/add-ts-extensions.mjs
  --check` to `package.json:verify`. The script is fast and
  catches a class of bugs oxlint can't see. Recommended.
- **Delete the script.** If oxlint covers everything we care about,
  the script is redundant; the bare-imports-in-bench/manual-e2e
  case isn't load-bearing. Smaller-surface answer; honest about
  what's actually enforced.

Recommendation: wire it in. The script exists because oxlint
*doesn't* cover those paths and node's strip-types runtime
*requires* the extensions there. The cost of the check is a few
hundred ms.

## Cross-references

- `uint8array-base64-shim-parity.md` proposes a sibling check;
  if both land, consolidate them into a single
  `scripts/check-template-invariants.mjs` or wire each script
  individually.
- The "should `verify` also run `add-ts-extensions.mjs`?" question
  is independent of any decision on `manual-e2e/fixtures/`.
