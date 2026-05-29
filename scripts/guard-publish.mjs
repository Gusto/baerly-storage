#!/usr/bin/env node
// `prepublishOnly` guard. Blocks a bare `npm publish` / `pnpm publish`
// so neither @gusto package can reach the registry outside
// `scripts/publish.mjs` (`pnpm release`), which is the only path that
// forces `--access restricted` + a post-publish privacy verification.
//
// Why this exists: @gusto/baerly-storage leaked PUBLIC twice. Root
// cause is a two-part trap — `publishConfig.access: "restricted"` is
// silently NOT forwarded to the registry by `pnpm publish`, and the
// `@gusto` org's default package visibility is PUBLIC, so a bare
// publish lands world-readable. The safe path sets the flag
// explicitly AND re-asserts private via `npm access set`.
//
// `scripts/publish.mjs` sets BAERLY_SAFE_PUBLISH=1 in the publish
// child env; that's the only way through this gate.

if (process.env.BAERLY_SAFE_PUBLISH !== "1") {
  process.stderr.write(
    "\n✗ Direct `npm publish` / `pnpm publish` is blocked for this package.\n\n" +
      "  These packages MUST publish private. A bare publish can leak them\n" +
      "  public: pnpm drops publishConfig.access, and the @gusto org default\n" +
      "  visibility is public.\n\n" +
      "  Use:  pnpm release            (runs scripts/publish.mjs)\n" +
      "        pnpm release --dry-run  (pack + report visibility, no writes)\n\n" +
      "  It publishes with `--access restricted`, forces\n" +
      "  `npm access set status=private`, then verifies and fails loud if\n" +
      "  either package is not private.\n\n" +
      "  (Emergency bypass, only if you know why: BAERLY_SAFE_PUBLISH=1.)\n",
  );
  process.exit(1);
}
