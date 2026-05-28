// scripts/dlx-bust-cache.mjs — wipes pnpm's dlx cache (XDG on Linux,
// ~/Library/Caches on macOS) AND localhost+4873 registry metadata.
// Use when iterating create-baerly-storage via
// `pnpm dlx @gusto/create-baerly-storage` against Verdaccio — dlx caches
// by pkg@version, so re-publishing the same version is invisible without
// this step.
//
// Note: `pnpm config get cache-dir` prints the literal string "undefined"
// — don't try to derive the path from it.
import { spawnSync } from "node:child_process";

const cmd = `find "$HOME/.cache/pnpm" "$HOME/Library/Caches/pnpm" \\( -name dlx -o -name "localhost+4873" \\) -prune -exec rm -rf {} + 2>/dev/null || true`;
spawnSync("sh", ["-c", cmd], { stdio: "inherit" });
