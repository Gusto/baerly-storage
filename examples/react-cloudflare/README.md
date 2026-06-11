# react-cloudflare

A baerly app scaffolded with `@gusto/create-baerly-storage` for the **Cloudflare
Workers** target, with a React + Vite SPA. Single-bucket R2-backed
deployment via `@gusto/baerly-storage/cloudflare`. Ships `auth: "none"`
so the day-1 happy path works with zero env vars, plus a
one-collection `notes` schema you extend; flip to Cloudflare Access
or a shared secret before deploy — see "Production auth" below.

**The only persistent component is your R2 bucket** — there is no Worker to keep warm, no database daemon to operate, no idle bill, and maintenance is automatic and write-triggered (no cron, no sidecar, no scheduler).

## What you got

```
react-cloudflare/
├── package.json              # one package, all deps
├── tsconfig.json             # project-references stub
├── tsconfig.app.json         # client TS project (src/web)
├── tsconfig.worker.json      # Worker TS project (src/server)
├── vite.config.ts            # Vite + @vitejs/plugin-react + @cloudflare/vite-plugin
├── wrangler.jsonc            # Worker manifest — R2 binding, assets, vars, cron, observability
├── index.html                # SPA shell — Vite's entry point
├── baerly.config.ts          # app, tenant, target, NoteSchema, `Note` type
├── AGENTS.md                 # deeper guide: hooks, schema, auth, deploy
├── CLAUDE.md                 # same content (Claude Code reads this)
├── src/
│   ├── server/
│   │   └── index.ts          # baerlyWorker((env) => ({ verifier }))
│   └── web/
│       ├── main.tsx          # React entry
│       ├── App.tsx           # Provider + new-note form (useMutation)
│       ├── client.ts         # BaerlyClient bound to this config
│       └── NoteList.tsx      # useQuery + per-row useMutation
└── README.md
```

## Run locally

```sh
pnpm install
pnpm dev
```

`pnpm dev` runs Vite. `@cloudflare/vite-plugin` runs the Worker
inside `workerd` next to the SPA dev server, so the SPA and `/v1/*`
share an origin (`http://localhost:5173`). First run downloads the
`workerd` binary.

Open <http://localhost:5173>. Type a note, hit "Add note." Open a
second tab — inserts, edits, and deletes in one tab appear in the
other over the `/v1/since` long-poll.

`pnpm build` runs `tsc -b && vite build`; the SPA lands in
`dist/client/` for the `assets:` binding in `wrangler.jsonc` to
serve on deploy.

## Deploy

```sh
baerly deploy                         # reads baerly.config.ts:target, runs wrangler deploy
baerly doctor --target=cloudflare     # verify bindings, secrets, cron
```

`baerly doctor --target=cloudflare` warns on `auth: "none"` for
deploy targets — see "Production auth" below to flip the posture
before shipping.

## Extend the schema

Edit `baerly.config.ts`. The `Note` row type is inferred from
`NoteSchema` in the same file — adding a field to the schema
propagates to the UI through `import type { Note }`.

```typescript
export const NoteSchema = z.object({
  _id: z.string(),
  body: z.string().min(1),
  // Add fields here:
  tags: z.array(z.string()).optional(),
});
```

## Production auth

The scaffold ships `auth: "none"` so the day-1 happy path works
with zero env vars; every request resolves to `config.tenant` and
the `NoteSchema` still validates writes server-side. Before deploy,
follow `AGENTS.md` → "Going to production":

- **Pattern A — CF Access (recommended).** Same artifact in dev and
  prod; the factory `verifier:` override engages when
  `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUDIENCE_TAG` are present in
  `wrangler.jsonc:vars`. The `cloudflareAccess()` preset
  (re-exported from `@gusto/baerly-storage/auth`) reads the JWT off
  `Cf-Access-Jwt-Assertion`, validates it against your team's JWKS,
  and derives `tenantPrefix` from the email claim.
- **Pattern B — `auth: "shared-secret"`.** Single-tenant
  server-to-server callers. Flip `auth` in `baerly.config.ts`, set
  `SHARED_SECRET` via `wrangler secret put`, and re-enable
  `baerlyDevAuth` in `vite.config.ts` for browser bearer injection
  (the SPA never owns the secret — Vite injects it server-side).

## When to graduate

baerly is sized for the small-to-medium operating point. Past
~30 writes/min/collection, ~10 GB/tenant, or ~100 collections/
tenant, graduate to D1 or Postgres via `baerly export
--target=postgres`. Your data was already in your bucket; the
export is a mechanical translator, not a vendor migration.

## Pointers

- `baerly.config.ts` — app config + Zod schema.
- `src/server/index.ts` — Worker fetch + scheduled handler.
- `src/web/NoteList.tsx` — `useQuery` reactive read.
- `wrangler.jsonc` — Cloudflare Worker manifest.
- `AGENTS.md` / `CLAUDE.md` — agent-facing guide (byte-identical).
