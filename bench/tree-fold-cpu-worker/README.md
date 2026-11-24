# Tree fold CPU bench (Workers Paid)

An owner-deployed Cloudflare Worker that measures the deployed CPU (`cpuTime`) of one tree fold tick (`foldTree` in `packages/server/src/tree/fold.ts`: capture the head and root, read the log, plan, publish) on Workers Paid, with the paired Node baseline over the same fixtures. Nothing here runs in `pnpm verify`; the harness tests run in `pnpm test`.

## What a cell is

One `POST /bench/fold?cell=<name>` request runs exactly one tick and nothing else, so the invocation's `cpuTime` is the tick's CPU. The tick runs under a fresh 9,000-call request ledger (Workers Paid's) with the writer's committed tail as `knownTail`, as the write tick would.

Cell names are `<fixture>-<cap>-<storage>` (48 cells; `pnpm bench:tree-fold-cpu:drive cells` lists them):

- **Fixtures** (`cells.ts`): the canonical tree at the production layout plus a 3,200-entry unfolded tail of scattered changes (delete, insert, shrink, grow; row count and bytes stay put). `d0b256` / `d1b256` / `d2b256` are 256 B documents at depth 0 (2,048 rows), 1 (4,096) and 2 (32,768 rows, 8 MiB); `d0k5` / `d1k5` / `d2k5` are 5 KiB documents at depth 0 (102 rows), 1 (204) and 2 (1,638 rows, 8 MiB).
- **Cap**: `100`, `500`, `1000` cut the log at that many entries, so the tick folds exactly that many and stops at the tail; `ledger` leaves the whole tail, so the 9,000-call budget ends the tick (the most one tick folds).
- **Storage**: `r2` folds over the R2 binding (the real tick: binding call overhead included). `memory` folds over an in-isolate MemoryStorage built from a copy that a prior `POST /bench/load` cached in the same isolate. It runs the identical code as the Node baseline, so `memory` medians give the workerd/Node factor for the fold itself.

After every `r2` tick the driver sends `POST /bench/reset` as its own request. The reset deletes every node outside the fixture's attempt and restores the saved fixture head, and the driver checks that exactly the fixture's nodes are left, so samples are independent. A `memory` tick never touches R2.

Each fold response, and its `TFBENCH` log line, reports the cell, tag, cold-isolate flag, `BENCH_EPOCH`, outcome, entries folded, stop reason, ledger charge (every attempt), nodes written, R2 binding calls by kind and the in-isolate wall time. Deployed clocks advance only across I/O, so that wall time is a cross-check only. CPU comes from `wrangler tail` (`cpuTime` per invocation).

## Local

```sh
pnpm bench:tree-fold-cpu:fixtures        # out/fixtures/<tenant>.json + out/manifest.json (sizes, SHA-256); ~60 MiB, deterministic
pnpm bench:tree-fold-cpu:build           # dist/worker.js from the current tree
pnpm bench:tree-fold-cpu:node-baseline   # out/node-baseline.json; --samples=5 --warmup=1 [cell...]
```

The baseline records the load average before and after. CPU on a loaded machine is inflated, so read a loaded baseline as an upper bound. `out/` and `dist/` are gitignored.

A local smoke run uses `wrangler dev --local --config bench/tree-fold-cpu-worker/wrangler.jsonc --var BENCH_SECRET:<secret>` and the same driver with `BENCH_URL=http://localhost:<port>`. It shows no `cpuTime`.

## Owner: deploy, run, collect, tear down

Synthetic data only. The Worker is on `workers.dev` with no routes and no `account_id` (wrangler uses the account the token names). Every route needs the bench secret. The one binding is a throwaway R2 bucket.

Set up from a scratch directory outside the checkout. The token file is `credentials/cloudflare-deploy.json` (`{ "api_token", "account_id" }`); never print it.

```sh
WT=<this worktree>; S=<scratch dir>; cd $S
C=$WT/credentials/cloudflare-deploy.json
export CLOUDFLARE_API_TOKEN="$(jq -r .api_token $C)" CLOUDFLARE_ACCOUNT_ID="$(jq -r .account_id $C)" NODE_OPTIONS=--use-system-ca
W="node $(ls -d $WT/node_modules/.pnpm/wrangler@*/node_modules/wrangler/bin/wrangler.js | head -1)"
CFG="--config $WT/bench/tree-fold-cpu-worker/wrangler.jsonc"
(cd $WT && pnpm -s bench:tree-fold-cpu:fixtures && pnpm -s bench:tree-fold-cpu:build)
umask 077; openssl rand -hex 32 > bench-secret.txt
```

Deploy. `limits.cpu_ms: 300000` is accepted only on Paid, so a successful deploy confirms the plan.

```sh
$W r2 bucket create baerly-tree-fold-cpu-synthetic
$W deploy $CFG
$W secret put BENCH_SECRET $CFG < bench-secret.txt
```

Capture the tail in the background for the whole run:

```sh
$W tail baerly-tree-fold-cpu-bench --format json > $S/tail.json &
```

Upload, then run every cell (default 1 warmup + 5 measured samples per cell):

```sh
cd $WT/bench/tree-fold-cpu-worker
export BENCH_URL=https://baerly-tree-fold-cpu-bench.<subdomain>.workers.dev BENCH_SECRET_FILE=$S/bench-secret.txt OUT=$S/drive.jsonl
node drive.ts upload                 # ~60 MiB in ~4 MB batches; checks object counts and resets each tenant
node drive.ts run                    # or a subset: node drive.ts run --samples=5 d1k5 d1b256-ledger
```

The harness measures prepared folds, not controlled cold-start CPU. The driver resets R2 fixtures or loads memory fixtures before folding, so redeploying with `--warmup=0` does not create a cold arm. The `cold` flag marks the first request of any kind in each isolate; the analyzer drops any fold carrying that flag from the warm medians and counts it.

Collect. Stop the tail about 10 s after the run ends. Tail events carry request headers, the bench secret among them, so keep only the normalized file:

```sh
node analyze.ts normalize $S/tail.json > $S/events.jsonl && rm $S/tail.json
node analyze.ts report $S/drive.jsonl $S/events.jsonl --node=out/node-baseline.json
```

The report gives, per cell: n, median `cpuTime` with its range, entries folded, ledger charge, nodes written, client wall time, CPU per entry, the paired Node median and the workerd/Node factor. It then fits `cpu = a + b * entries` per fixture and storage.

Tear down. Run `wipe` until it prints `done`, delete the Worker and the bucket, then confirm both are gone:

```sh
node drive.ts wipe
$W delete baerly-tree-fold-cpu-bench $CFG
$W r2 bucket delete baerly-tree-fold-cpu-synthetic
curl -s -o /dev/null -w '%{http_code}\n' $BENCH_URL/bench/fold   # expect 404
$W r2 bucket list | grep baerly-tree-fold-cpu || echo bucket gone
```

`wrangler delete` may fail on a missing KV permission after it has already deleted the script. Check for the 404, not the exit code.
