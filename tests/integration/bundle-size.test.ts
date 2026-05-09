import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

// ADR-0001 motivates the vendorless choice on bundle weight; this test
// pins the size so a regression shows up immediately. Phase 1 relocates
// Tier 3 / IDB code out of the server bundle and should DROP this
// number; tighten the budget then.
const BUNDLE_BUDGET_BYTES = 36 * 1024;

describe("bundle size", () => {
    test("dist/index.js stays under bundle budget", () => {
        const distPath = resolve(__dirname, "../../dist/index.js");
        if (!existsSync(distPath)) {
            throw new Error(
                `dist/index.js missing — run \`pnpm build\` before \`pnpm test\``,
            );
        }
        const size = statSync(distPath).size;
        expect(size).toBeLessThan(BUNDLE_BUDGET_BYTES);
    });
});
