import { describe, expect, test } from "vitest";

import { AUTH_CONFIG_VALUES } from "./constants.ts";

describe("AuthConfig", () => {
  test("AUTH_CONFIG_VALUES is the locked union ['none', 'shared-secret']", () => {
    // Locked so the resolution-order code in the adapter, doctor, and
    // the AuthConfig type alias stay in sync. A new posture requires a
    // deliberate edit to every consumer.
    expect(AUTH_CONFIG_VALUES).toEqual(["none", "shared-secret"]);
  });
});
