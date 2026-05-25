# Match `wrangler.jsonc` indent style when bolt-on appends

**Severity: LOW. Cosmetic; doesn't affect parse correctness.**

`patchWranglerJsonc` hard-codes `FORMATTING_OPTIONS = { tabSize: 2,
insertSpaces: true, eol: "\n" }` for the `jsonc-parser` edits. The
stock `pnpm create cloudflare --type=hello-world` template emits
tab-indented `wrangler.jsonc`. Result after bolt-on: the original
keys stay tab-indented, our appended `r2_buckets` + `vars` blocks
are space-indented, and `jsonc-parser` rewrites the closing `}` of
adjacent objects with spaces. The file parses fine; the diff looks
mixed.

Repro (the smoke for the original bolt-on landing surfaced this):

```sh
cd /tmp
pnpm create cloudflare smoke --type=hello-world --lang=ts --git=false --deploy=false
cd smoke
node --experimental-strip-types <path-to-worktree>/packages/create-baerly/src/index.ts .
head -20 wrangler.jsonc  # tab/space mix
```

## What to do

Detect the source file's indent style before passing options to
`modify`. Approaches:

- **Cheap:** sniff the first non-`{` line for leading whitespace.
  If it starts with `\t`, set `insertSpaces: false` and skip
  `tabSize`. Otherwise count leading spaces for `tabSize`.
- **Robust:** use a tiny `detect-indent`-shaped helper that looks
  at every indented line and picks the dominant pattern. We don't
  need an external dep for ~10 lines of code.

Bake the detection into `patchWranglerJsonc` itself — the caller
shouldn't have to know about it. The helper signature stays the
same; the formatting options become per-call rather than module-
constant.

## Why we shipped without this

The bolt-on lands an idempotent, parse-correct edit. Mixed indent is
ugly but doesn't break wrangler or any downstream tooling — wrangler
itself uses `jsonc-parser` and is indent-agnostic. Pre-launch we're
optimising for the working flow; a follow-up cosmetic pass is
cheaper than holding the launch.

## When to close

When `patchWranglerJsonc` detects + matches the source's indent
style, and we have a smoke test (or property test) confirming that
a tab-indented `wrangler.jsonc` stays tab-indented after a patch.
