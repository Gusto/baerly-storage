# Local read/fold CPU screen

`pnpm bench:fold-cpu` measures complete main-tree `collection.get()`, `collection.all()` and `compact()` calls over deterministic MemoryStorage fixtures. It changes no production code, layout, ceiling or policy.

```sh
pnpm bench:fold-cpu
pnpm bench:fold-cpu --byte-targets=65536,524288 --rows=256,2048 --tails=0,16 --repetitions=3 --warmups=1
pnpm bench:fold-cpu --cpu-budget-ms=10 --latency-budget-ms=100
pnpm bench:fold-cpu --operations=fold --arms=warmed --tails=16 --byte-targets=4194304,33554432 --rows=4096 --repetitions=5 --profile-dir=bench/results/fold-cpu/profiles-example
```

The default byte ladder targets 64 KiB, 256 KiB, 512 KiB and 1 MiB using 2 KiB documents; the row ladder uses 256, 1024, 2048 and 8192 small documents. Targets approximate the encoded snapshot size: every sample records actual bytes. Tails contain 0, 1 or 16 uniformly selected full-post-image updates to existing rows; empty-tail controls run reads only. Use comma-separated `--byte-targets`, `--rows` and `--tails` for larger screens. Index count is zero. The seeded notes shape uses scalar fields, repeated ASCII padding and sequential fixed-width IDs; timings do not represent heterogeneous application documents.

## Tail shapes and indexed reads

Extra dimensions, all additive (defaults reproduce the earlier uniform-update, index-count-0 screen):

- `--tail-shapes=update,append,delete,shrink` (default `update`): `update` is uniformly selected full-post-image `U` entries; `append` is `I` entries for new sequential ids (row count grows by the tail); `delete` is `D` entries for distinct, evenly strided ids, never `doc-00000000` (rows shrink by the tail; the tail must be shorter than the row count); `shrink` is `U` entries with `pad` cut to a quarter of its length; the rows axis (64 B documents, no pad) is skipped for shrink with a warning and a limitation. Each cell records the actual tail post-image bytes (`tail_post_image_bytes` min/max). A tail of 0 has shape `none` and runs once per size.
- `--index-count=0..4` (default 0): declares that many indexes (`title`, `n`, `done`, `pad`) through `Db.create({ config })` for every operation in the run. Declared indexes are validated but read and write no storage on this tree, so this records the declared count; it is not an index lookup.
- `--operations=...,indexed`: a `where({ title })` read returning exactly one row, next to point `get` and scan `all`. Requires `--index-count>=1`.

Each measured cell carries `tail_shape`, `index_count` and `admitted_mutations` (every tail entry is replayed by reads and folded by the one unsliced `compact()`, so fold CPU is total tail drain CPU). The workload block states document size distribution, ID distribution, index count, tail shapes, admitted mutations and the cold/warm label (`runtime_arm`: runtime warmth only, never a cold isolate). Records written before these fields existed still validate.

Quiet-run commands (quiet host, stable checkout, no other jobs):

```sh
pnpm bench:fold-cpu --byte-targets=524288,4194304,16777216,33554432 --rows=4096,32768 --tails=0,16 --tail-shapes=update,append,delete,shrink --operations=get,all,fold --arms=unprimed,warmed --repetitions=11 --warmups=3 --out=bench/results/fold-cpu/tail-shapes.json
pnpm bench:fold-cpu --byte-targets=524288,4194304,16777216,33554432 --rows=4096,32768 --tails=0,16 --tail-shapes=update --index-count=2 --operations=get,all,indexed --arms=unprimed,warmed --repetitions=11 --warmups=3 --out=bench/results/fold-cpu/indexed-reads.json
```

Existing baseline commands are unchanged:

```sh
pnpm bench:fold-cpu --byte-targets=524288,4194304,16777216,33554432 --rows=4096,32768 --tails=0,16 --repetitions=11 --warmups=3 --out=bench/results/fold-cpu/quiet-baseline.json
pnpm bench:fold-cpu --byte-targets=524288,4194304,16777216,33554432 --rows=4096,32768 --tails=16 --operations=get,all,fold --arms=warmed --repetitions=11 --warmups=3 --profile-dir=bench/results/fold-cpu/quiet-profiles --out=bench/results/fold-cpu/quiet-profile-run.json
```

