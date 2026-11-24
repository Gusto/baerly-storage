# @gusto/create-baerly-storage

Scaffolds an app on [`@gusto/baerly-storage`](https://www.npmjs.com/package/@gusto/baerly-storage), a document database that runs over any S3-compatible bucket (including Cloudflare R2).

```sh
pnpm create @gusto/baerly-storage my-app
# or
npm create @gusto/baerly-storage my-app
yarn create @gusto/baerly-storage my-app
```

Run it with no arguments in a terminal for an interactive wizard. Pass `.` as the name to scaffold into the current directory. Requires Node 26 or newer.

## Templates

Pick a deploy target and a starter:

| `--target`   | `--starter`         | Template                             |
| ------------ | ------------------- | ------------------------------------ |
| `cloudflare` | `minimal` (default) | Cloudflare Worker with an R2 binding |
| `cloudflare` | `react`             | Worker plus a React SPA              |
| `node`       | `minimal`           | Self-hosted Node server              |
| `node`       | `react`             | Node server plus a React SPA         |

If the target directory already contains a `wrangler.jsonc`, the CLI bolts baerly-storage onto that Worker project instead of scaffolding a template: it patches `wrangler.jsonc`, writes `baerly.config.ts` and `.dev.vars`, and prints a snippet for your worker entry.

## Options

- `--target=cloudflare|node`: deploy target.
- `--starter=minimal|react`: starter template.
- `--tenant=<name>`: default tenant (default `default`).
- `--domain=<host>`: custom domain for the deployed service.
- `--install`: run the package manager's install after writing files.
- `--pm=npm|pnpm|yarn`: override the detected package manager.
- `--git` / `--no-git`: initialise a git repo and make the first commit.
- `--with=docker`: add a Dockerfile (requires `--target=node`).
- `--force`: in bolt-on mode, overwrite an existing `baerly.config.ts`.
- `--no-agent-rules`: in bolt-on mode, skip the managed `AGENTS.md` block.
- `--json`: emit a JSON result on stdout (errors on stderr).

## Links

- Main package: [`@gusto/baerly-storage`](https://www.npmjs.com/package/@gusto/baerly-storage)
- Source, docs, and issues: [Gusto/baerly-storage](https://github.com/Gusto/baerly-storage)

Licensed under Apache-2.0.
