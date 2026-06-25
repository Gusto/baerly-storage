import { describe, expect, test } from "vitest";
import { CLIENT_RUNTIME_CODES, ERROR_CODES, PREDICATE_OPS } from "@baerly/protocol";
import { expectValidAgainstIrSchema } from "../../../../tests/fixtures/ir-schema.ts";
import { buildSpecIR } from "./ir.ts";

describe("buildSpecIR", () => {
  const ir = buildSpecIR();

  test("validates against ir-schema.json", () => {
    expectValidAgainstIrSchema(ir);
  });

  test("lists every BaerlyErrorCode with its httpStatus + retriable flag", () => {
    const codes = ir.errorCodes.map((e) => e.code).toSorted();
    expect(codes).toEqual([...ERROR_CODES].toSorted());
    const conflict = ir.errorCodes.find((e) => e.code === "Conflict");
    expect(conflict?.httpStatus).toBe(409);
    expect(conflict?.retriable).toBe(true);
    expect(ir.errorCodes.find((e) => e.code === "NetworkError")?.httpStatus).toBe(502);
    expect(ir.errorCodes.find((e) => e.code === "NetworkError")?.retriable).toBe(true);
    expect(ir.errorCodes.find((e) => e.code === "InvalidResponse")?.httpStatus).toBe(502);
    expect(ir.errorCodes.find((e) => e.code === "UnsatisfiablePredicate")?.httpStatus).toBe(400);

    // Client-runtime-only codes never travel HTTP → null, not a fabricated 500.
    const nullHttpStatusCodes = ir.errorCodes
      .filter((e) => e.httpStatus === null)
      .map((e) => e.code)
      .toSorted();
    expect(nullHttpStatusCodes).toEqual([...CLIENT_RUNTIME_CODES].toSorted());
  });

  test("declares the full by-id CRUD surface, not just the collection routes", () => {
    const routes = new Set(ir.httpRoutes.map((r) => `${r.method} ${r.path}`));
    for (const route of [
      "GET /v1/c/:collection/:id",
      "PATCH /v1/c/:collection/:id",
      "PUT /v1/c/:collection/:id",
      "DELETE /v1/c/:collection/:id",
    ]) {
      expect(routes.has(route)).toBe(true);
    }
  });

  test("lists every PREDICATE_OPS member", () => {
    expect(ir.operators.map((o) => o.name).toSorted()).toEqual([...PREDICATE_OPS].toSorted());
  });

  test("kernelVersion matches the root package version", () => {
    expect(ir.kernelVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("declares the /v1 routes including the new /v1/spec", () => {
    const paths = ir.httpRoutes.map((r) => r.path);
    expect(paths).toContain("/v1/spec");
    expect(paths).toContain("/v1/healthz");
    const spec = ir.httpRoutes.find((r) => r.path === "/v1/spec");
    expect(spec?.auth).toBe("anonymous");
  });
});
