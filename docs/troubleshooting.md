# Troubleshooting

Operational and "I-just-checked-out-the-repo" knowledge that doesn't fit
in code or `CLAUDE.md`. If you hit something not in here, consider
adding it.

## Known baseline test failures

`pnpm test` is **not** clean on a fresh checkout. Six test files require
infrastructure that may be absent. New failures in *other* files are the
signal worth investigating; failures in the ones below are environmental
or expected.

### Need cloud credentials in `credentials/{aws,gcs,cloudflare}.json` (gitignored)

- `tests/integration/conformance.test.ts` — multi-backend conformance suite.

Drop credential JSON files into `credentials/` to enable. The directory
is gitignored.

### Need Minio running locally

Bring up the local stack with `pnpm dev:storage`. These tests will then
pass:

- `tests/integration/randomized.test.ts` — property-based fuzzer.
- `tests/integration/offline-first.test.ts` — offline-write replay.
- `tests/integration/time.test.ts` — clock-skew tolerance.

### Stale-API mismatch (known, not your bug)

- `src/operation-queue.test.ts` — assertions expect a scalar
  where `flatten()` now returns a `[value, seq]` tuple. Until someone
  rewrites the tests, ignore the failure. *Do not* "fix" it by reverting
  `flatten`.

### Always green (use as a sanity baseline)

Pure-unit tests with no infrastructure:

- `hashing.test.ts`, `consistency.test.ts`, `xml.test.ts`, `json.test.ts`,
  `datatypes.test.ts`.

If these fail in your work-in-progress, *that* is a regression.

## Local stack ports

`pnpm dev:storage` brings up two services via `docker-compose.yml`:

| Service | Port | Purpose |
|---|---|---|
| Minio API | `:9102` | Stable S3-compatible endpoint. Most tests target this. |
| Minio console | `:9103` | Web UI at <http://127.0.0.1:9103> (login `mps3` / see compose file). |
| Toxiproxy | `:9104` | Proxies `:9102` with chaos injection. Used by `randomized.test.ts` and `offline-first.test.ts` to simulate network failure. |
| Toxiproxy admin | `:8474` | For configuring toxics manually. |

The split matters: tests that want a *reliable* S3 use `:9102`; tests
that want to exercise retry/replay paths point one MPS3 instance at
`:9104` and another at `:9102` so they share a backend but disagree
about reachability. See `randomized.test.ts`'s `unstableConfig`.

Toxiproxy's default config (in compose) creates a single `minio` proxy
with no toxics — tests add toxics at runtime via the admin port.

## Offline storage behavior (`MPS3Config.offlineStorage`)

`MPS3Config.offlineStorage` (boolean, default `true`) toggles whether
the operation queue persists to IndexedDB.

- **`true`** — pending writes are persisted via `idb-keyval`. After a
  reload, `Manifest.load()` restores them and resumes the upload via
  `_putAll` or `updateContent`. This is the offline-first behavior
  described in the docs. Requires IndexedDB to be available (or
  mocked).
- **`false`** — pending writes live only in `OperationQueue`'s
  in-memory map. A reload loses them. Used by integration tests that
  don't want IDB state to leak between runs (`conformance.test.ts`,
  `randomized.test.ts`, `time.test.ts`).

In tests, `import "fake-indexeddb/auto"` at the top of the file gives
you a real IDB API backed by an in-memory store — required whenever
`offlineStorage` is `true` (i.e. the default).

Implementation: see [`src/mps3.ts`](../src/mps3.ts) (config resolution),
[`src/operation-queue.ts`](../src/operation-queue.ts), and
[`src/indexdb.ts`](../src/indexdb.ts).

## What `pnpm test:randomize` actually does

`"test:randomize": "while pnpm test; [ $? -ne 1 ] ; do :; done"`

It loops `pnpm test` until a run exits non-zero — i.e. it's a *fuzzer*
that catches races and protocol violations missed by a single run of
`randomized.test.ts`. Run it for several minutes when:

- You touched `src/syncer.ts`, `src/manifest.ts`, or
  `src/operation-queue.ts`.
- You changed timing constants in `src/constants.ts`
  (`LAG_WINDOW_MILLIS`, `MANIFEST_LIST_LOOKAHEAD_MILLIS`, etc.).
- You're investigating a flaky test that reproduces "sometimes".

It is **not** a stress test (load) or a perf test (latency). It's a
property-based fuzzer realized as a shell loop.

## "Why is `pnpm format:check` red?"

It's red on `main`. ~20 pre-existing files don't match `oxfmt`'s
defaults; reformatting them all in one PR would touch unrelated diffs.
Use `pnpm format` to format only files you've touched, or diff your
output against `main` to see whether *your* edits added new violations.
The pre-commit hook does *not* run `format:check` for the same reason.

## "Pre-commit hook didn't fire"

`lefthook install` ran during your last `pnpm install`'s `prepare`
step. If you cloned with `--depth 1` or skipped install, run
`pnpm install` again. Verify with `cat .git/hooks/pre-commit` — it
should be a lefthook stub.

Bypass with `git commit --no-verify` for genuinely one-off cases (e.g.
WIP commits on a private branch). Don't bypass on merge commits or PR
branches.
