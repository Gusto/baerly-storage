import { describe, expect, test } from "vitest";
import { FIXTURES, SUBJECT_FIXTURES } from "./src/cells.ts";
import { buildFixture } from "./src/common.ts";

// `pnpm bench:cpu-factor:build` runs only on the owner's deploy path, so a
// seeding regression (a write the capacity check refuses) would otherwise
// surface there first.
describe("cpu-factor fixtures build under the current kernel", () => {
  for (const [name, spec] of Object.entries({ ...FIXTURES, ...SUBJECT_FIXTURES })) {
    test(name, { timeout: 60_000 }, async () => {
      const fx = await buildFixture(spec);
      expect(fx.rows).toBe(spec.rows);
      expect(fx.bytes).toBeGreaterThan(spec.rows * spec.payload);
    });
  }
});
