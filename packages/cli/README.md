# `@baerly/cli`

The `baerly` CLI — vendorless document-database operations over any
S3-compatible bucket. Bundled to a single `dist/baerly.js` with a
`#!/usr/bin/env node` shebang via rolldown; published nowhere yet
(`"private": true` in `package.json`).

Subcommands are built on [citty](https://github.com/unjs/citty);
`baerly --help` and `baerly <cmd> --help` are auto-generated.

## Subcommands

| Command   | Status      | Module        |
| --------- | ----------- | ------------- |
| `copy`    | implemented | `src/copy.ts` |
| `inspect` | planned     | —             |
| `compact` | planned     | —             |
| `fsck`    | planned     | —             |
| `export`  | planned     | —             |
| `dump`    | planned     | —             |
| `restore` | planned     | —             |

Bolt-on (adding baerly to an existing Cloudflare Worker project) lives
in `create-baerly-storage` — see
[`packages/create-baerly-storage/AGENTS.md`](../create-baerly-storage/AGENTS.md)
§"Bolt-on branch".

Each subcommand is one `defineCommand` block exported from its own
module and registered in `src/baerly.ts`. Adding one: copy the shape
of `src/copy.ts`, register it in `subCommands` in `src/baerly.ts`.

## Exit codes

| Code | Meaning            | Maps from                                                                      |
| ---- | ------------------ | ------------------------------------------------------------------------------ |
| `0`  | success            | handler returned normally                                                      |
| `1`  | user error         | `BaerlyError.code = InvalidConfig`, missing/unknown flag                       |
| `2`  | storage error      | `BaerlyError.code = NetworkError` / `AccessDenied`, anything non-`BaerlyError` |
| `3`  | protocol invariant | `BaerlyError.code = Conflict` / `Internal` / `InvalidResponse`                 |

## `--json` mode

Every subcommand accepts `--json`. When set:

- **Success** — one line on stdout: `{"result":{...}}` (each
  subcommand decides the inner shape).
- **Failure** — one line on stderr:
  `{"error":{"code":"<BaerlyError.code>","message":"<msg>","command":"<cmd>"}}`.
- **Color** is suppressed regardless of TTY (so the envelope stays
  machine-parseable).

Text mode (the default) keeps the existing
`baerly <cmd>: <code>: <msg>\n` shape on stderr; stdout stays silent
on success.

## Environment

Any `s3://` bucket URI requires:

| Var                           | Notes                                               |
| ----------------------------- | --------------------------------------------------- |
| `BAERLY_S3_ENDPOINT`          | required, e.g. `https://s3.us-east-1.amazonaws.com` |
| `BAERLY_S3_ACCESS_KEY_ID`     | required                                            |
| `BAERLY_S3_SECRET_ACCESS_KEY` | required                                            |
| `BAERLY_S3_REGION`            | optional, defaults to `us-east-1`                   |
| `NO_COLOR`                    | optional, disables ANSI in human help               |

## URI grammar

- `s3://<bucket>[/<prefix>]` — S3-compatible HTTP via the
  `s3Storage` / `r2Storage` / `minioStorage` factories from
  `@baerly/adapter-node` (endpoint-pattern dispatched).
- `file:///<absolute-path>` — `LocalFsStorage` rooted at the path.
- `memory://<bucket>` — `MemoryStorage` keyed by bucket; test-only.
