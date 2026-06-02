import { describe, expect, test } from "vitest";

import { AUTH_CONFIG_VALUES } from "./constants.ts";
import { defineConfig } from "./app-config.ts";

describe("AuthConfig", () => {
  test("AUTH_CONFIG_VALUES is the locked union ['none', 'shared-secret']", () => {
    // Locked so the resolution-order code in the adapter, doctor, and
    // the AuthConfig type alias stay in sync. A new posture requires a
    // deliberate edit to every consumer.
    expect(AUTH_CONFIG_VALUES).toEqual(["none", "shared-secret"]);
  });
});

describe("defineConfig", () => {
  test("returns the input config unchanged", () => {
    // defineConfig is a pass-through type identity function. The function body
    // must return `cfg`, not implicitly return undefined. If the return statement
    // is removed (BlockStatement mutant), this test will fail.
    const config = { collections: { notes: {} } };
    const result = defineConfig(config);
    expect(result).toBe(config);
  });
});
