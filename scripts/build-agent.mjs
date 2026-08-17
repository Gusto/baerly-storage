#!/usr/bin/env node
// Agent-facing variant of `pnpm build` (mirrors `verify:agent` / `test:agent`).
// Runs the exact same build; the rolldown per-asset/chunk size table (~150
// lines, no CLI suppress flag — see scripts/prepare.mjs) is captured and only
// replayed on failure. Bare `pnpm build` is left untouched: a human running
// it directly may want to see the size table, unlike here where the point is
// just to populate dist/ before pnpm test:agent.
import { spawnQuiet } from "./lib/quiet-spawn.mjs";

spawnQuiet("pnpm", ["run", "build"]);
