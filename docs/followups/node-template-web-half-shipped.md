# Node templates: the SPA half is shipped but not wired

**Severity: MEDIUM. The Node templates ship `src/web/`,
`index.html`, `vite.config.ts`, and a `tsconfig.app.json`, but
`pnpm dev` never boots a Vite server — so a scaffolded user runs
`pnpm dev`, opens the URL, and never sees any of it. Decide:
half-finished SPA out, or finish wiring it.**

This couples three findings that all describe the same defect from
different angles.

## The defect

`examples/minimal-node/package.json:dev` runs `baerly dev`, which
boots the Node HTTP listener over `LocalFsStorage` on `:3000`.
Nothing in that flow runs Vite. But the template *does* ship:

- `src/web/main.ts` — 4-line placeholder
  (`document.querySelector("#app")!.innerHTML = '<h1>...</h1>'`)
- `index.html`
- `vite.config.ts` with a proxy:
  `proxy: { "/v1": "http://127.0.0.1:8080" }`
- `tsconfig.app.json` configured for DOM / web

Three concrete signals that the SPA half is half-wired:

### 1. `src/web/main.ts` is dead in the `baerly dev` flow

`pnpm dev` → `baerly dev` → Node listener on `:3000`. No Vite
server runs, so the SPA never loads. Users who follow the README
`pnpm dev` never see `src/web/`. Only `pnpm build && pnpm start`
exercises the SPA path.

### 2. `vite.config.ts` proxies the wrong port

`examples/minimal-node/vite.config.ts:11`:

```ts
proxy: { "/v1": "http://127.0.0.1:8080" }
```

But `baerly dev` and the example's `AGENTS.md` both document
`:3000`. So even if a user *does* spawn vite themselves, the proxy
points at the wrong port.

### 3. `tsconfig.app.json` mixes web + tool config

`examples/minimal-node/tsconfig.app.json:15`:

```json
"include": ["src/web/**/*", "uint8array-base64.d.ts", "vite.config.ts"]
```

This project targets DOM (browser globals, no Node types) but
includes `vite.config.ts` — a Node-side tooling file. Either
typecheck `vite.config.ts` as a Node file (move to
`tsconfig.server.json` or carve out a dedicated `tsconfig.node.json`)
or stop including it from the web project.

## Three possible fixes (pick one — they're mutually exclusive)

### Option A — Ship Node templates server-only

Delete `src/web/`, `index.html`, `vite.config.ts`, and
`tsconfig.app.json` from `examples/minimal-node` (and the
not-currently-shipped Node helpdesk if it lands). Drop `vite` and
`@types/react` (if present) from `devDependencies`. Document that
Node templates are server-only — the SPA story is for the CF
templates today.

**Smallest diff. Honest framing.** The Node side has no
"vite + server in one process" story yet (CF gets that via
`@cloudflare/vite-plugin`).

### Option B — Add `pnpm dev:web` that runs vite standalone

Keep the SPA scaffolding. Add a second script and document a
two-terminal workflow:

```json
"scripts": {
  "dev": "baerly dev",
  "dev:web": "vite"
}
```

Fix the proxy port to match `baerly dev`'s default (`:3000`).
Update README to show the two-terminal flow. **Most honest about
current state.**

### Option C — Have `baerly dev --web` spawn vite as a child

Per legacy item 1 in `next-batch.md`. Single `pnpm dev` boots both
the API and Vite, threads the Vite URL into `printDevBanner`. **Best
DX, biggest implementation.** Defer until the SPA story for Node is
a priority.

## Recommendation

Ship Option A first (delete the half-shipped SPA), then come back to
Option C when the Node SPA story is intentional. Today the codebase
is paying tax for a feature the user can't reach.

## Cross-references

- Legacy item 1 in `next-batch.md` ("Node `baerly dev` boots the
  API but not the SPA in dev") is the Option C vision.
- `examples-tsconfig-strictness.md` will need to re-touch the same
  tsconfigs — coordinate if both land near each other.
