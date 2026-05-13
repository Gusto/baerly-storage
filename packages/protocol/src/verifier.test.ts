import { describe, expectTypeOf, it } from "vitest";
import type { Verifier, VerifierResult } from "./verifier.ts";

describe("Verifier interface", () => {
  it("accepts an async function returning a result", () => {
    const v: Verifier = async (req) => {
      expectTypeOf(req).toEqualTypeOf<Request>();
      return { tenantPrefix: "t", identity: { sub: "u" } };
    };
    expectTypeOf(v).toMatchTypeOf<Verifier>();
  });

  it("accepts an async function returning null", () => {
    const v: Verifier = async () => null;
    expectTypeOf(v).toMatchTypeOf<Verifier>();
  });

  it("VerifierResult.identity is unknown — narrow before reading", () => {
    const r: VerifierResult = { tenantPrefix: "t", identity: { sub: "u" } };
    expectTypeOf(r.identity).toEqualTypeOf<unknown>();
  });
});
