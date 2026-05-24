# react-cloudflare

A baerly app scaffolded with `create-baerly` for the **Cloudflare
Workers** target, with a React + Vite SPA. Single-bucket R2-backed
deployment via `baerly-storage/cloudflare`. Ships a `sharedSecret`
verifier out of the box and a one-collection `notes` schema you
extend.

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
├── baerly.config.ts          # app, tenant, target, NoteSchema
├── types.ts                  # `Note` type inferred from the Zod schema
├── AGENTS.md                 # deeper guide: hooks, schema, auth, deploy
├── CLAUDE.md                 # same content (Claude Code reads this)
├── src/
│   ├── server/
│   │   └── index.ts          # baerlyWorker((env) => ({ verifier }))
│   └── web/
│       ├── main.tsx          # React entry
│       ├── App.tsx           # Provider + new-note form (useInsert)
│       ├── client.ts         # BaerlyClient bound to this config
│       └── NoteList.tsx      # useLiveQuery + per-row useUpdate / useDelete
└── README.md
```

## Run locally

```sh
pnpm install
cp .dev.vars.example .dev.vars   # ships SHARED_SECRET=dev-shared-secret
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
wrangler secret put SHARED_SECRET     # only if you stay on the sharedSecret verifier

baerly deploy                         # reads baerly.config.ts:target, runs wrangler deploy
baerly doctor --target=cloudflare     # verify bindings, secrets, cron
```

## Extend the schema

Edit `baerly.config.ts`. The `Note` row type in `types.ts` is
inferred from `NoteSchema` — adding a field there propagates to
the UI through `import type { Note }`.

```typescript
export const NoteSchema = z.object({
  _id: z.string(),
  body: z.string().min(1),
  // Add fields here:
  tags: z.array(z.string()).optional(),
});
```

## Production auth

The emitted `src/server/index.ts` uses `sharedSecret()` for parity
with `wrangler dev`. For production behind Cloudflare Access, swap
to `cloudflareAccess()` (re-exported from `baerly-storage/auth`)
and wire Access in front of the Worker route. The preset reads the
JWT off `Cf-Access-Jwt-Assertion`, validates it against your team's
JWKS, and derives `tenantPrefix` from the email claim. See
`AGENTS.md` → "Production auth" for the swap.

## When to graduate

baerly is sized for the small-to-medium operating point. Past
~30 writes/min/collection, ~10 GB/tenant, or ~100 collections/
tenant, graduate to D1 or Postgres via `baerly export
--target=postgres`. Your data was already in your bucket; the
export is a mechanical translator, not a vendor migration.

## Pointers

- `baerly.config.ts` — app config + Zod schema.
- `src/server/index.ts` — Worker fetch + scheduled handler.
- `src/web/NoteList.tsx` — `useLiveQuery` live-updates hook.
- `wrangler.jsonc` — Cloudflare Worker manifest.
- `AGENTS.md` / `CLAUDE.md` — agent-facing guide (byte-identical).
