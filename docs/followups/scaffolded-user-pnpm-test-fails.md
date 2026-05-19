# Templates declare `pnpm test` but ship no vitest dependency

**Severity: MEDIUM. Fails the first command a curious scaffolded
user runs after `pnpm dev`.**

Each of `examples/minimal-cloudflare/package.json`,
`examples/minimal-node/package.json`, and
`examples/helpdesk-cloudflare/package.json` declares:

```json
"scripts": { "test": "vitest run" }
```

None of them lists `vitest` in `devDependencies`. Inside the
monorepo this works because workspace resolution provides
`vitest` from the root devDeps; once the scaffolder copies the
template into a user repo, the workspace is gone and
`pnpm test` fails with `command not found: vitest`.

This collides with the broader first-touch DX story (memory
`project_first_touch_dx_shipped`) and undermines a low-effort
question new users ask of any new tool ("does its `test` script
work?").

## Two ways to fix; pick one

**Option A — drop the script.** Templates ship zero `*.test.ts`
files; deleting `scripts.test` makes the package.json honest.
Smallest change. Loses a discoverability hook ("what's the test
command for this template?").

**Option B — ship a smoke test.** Add a one-test
`smoke.test.ts` and the minimum devDeps (`vitest` + a `tsx`-aware
config — see `tests/integration/bundle-size.test.ts` for a tiny
example shape). The test should be high-value: round-trip the
client against `LocalFsStorage` (Node) or the R2 binding
(Cloudflare). This is the better DX answer — gives users a
working example to copy when they write their own tests.

## Cross-references

- The `vitest.config.ts:135` include glob picks up
  `examples/*/smoke.test.ts`, but only `examples/helpdesk/smoke.test.ts`
  exists today. If Option B lands, the glob starts firing for
  every template — desired.
- Memory `project_first_publish_to_verdaccio_shipped` confirms
  Verdaccio publishes work end-to-end; this gap is the
  *post-install* experience, not the publish step.
