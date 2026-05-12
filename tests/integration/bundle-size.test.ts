import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

// ADR-0001 motivates the vendorless choice on bundle weight; this test
// pins the size so a regression shows up immediately.
//
// Ticket 31 swung the root publish entry from the (defunct) legacy
// kernel to `packages/server/src/index.ts`, replacing the ~62 KiB
// client-only kernel with the full Baerly surface (Db + Table + Query
// + ServerWriter + compactor + gc + maintenance + Hono-backed HTTP
// router). Bundle settles at ~160 KiB; budget set ~7% above with no
// adapter packages pulled in — adapter code (`S3HttpStorage`,
// `r2BindingStorage`) remains tree-shaken out per docstring-only
// references.
//
// Budget is for the **unminified** ESM bundle (rolldown `minify: false`).
// Consumer bundlers run their own minify pass with the rest of the app;
// readable stacks in consumer error reports are worth the wire size here.
const BUNDLE_BUDGET_BYTES = 174 * 1024;

describe("bundle size", () => {
  test("dist/index.js stays under bundle budget", () => {
    const distPath = resolve(__dirname, "../../dist/index.js");
    if (!existsSync(distPath)) {
      throw new Error(`dist/index.js missing — run \`pnpm build\` before \`pnpm test\``);
    }
    const size = statSync(distPath).size;
    expect(size).toBeLessThan(BUNDLE_BUDGET_BYTES);
  });
});
