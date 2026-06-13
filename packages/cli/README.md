# `@baerly/cli`

Workspace-internal source for the `baerly` CLI. The published
`@gusto/baerly-storage` package ships the bundled bin as
`dist/baerly.js`; this workspace package itself stays private.

Subcommands are built on [citty](https://github.com/unjs/citty).
`baerly --help` and `baerly <cmd> --help` are generated from the
registered command definitions.

## Subcommands

| Command | Role |
|---|---|
| `baerly deploy` | Dispatch by `baerly.config.ts:target`; today only Cloudflare deploy is implemented. |
| `baerly doctor` | Cloudflare deploy invariant checks, or `--bucket <uri>` CAS probe for any backend. |
| `baerly inspect` | Read-only summary of one collection's snapshot / log / index state. |
| `baerly export` | SQL export for one collection (`--target=sqlite` / `--target=postgres` / `--target=d1`). |
| `baerly cost` | Class A / Class B operation accounting for one collection. |
| `baerly admin rebuild-index` | Reconcile one declared index. |
| `baerly admin dump` | Canonical NDJSON dump of one collection's materialized view. |
| `baerly admin restore` | Import `admin dump` NDJSON into a fresh or `--force`-truncated collection. |
| `baerly admin fsck` | Read-only consistency walk; exits 4 on findings. |
| `baerly admin usage` | Node-target all-collection writes/min health check. Cloudflare usage scanning is not wired yet. |

Scaffolding and bolt-on live in `@gusto/create-baerly-storage`, not in
this CLI. See
[`packages/create-baerly-storage/AGENTS.md`](../create-baerly-storage/AGENTS.md).

Each subcommand is one lazy-loaded module registered in
`src/baerly.ts`. Keep new verbs behind dynamic `import()` so the help
path stays small.

## Exit codes

| Code | Meaning | Maps from |
|---|---|---|
| `0` | success | handler returned normally |
| `1` | user/config error | `BaerlyError.code = InvalidConfig`, missing/unknown flag |
| `2` | storage or external process error | `BaerlyError.code = NetworkError` / `AccessDenied`, anything non-`BaerlyError` |
| `3` | protocol invariant / conflict class | `BaerlyError.code = Conflict` / `Internal` / `InvalidResponse` |
| `4` | `admin fsck` findings | `fsck` walk surfaced ≥1 finding |

## `--json` mode

Every subcommand accepts `--json`. When set:

- Success writes one JSON envelope to stdout: `{"result":{...}}` (each
  subcommand decides the inner shape).
- Failure writes one JSON envelope to stderr:
  `{"error":{"code":"<BaerlyError.code>","message":"<msg>","command":"<cmd>"}}`.
- Color is suppressed regardless of TTY (so the envelope stays
  machine-parseable).

Text mode stays quiet on success unless the command's primary output is
stdout data, such as `admin dump`.

## Environment

Any `s3://` bucket URI requires:

| Var | Notes |
|---|---|
| `BAERLY_S3_ENDPOINT` | required, e.g. `https://s3.us-east-1.amazonaws.com` |
| `BAERLY_S3_ACCESS_KEY_ID` | required |
| `BAERLY_S3_SECRET_ACCESS_KEY` | required |
| `BAERLY_S3_REGION` | optional, defaults to `us-east-1` |
| `NO_COLOR` | optional, disables ANSI in human output |

## URI grammar

- `s3://<bucket>[/<prefix>]` — S3-compatible HTTP via the Node adapter
  storage factories.
- `file:///<absolute-path>` — `LocalFsStorage` rooted at the path.
- `memory://<bucket>` — `MemoryStorage` keyed by bucket; test-only.
