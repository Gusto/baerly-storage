// Two gated suites whose environment is never ready: a host-capability gate
// (sqlite) and a credentialed one (credentials file missing).
import { describe, test } from "vitest";
import { gate } from "../../setup/gates.ts";

describe.runIf(gate("sqlite", false))("sqlite suite", () => {
  test("never runs", () => {});
});

describe.runIf(gate("conformance-aws", false))("aws conformance suite", () => {
  test("never runs", () => {});
});
