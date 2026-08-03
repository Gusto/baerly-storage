---
"@gusto/baerly-storage": patch
---

Stop shipping the Node-only `LocalFsStorage` closure inside every deployed
Cloudflare Worker.

`packages/adapter-cloudflare/src/worker.ts` imported `renderDevLanding` from
the `@baerly/dev` barrel. That barrel also re-exports `LocalFsStorage`, so
rolldown chunked the whole Node-only local-fs closure — `node:crypto`,
`node:fs/promises`, `node:os`, `node:path` — into the Worker bundle for the
sake of one HTML string. None of it can run under Workerd; it was dead
weight on every request.

`dev-landing.ts` has no imports at all, so it now gets its own
`@baerly/dev/dev-landing` subpath and the Worker imports the leaf module.
`dist/cloudflare.js` drops 12705 B raw / 3614 B gz / 1765 B min-gz, and the
budgets tighten to match rather than bank the win as headroom.

Nothing stopped this returning, and nothing had caught it in the first
place: the byte budgets all still passed with the barrel import in place,
and `scripts/lint-package-layers.mjs` could not see it either — its
`allowNode` gate reads a package's own source, and no `node:` specifier ever
appeared in `packages/adapter-cloudflare/`. Two guards close that. The lint
table gains the missing `adapter-cloudflare` row, and a new assertion checks
the artifact where a transitive drag actually becomes observable: the
`dist/cloudflare.js` closure may import no Node builtin but
`node:async_hooks`, the one Workerd supports under `nodejs_compat`.
