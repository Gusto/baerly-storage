# Root `package.json` is missing npm-registry polish fields

**Severity: LOW. Cosmetic on the npm listing page; no install-time
effect. Best closed before the first public `npm publish`.**

Root `package.json` has everything load-bearing — `name`,
`version`, `description`, `keywords`, `license`, `files`, `type`,
`sideEffects`, `exports`, `publishConfig`, `engines`,
`packageManager` — but the four fields the npm UI surfaces in the
sidebar are absent:

- `repository`
- `bugs`
- `homepage`
- `author`

Without these, the published listing has no "Repository" /
"Homepage" / "Issues" links and credits no author. Easy to add;
easier to add **before** the listing exists and a stale screenshot
caches on a third-party SEO crawl.

## Fix

Add the four fields. Suggested shape:

```json
{
  "repository": { "type": "git", "url": "git+https://github.com/<org>/baerly-storage.git" },
  "bugs":       { "url": "https://github.com/<org>/baerly-storage/issues" },
  "homepage":   "https://github.com/<org>/baerly-storage#readme",
  "author":     "Eric Baer"
}
```

The canonical URLs are a 30-second decision — they're the only
thing blocking this. Defer hard-pinning until the org/repo names
are settled.

## Optional, same touch

- `engines.pnpm` for symmetry with `engines.node` — e.g.
  `"pnpm": ">=11.1.2"`. Aligns the install-time enforcement story
  with the `packageManager` declaration.
- A top-level `.npmrc` with `engine-strict=true` so contributors
  can't silently install on Node 22.

Both are nice-to-have, not register-listing blockers.
