# bench/load-harness

Reproducible synthetic workload library for the baerly-storage load bench.
Ticket 53's runner consumes these generators; ticket 54's CLI surfaces them
as `--preset=` flags.

## What's here

```
bench/load-harness/
├── generators/
│   ├── rng.ts          # mulberry32 PRNG + Rng wrapper (next/int/pick/weighted/zipfIndex/powerLaw)
│   ├── calibration.ts  # loadCalibration() — reads calibration.json, falls back to {}
│   ├── dataset.ts      # buildDataset(params) → Dataset (tenants, records, bytes)
│   └── ops.ts          # generateOpStream(params) → Op[] (deterministic)
├── presets.ts          # Preset interface + registry (registerPreset/getPreset/listPresets)
├── presets/
│   ├── recent-first-crud.ts  # notes-app shape preset
│   └── calibration.json      # default distribution parameters (overwritten by ticket 52)
└── tests/
    ├── rng.test.ts     # 4 determinism / bounds cases
    ├── dataset.test.ts # 3 determinism / distribution cases
    └── ops.test.ts     # 3 determinism / mix cases
```

**Everything is deterministic.** Given the same `seed`, `buildDataset` and
`generateOpStream` produce byte-identical output across machines and runs.
`Math.random()` is never called inside `bench/load-harness/`.

## How to add a preset

1. Create `bench/load-harness/presets/<name>.ts`.
2. Import `registerPreset` from `../presets.ts` and call it at module load
   time with a `Preset` object (see `recent-first-crud.ts` for the shape).
3. Append `import "./presets/<name>.ts";` to the bottom of `presets.ts`.
4. Add a `"<name>"` entry to `presets/calibration.json` with the four
   distribution buckets (`tenantSize`, `tenantTraffic`, `recordPopularity`,
   `recordSize`). If the entry is absent, `buildDataset` falls back to the
   inline defaults in `generators/dataset.ts`.

Preset names must be unique across the registry. `registerPreset` throws on
duplicate registration.

## How to override calibration

`bench/load-harness/presets/calibration.json` holds the default distribution
parameters. Ticket 52 overwrites this file with parameters extracted from real
corpora (MovieLens 100K + GH Archive WatchEvent slices). To supply custom
parameters without editing `calibration.json`, pass `tenantSizeBuckets`,
`tenantTrafficBuckets`, `recordPopularityBuckets`, or `recordSizeBuckets`
directly to `buildDataset`:

```ts
import { buildDataset } from "./bench/load-harness/generators/dataset.ts";

const ds = buildDataset({
  seed: 1,
  tenantCount: 100,
  schema: { collection: "notes" },
  tenantSizeBuckets: [
    { cumulativeFraction: 1.0, maxRecords: 50 },
  ],
});
```

Per-call overrides take precedence over `calibration.json`; `calibration.json`
takes precedence over the inline defaults in `dataset.ts`.

## How the runner uses this

Ticket 53's runner follows this sequence for each preset:

1. `loadCalibration()` — reads `presets/calibration.json` once at startup.
2. `buildDataset({ seed, ...preset.datasetParams, calibration })` — builds
   the in-memory tenant/record tree.
3. Walk `preset.pipeline` in order:
   - **seed phase:** PUT every record once via `Writer`.
   - **other phases:** `generateOpStream({ seed, dataset, mix, opCount })`
     then dispatch each `Op` to the appropriate `Db` / `Writer` call.
   - Take a `CountingStorage` snapshot before and after each phase.
4. Emit the per-phase snapshot deltas as the run-JSON (ticket 54).

The `seed` fed to `buildDataset` and `generateOpStream` should be the same
value (typically passed via `--seed=` on the CLI) so that the full run is
reproducible from a single integer.