Each sample receives a fresh fixture outside the measured interval. The `unprimed` arm has no explicit warmup; `warmed` runs three same-operation warmups on separate fixtures before its eleven default samples. These are runtime-warmth arms in one process. Earlier cells and fixture encoding already warm the runtime. Neither arm is a fresh isolate or an OS/data-cache experiment; production queries reload and hash-verify snapshots on every invocation.

Output is a versioned JSON record under ignored `bench/results/fold-cpu/` (or `--out=PATH`). It includes source SHA, the full measurement patch from HEAD (including staged, unstaged and untracked files), patch hash, CPU models, core count, runtime, host memory/heap limits, start/end load, workload and all raw samples/failures. A source change during the run rejects the result. Use a stable checkout; do not edit it while measuring. Ignored files are excluded from provenance, so keep all executable measurement inputs tracked or untracked and unignored. No environment-variable values are captured.

Requires Node 24.2+ for calling-thread CPU measurements. Invocation failures are saved; setup failures abort before a result is written.

Samples retain calling-thread CPU, process CPU, elapsed latency, absolute heap endpoints and sampled peak, RSS endpoints, attempted GET/PUT/DELETE/LIST counts, yielded list entries, returned GET body bytes and submitted PUT body bytes. The whole fold includes snapshot parsing, tail replay, sorting/copying, encoding, hashing, snapshot publication and manifest CAS. Counts exclude fixture construction and warmups. MemoryStorage avoids network wait and retains body references. Calling-thread CPU excludes off-thread crypto/runtime work; process CPU is a complementary diagnostic. Heap sampling uses a 1 ms interval plus endpoints; it can miss synchronous peaks and GC can reduce endpoint deltas. These observations do not establish Worker isolate memory or deployed CPU.

The console reports observed maxima per cell and the JSON retains raw samples. Optional CPU/latency budgets produce arithmetic headroom (budget minus observed maximum), globally in JSON and per cell in the console. CPU headroom subtracts calling-thread CPU, which omits off-thread hashing and GC helper work, so it is the optimistic side of a Node-to-Worker comparison; compare budgets against the retained process CPU samples too. The harness chooses no budget or acceptance rule. Eleven samples cannot establish a reliable p99, sustained-load capacity or kill rate. No alternate layout or append-splice oracle is included.

Select operations with `--operations=get,all,fold` and runtime arms with `--arms=unprimed,warmed`. Adding `--profile-dir=bench/results/...` runs the same probe with Node inspector CPU profiling. The directory must be new and under ignored `bench/results/`. Use a separate invocation without `--profile-dir` for baseline timings: profile-mode samples include inspector stop overhead and are explicitly marked `profile-instrumented` in the v2 result schema.

The inspector starts after each fixture is built and stops when that invocation settles, including failures. Fixture construction, provenance capture, warmups and profile serialization/writing are excluded. Inspector boundary frames and heap-sampler callbacks can still appear. The run writes one `.cpuprofile` per measured invocation plus `manifest.json`, linked from the result. The manifest binds the result and raw profiles by SHA-256 and records source SHA/patch hash, operation, cell, actual snapshot bytes, runtime arm and zero-based repetition. The result retains full source/workload/environment identity.

Manifest summaries retain sample count, sampled duration, profile duration and sample-weighted self/inclusive microseconds by function/file/line/column. Self weights partition sampled time; inclusive weights overlap between callers and callees and count recursive frames once per sampled stack. Inspector frames are retained for auditing: exclude their self weights from operation hotspot claims, reporting the overhead share alongside other/unclassified samples. At 1 ms sampling, a profile with fewer than 100 samples is a qualitative hint; even larger profiles provide hotspot attribution rather than exact phase times. Aggregate matched repeated invocations and inspect raw stacks before attributing parse, hash, copy or encode work. Off-thread crypto/GC work remains outside the profile. Uniform-update fixtures cannot establish an append-splice benefit; that requires a separate append workload and full-path byte-equality oracle.

The host-load heuristic flags either endpoint when any 1/5/15-minute load average reaches 0.5 per logical core or free host memory falls below 10%. Loaded runs print a warning and persist `exploratory-loaded`; other runs persist `quiet-local-screen`, which does not prove absence of contention. Use a quiet machine for acceptance. Final platform envelopes require separately authorized deployed measurements and owner-agreed margins, confidence and sustained load.

Probe/schema tests: `pnpm build:agent` then `pnpm test:agent bench/measurement/fold-cpu.test.ts`.
