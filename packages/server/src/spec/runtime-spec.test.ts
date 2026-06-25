import { describe, expect, test, vi } from "vitest";
import type { BaerlyConfig, Verifier } from "@baerly/protocol";
import { expectValidAgainstIrSchema } from "../../../../tests/fixtures/ir-schema.ts";
import { buildSpecResponse, handleSpecRequest } from "./runtime-spec.ts";

describe("buildSpecResponse", () => {
  test("anonymous: static IR only, no collections field", () => {
    const res = buildSpecResponse();
    expect(res.specVersion).toBe("1");
    expect(res.errorCodes.length).toBe(14);
    expect("collections" in res).toBe(false);
    expectValidAgainstIrSchema(res);
  });

  test("authed: appends declared collection names + index names", () => {
    const config: BaerlyConfig = {
      collections: {
        notes: { indexes: [{ name: "by_author", on: ["author"] }] },
        tasks: {},
      },
    };
    const res = buildSpecResponse(config);
    expect(res.collections).toBeDefined();
    const notes = res.collections?.find((c) => c.name === "notes");
    expect(notes?.indexes).toEqual(["by_author"]);
    // A collection with no `indexes` property falls back to an empty array.
    expect(res.collections?.find((c) => c.name === "tasks")?.indexes).toEqual([]);
    expect(res.collections?.map((c) => c.name).toSorted()).toEqual(["notes", "tasks"]);
    expectValidAgainstIrSchema(res);
  });

  test("authed: reports schema vendor when a schema is declared", () => {
    const config: BaerlyConfig = {
      collections: {
        notes: {
          schema: {
            "~standard": { version: 1, vendor: "zod", validate: () => ({ value: {} }) },
          } as never,
        },
      },
    };
    const res = buildSpecResponse(config);
    expect(res.collections?.find((c) => c.name === "notes")?.schemaVendor).toBe("zod");
  });

  test("authed: reports both index names and schema vendor when both are declared", () => {
    const config: BaerlyConfig = {
      collections: {
        notes: {
          indexes: [{ name: "by_author", on: ["author"] }],
          schema: {
            "~standard": { version: 1, vendor: "zod", validate: () => ({ value: {} }) },
          } as never,
        },
      },
    };
    const notes = buildSpecResponse(config).collections?.find((c) => c.name === "notes");
    expect(notes?.indexes).toEqual(["by_author"]);
    expect(notes?.schemaVendor).toBe("zod");
  });
});

describe("handleSpecRequest", () => {
  const req = () => new Request("http://localhost/v1/spec");
  const accept: Verifier = async () => ({ tenantPrefix: "acme", identity: {} });
  const deny: Verifier = async () => null;

  test("identity accepted: appends the declared collections", async () => {
    const config: BaerlyConfig = { collections: { notes: {}, tasks: {} } };
    const res = await handleSpecRequest(req(), async () => ({ verifier: accept, config }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { collections?: Array<{ name: string }> };
    expect(body.collections?.map((c) => c.name).toSorted()).toEqual(["notes", "tasks"]);
  });

  test("verifier denies (null): serves the anonymous IR, no collections", async () => {
    const config: BaerlyConfig = { collections: { notes: {} } };
    const res = await handleSpecRequest(req(), async () => ({ verifier: deny, config }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect("collections" in body).toBe(false);
  });

  test("resolve() throws: stays 200 with the anonymous IR and warns without leaking the error object", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The error carries credential-shaped material in a field; only its
      // message should ever reach the log line.
      const boom = Object.assign(new Error("JWKS endpoint unreachable"), {
        token: "super-secret-bearer-token",
      });
      const res = await handleSpecRequest(req(), async () => {
        throw boom;
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect("collections" in body).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      const line = warn.mock.calls[0]?.join(" ") ?? "";
      expect(line).toContain("JWKS endpoint unreachable");
      expect(line).not.toContain("super-secret-bearer-token");
    } finally {
      warn.mockRestore();
    }
  });
});
