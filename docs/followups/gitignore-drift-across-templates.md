# `.gitignore` drift across example templates

**Severity: LOW. Cosmetic; affects scaffolded-user repo hygiene.
One canonical shape unblocks the cluster.**

Each of the four example dirs has a different `.gitignore`
situation:

| Example | `.gitignore` | Style |
|---|---|---|
| `examples/minimal-cloudflare/` | present | no trailing slashes |
| `examples/minimal-node/` | present | no trailing slashes |
| `examples/helpdesk-cloudflare/` | present | **trailing slashes** |
| `examples/helpdesk/` | **missing entirely** | — |

Concrete drift: `minimal-cloudflare/.gitignore` lists `.wrangler`;
`helpdesk-cloudflare/.gitignore` lists `.wrangler/` (with slash).
`minimal-node/` omits `.wrangler` (it doesn't use wrangler).

The helpdesk gap is covered separately in
`helpdesk-fixture-hygiene.md` — add a `.gitignore` there.

## Fix

Pick a canonical shape and apply it to all four:

**Trailing-slash style** (matches `helpdesk-cloudflare`):

```gitignore
node_modules/
dist/
.DS_Store
*.tsbuildinfo
# CF-only:
.wrangler/
.dev.vars
# Node-only:
.env
.env.local
.baerly-data/
```

Each template ships the common base + the target-specific extras.

## Rationale

Trailing slashes are conventional for directory entries in
`.gitignore` and unambiguous: `dist/` matches the directory and
everything in it, `dist` (no slash) also matches a file named
`dist`. The latter ambiguity is harmless today but noisy on
review.

## Cross-references

- `helpdesk-fixture-hygiene.md` adds the missing
  `examples/helpdesk/.gitignore` — coordinate the style choice with
  this doc.
